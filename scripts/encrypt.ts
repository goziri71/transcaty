#!/usr/bin/env npx tsx
/**
 * Encrypt a secret value for storage.
 * Usage: ENCRYPTION_MASTER_KEY=your_key npx tsx scripts/encrypt.ts "value to encrypt"
 *
 * Generate a key: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
import { config } from "dotenv";
config();

import { encrypt } from "../src/lib/encryption.js";

const value = process.argv[2];
const masterKey = process.env.ENCRYPTION_MASTER_KEY;

if (!value) {
  console.error("Usage: ENCRYPTION_MASTER_KEY=your_key npx tsx scripts/encrypt.ts \"value to encrypt\"");
  process.exit(1);
}

if (!masterKey) {
  console.error("Error: ENCRYPTION_MASTER_KEY must be set in env or .env");
  process.exit(1);
}

try {
  const encrypted = encrypt(value, masterKey);
  console.log("\nEncrypted value (use in .env as DATABASE_URL_ENC=...):\n");
  console.log(encrypted);
  console.log("");
} catch (err) {
  console.error("Encryption failed:", err);
  process.exit(1);
}
