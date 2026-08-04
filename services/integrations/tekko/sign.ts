/**
 * Tekko Platform Ed25519 request signing.
 * Canonical string (5 lines, joined by \\n, no trailing newline after line 5 content):
 *   {timestamp}\\n{METHOD}\\n{path}\\n{sha256_hex(rawBody)}\\n{idempotencyKeyOrEmpty}
 */
import { createHash, sign as cryptoSign } from "node:crypto";

export const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function sha256Hex(rawBody: string): string {
  if (rawBody.length === 0) return EMPTY_BODY_SHA256;
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

export function buildTekkoCanonicalString(params: {
  timestamp: string;
  method: string;
  path: string;
  rawBody: string;
  idempotencyKey?: string;
}): string {
  const bodyHash = sha256Hex(params.rawBody);
  const idem = params.idempotencyKey ?? "";
  return `${params.timestamp}\n${params.method.toUpperCase()}\n${params.path}\n${bodyHash}\n${idem}`;
}

export function signTekkoCanonicalString(
  canonical: string,
  privateKeyPem: string
): string {
  return cryptoSign(null, Buffer.from(canonical, "utf8"), privateKeyPem).toString("base64url");
}

export function signTekkoPlatformRequest(params: {
  method: string;
  path: string;
  rawBody?: string;
  idempotencyKey?: string;
  privateKeyPem: string;
  keyId: string;
  /** Override clock for tests. */
  timestampMs?: number;
}): { timestamp: string; signature: string; keyId: string; canonical: string } {
  const timestamp = String(params.timestampMs ?? Date.now());
  const rawBody = params.rawBody ?? "";
  const idempotencyKey =
    params.method.toUpperCase() === "GET" ? "" : (params.idempotencyKey ?? "");
  const canonical = buildTekkoCanonicalString({
    timestamp,
    method: params.method,
    path: params.path,
    rawBody,
    idempotencyKey,
  });
  const signature = signTekkoCanonicalString(canonical, params.privateKeyPem);
  return { timestamp, signature, keyId: params.keyId, canonical };
}
