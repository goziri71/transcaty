/**
 * TOTP (RFC 6238) for MFA using otplib v13. Secrets stored encrypted at rest.
 */
import { generateSecret, generateURI, verifySync } from "otplib";
import { encrypt, decrypt } from "./encryption.js";

export function getMasterKeyForMfa(): string {
  const k = process.env.ENCRYPTION_MASTER_KEY?.trim();
  if (!k) {
    throw new Error("ENCRYPTION_MASTER_KEY is required for MFA (encrypting TOTP secrets)");
  }
  return k;
}

export function generateTotpSecret(): string {
  return generateSecret();
}

export function buildKeyUri(params: {
  email: string;
  issuer: string;
  secret: string;
}): string {
  return generateURI({
    issuer: params.issuer,
    label: params.email,
    secret: params.secret,
  });
}

export function verifyTotp(secret: string, token: string): boolean {
  const cleaned = token.replace(/\s/g, "");
  try {
    const result = verifySync({ secret, token: cleaned });
    return result.valid === true;
  } catch {
    return false;
  }
}

export function encryptTotpSecret(secret: string): string {
  return encrypt(secret, getMasterKeyForMfa());
}

export function decryptTotpSecret(enc: string): string {
  return decrypt(enc, getMasterKeyForMfa());
}
