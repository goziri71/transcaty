import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/**
 * Get a 32-byte key from ENCRYPTION_MASTER_KEY.
 * If the key is 64 hex chars, use directly. Otherwise derive with scrypt.
 */
function getKey(masterKey: string): Buffer {
  if (masterKey.length === 64 && /^[0-9a-fA-F]+$/.test(masterKey)) {
    return Buffer.from(masterKey, "hex");
  }
  const salt = Buffer.from(masterKey.slice(0, SALT_LENGTH).padEnd(SALT_LENGTH, "0"));
  return scryptSync(masterKey, salt, KEY_LENGTH);
}

/**
 * Encrypt a plaintext string. Returns format: iv:authTag:ciphertext (all hex).
 */
export function encrypt(plaintext: string, masterKey: string): string {
  const key = getKey(masterKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(":");
}

/**
 * Decrypt a string encrypted with encrypt(). Expects format: iv:authTag:ciphertext.
 */
export function decrypt(encryptedValue: string, masterKey: string): string {
  const parts = encryptedValue.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted format. Expected iv:authTag:ciphertext");
  }

  const [ivHex, authTagHex, cipherHex] = parts;
  const key = getKey(masterKey);
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);

  decipher.setAuthTag(authTag);

  return decipher.update(cipherHex, "hex", "utf8") + decipher.final("utf8");
}

/**
 * Ensure SSL is enabled for remote DB connections (Render, Neon, etc.).
 * Uses verify-full for strict certificate validation (pg v9+ recommendation).
 */
export function ensureDbSsl(url: string): string {
  if (url.includes("sslmode=")) return url;
  if (url.includes("localhost") || url.includes("127.0.0.1")) return url;
  const ssl = "sslmode=verify-full";
  return url.includes("?") ? `${url}&${ssl}` : `${url}?${ssl}`;
}

/**
 * Get a value: use plain if available, otherwise decrypt encrypted value.
 */
export function getSecret(plainKey: string, encryptedKey: string): string | undefined {
  const plain = process.env[plainKey];
  if (plain) return plain;

  const encrypted = process.env[encryptedKey];
  const masterKey = process.env.ENCRYPTION_MASTER_KEY;

  if (!encrypted || !masterKey) return undefined;

  try {
    return decrypt(encrypted.trim(), masterKey.trim());
  } catch (err) {
    throw new Error(
      `Failed to decrypt ${encryptedKey}: ${err instanceof Error ? err.message : String(err)}. ` +
        "Check ENCRYPTION_MASTER_KEY matches the key used to encrypt, and DATABASE_URL_ENC has no extra whitespace."
    );
  }
}
