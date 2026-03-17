/**
 * Payok signature: SHA256WithRSA, Base64.
 * Plaintext = {json_body}&{endpoint_path}
 */
import { createSign, createVerify } from "node:crypto";

/** Normalize PEM: ensure Unix line endings, trim. */
function normalizePem(pem: string): string {
  return pem.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

/** Convert raw base64 (no PEM headers) to PEM format. */
function base64ToPem(base64: string, type: "private" | "public" = "private"): string {
  const cleaned = base64.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(cleaned)) {
    throw new Error(`Invalid base64 for ${type} key.`);
  }
  const lines = cleaned.match(/.{1,64}/g) ?? [];
  const header = type === "public" ? "-----BEGIN PUBLIC KEY-----" : "-----BEGIN PRIVATE KEY-----";
  const footer = type === "public" ? "-----END PUBLIC KEY-----" : "-----END PRIVATE KEY-----";
  return `${header}\n${lines.join("\n")}\n${footer}`;
}

function toPublicPem(value: string): string {
  const normalized = normalizePem(value);
  if (normalized.includes("-----BEGIN PUBLIC KEY-----")) return normalized;
  if (/^[A-Za-z0-9+/=\s]+$/.test(normalized)) return base64ToPem(normalized, "public");
  throw new Error("Public key must be PEM or base64.");
}

/** Get PEM from value: already PEM, or raw base64 to convert. */
function toPem(value: string): string {
  const normalized = normalizePem(value);
  if (normalized.includes("-----BEGIN")) {
    return normalized;
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(normalized)) {
    return base64ToPem(normalized, "private");
  }
  throw new Error("Private key must be PEM or base64. Got neither.");
}

/**
 * Sign a request body for Payok.
 */
export function signPayokRequest(
  jsonBody: string,
  endpointPath: string,
  privateKeyInput: string
): string {
  const pem = toPem(privateKeyInput);
  const plaintext = `${jsonBody}&${endpointPath}`;
  const sign = createSign("RSA-SHA256");
  sign.update(plaintext, "utf8");
  try {
    return sign.sign(pem, "base64");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("DECODER") || msg.includes("unsupported")) {
      throw new Error(
        "Private key format not supported. Ensure the key is PEM (-----BEGIN PRIVATE KEY----- or -----BEGIN RSA PRIVATE KEY-----). " +
          "If Payok gave a .p12/.pfx file, extract the PEM first. " +
          "Original: " + msg
      );
    }
    throw err;
  }
}

/**
 * Verify a callback signature from Payok.
 * Doc: Plaintext = {json_body}&{endpoint_path}
 */
function verifyWithPlaintext(
  plaintext: string,
  signatureBase64: string,
  publicKeyInput: string
): boolean {
  const pem = toPublicPem(publicKeyInput);
  const verify = createVerify("RSA-SHA256");
  verify.update(plaintext, "utf8");
  return verify.verify(pem, signatureBase64, "base64");
}

export function verifyPayokCallback(
  jsonBody: string,
  endpointPath: string,
  signatureBase64: string,
  publicKeyInput: string
): boolean {
  return verifyWithPlaintext(`${jsonBody}&${endpointPath}`, signatureBase64, publicKeyInput);
}

/**
 * Verify callback signature. Tries multiple path formats and both plaintext orders.
 * Doc: Plaintext = {json_body}&{endpoint_path} — some implementations use path&body.
 */
export function verifyPayokCallbackWithFallbacks(
  jsonBody: string,
  pathCandidates: string[],
  signatureBase64: string,
  publicKeyInput: string
): boolean {
  for (const path of pathCandidates) {
    if (verifyWithPlaintext(`${jsonBody}&${path}`, signatureBase64, publicKeyInput)) return true;
    if (verifyWithPlaintext(`${path}&${jsonBody}`, signatureBase64, publicKeyInput)) return true;
  }
  return false;
}
