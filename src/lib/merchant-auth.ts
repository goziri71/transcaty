/**
 * Merchant auth: HMAC-SHA256 request signing.
 * Headers: X-Transacty-Key, X-Transacty-Signature, X-Transacty-Timestamp
 *
 * Hot-path note: we cache the decrypted HMAC secret + merchant context in
 * a small per-process TTL cache so repeat callers do not re-pay the
 * `merchant_api_keys` lookup + AES-256-GCM decrypt on every request. The
 * cache must be invalidated whenever a key row is revoked or rotated.
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { merchantApiKeys } from "../db/schema/index.js";
import {
  getMerchantKeyCache,
  setMerchantKeyCacheHit,
  setMerchantKeyCacheMiss,
  type MerchantKeyCacheValue,
} from "./merchant-key-cache.js";

const REPLAY_WINDOW_SEC = 5 * 60; // ±5 minutes

export type MerchantContext = {
  merchantId: string;
  keyId: string;
  scopes: string[];
  environment: "live" | "test";
};

declare module "fastify" {
  interface FastifyRequest {
    merchant?: MerchantContext;
  }
}

export function hashMerchantApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function verifyHmac(payload: string, secret: string, signature: string): boolean {
  const expected = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  if (typeof signature !== "string" || expected.length !== signature.length) {
    return false;
  }
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function merchantHmacHeaderPresent(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function loadMerchantKey(keyHash: string): Promise<MerchantKeyCacheValue | null> {
  const cached = getMerchantKeyCache(keyHash);
  if (cached?.kind === "hit") return cached.value;
  if (cached?.kind === "miss") return null;

  const [row] = await db
    .select({
      id: merchantApiKeys.id,
      merchantId: merchantApiKeys.merchantId,
      secretEnc: merchantApiKeys.secretEnc,
      scopes: merchantApiKeys.scopes,
      environment: merchantApiKeys.environment,
    })
    .from(merchantApiKeys)
    .where(
      and(
        eq(merchantApiKeys.keyHash, keyHash),
        eq(merchantApiKeys.status, "active")
      )
    )
    .limit(1);

  if (!row) {
    setMerchantKeyCacheMiss(keyHash);
    return null;
  }

  const masterKey = process.env.ENCRYPTION_MASTER_KEY;
  if (!masterKey) {
    // Don't cache configuration errors — they should surface to ops on
    // every attempt and not be hidden behind a TTL.
    throw new Error("ENCRYPTION_MASTER_KEY required");
  }
  const { decrypt } = await import("./encryption.js");
  const secret = decrypt(row.secretEnc.trim(), masterKey.trim());

  const value: MerchantKeyCacheValue = {
    keyId: row.id,
    merchantId: row.merchantId,
    scopes: row.scopes
      ? row.scopes.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
    environment: row.environment as "live" | "test",
    secret,
  };
  setMerchantKeyCacheHit(keyHash, value);
  return value;
}

/**
 * Verify merchant HMAC signature. Expects rawBody on request (set by preParsing).
 */
export async function merchantAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const key = request.headers["x-transacty-key"] as string | undefined;
  const signature = request.headers["x-transacty-signature"] as string | undefined;
  const timestamp = request.headers["x-transacty-timestamp"] as string | undefined;

  if (!merchantHmacHeaderPresent(key) || !merchantHmacHeaderPresent(signature) || !merchantHmacHeaderPresent(timestamp)) {
    const missing: string[] = [];
    if (!merchantHmacHeaderPresent(key)) missing.push("X-Transacty-Key");
    if (!merchantHmacHeaderPresent(timestamp)) missing.push("X-Transacty-Timestamp");
    if (!merchantHmacHeaderPresent(signature)) missing.push("X-Transacty-Signature");
    return reply.status(401).send({
      error: "Unauthorized",
      message: `HMAC headers missing or empty: ${missing.join(", ")}. Send all three with non-empty values (see docs: signing payload is "{X-Transacty-Timestamp}.{rawRequestBody}"; for GET with no body use "timestamp." including the trailing dot).`,
      missingHeaders: missing,
    });
  }

  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Invalid X-Transacty-Timestamp",
    });
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > REPLAY_WINDOW_SEC) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Request timestamp expired (replay protection)",
    });
  }

  const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? "";
  const payload = `${timestamp}.${rawBody}`;

  const keyHash = hashMerchantApiKey(key);
  let entry: MerchantKeyCacheValue | null;
  try {
    entry = await loadMerchantKey(keyHash);
  } catch {
    return reply.status(500).send({
      error: "Internal",
      message: "Key decryption failed",
    });
  }

  if (!entry) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Invalid API key",
    });
  }

  if (!verifyHmac(payload, entry.secret, signature)) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Invalid signature",
    });
  }

  request.merchant = {
    merchantId: entry.merchantId,
    keyId: entry.keyId,
    scopes: entry.scopes.slice(),
    environment: entry.environment,
  };
}

/** Check if merchant has required scope. Call after merchantAuth. */
export function requireScope(scope: string) {
  return (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const m = request.merchant;
    if (!m) {
      reply.status(401).send({ error: "Unauthorized", message: "Not authenticated" });
      return;
    }
    if (!m.scopes.includes(scope) && !m.scopes.includes("*")) {
      reply.status(403).send({ error: "Forbidden", message: `Missing scope: ${scope}` });
      return;
    }
    done();
  };
}
