import { createHmac, timingSafeEqual } from "node:crypto";

/** Recursively sort object keys so GET signing does not depend on insertion order. */
export function sortKeysRecursive(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeysRecursive);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    out[k] = sortKeysRecursive(obj[k]);
  }
  return out;
}

/**
 * Payload string to sign for GET requests (docs: sign JSON of params used for query).
 * Empty params → `{}` (same as signing compact empty object).
 */
export function canonicalPayloadForTyltGet(params: Record<string, unknown>): string {
  if (!params || Object.keys(params).length === 0) return "{}";
  return JSON.stringify(sortKeysRecursive(params));
}

/** HMAC-SHA256 hex digest of raw body (POST), matching integration policy in docs. */
export function createTyltSignature(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

function hexTimingEqual(a: string, b: string): boolean {
  const aa = a.trim().toLowerCase();
  const bb = b.trim().toLowerCase();
  if (!/^[0-9a-f]+$/i.test(aa) || !/^[0-9a-f]+$/i.test(bb) || aa.length !== bb.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(aa, "hex"), Buffer.from(bb, "hex"));
  } catch {
    return false;
  }
}

/** Constant-time compare when header is hex; otherwise direct compare of UTF-8 bytes. */
export function verifyTyltSignature(secret: string, rawBody: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.trim()) return false;
  const expected = createTyltSignature(secret, rawBody);
  const got = signatureHeader.trim();
  if (hexTimingEqual(got, expected)) return true;
  try {
    return timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}
