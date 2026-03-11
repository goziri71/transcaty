/**
 * Merchant auth: HMAC-SHA256 request signing.
 * Headers: X-Transcaty-Key, X-Transcaty-Signature, X-Transcaty-Timestamp
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import { createHmac, createHash } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { merchantApiKeys } from "../db/schema/index.js";

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

function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function verifyHmac(payload: string, secret: string, signature: string): boolean {
  const expected = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return expected === signature;
}

/**
 * Verify merchant HMAC signature. Expects rawBody on request (set by preParsing).
 */
export async function merchantAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const key = request.headers["x-transcaty-key"] as string | undefined;
  const signature = request.headers["x-transcaty-signature"] as string | undefined;
  const timestamp = request.headers["x-transcaty-timestamp"] as string | undefined;

  if (!key || !signature || !timestamp) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Missing X-Transcaty-Key, X-Transcaty-Signature, or X-Transcaty-Timestamp",
    });
  }

  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Invalid X-Transcaty-Timestamp",
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

  const keyHash = hashKey(key);
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
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Invalid API key",
    });
  }

  const masterKey = process.env.ENCRYPTION_MASTER_KEY;
  let secret: string;
  try {
    if (!masterKey) throw new Error("ENCRYPTION_MASTER_KEY required");
    const { decrypt } = await import("./encryption.js");
    secret = decrypt(row.secretEnc.trim(), masterKey.trim());
  } catch {
    return reply.status(500).send({
      error: "Internal",
      message: "Key decryption failed",
    });
  }

  if (!verifyHmac(payload, secret, signature)) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Invalid signature",
    });
  }

  const scopes = row.scopes ? row.scopes.split(",").map((s) => s.trim()).filter(Boolean) : [];
  request.merchant = {
    merchantId: row.merchantId,
    keyId: row.id,
    scopes,
    environment: row.environment as "live" | "test",
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
