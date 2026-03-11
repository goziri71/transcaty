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
function base64ToPem(base64: string): string {
  const cleaned = base64.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(cleaned)) {
    throw new Error("Invalid base64 for private key.");
  }
  const lines = cleaned.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}

/** Get PEM from value: already PEM, or raw base64 to convert. */
function toPem(value: string): string {
  const normalized = normalizePem(value);
  if (normalized.includes("-----BEGIN")) {
    return normalized;
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(normalized)) {
    return base64ToPem(normalized);
  }
  throw new Error("Private key must be PEM or base64. Got neither.");
}

/**
 * Sign a request body for Payok.
 * @param jsonBody - JSON string of the request body
 * @param endpointPath - e.g. /api-pay/remit/V3.5/balance/query
 * @param privateKeyPem - RSA private key in PEM format (PKCS#1 or PKCS#8)
 * @returns Base64 signature for the sign header
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
 * @param jsonBody - Raw request body string (as received)
 * @param endpointPath - The path Payok used (e.g. our webhook path)
 * @param signatureBase64 - Value from sign header
 * @param publicKeyPem - Payok platform public key in PEM format
 * @returns true if signature is valid
 */
export function verifyPayokCallback(
  jsonBody: string,
  endpointPath: string,
  signatureBase64: string,
  publicKeyPem: string
): boolean {
  const plaintext = `${jsonBody}&${endpointPath}`;
  const verify = createVerify("RSA-SHA256");
  verify.update(plaintext, "utf8");
  return verify.verify(publicKeyPem, signatureBase64, "base64");
}
