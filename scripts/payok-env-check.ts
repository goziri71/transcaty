#!/usr/bin/env npx tsx
/**
 * Check which Payok env vars are loaded (names only, no values).
 * Usage: npx tsx scripts/payok-env-check.ts
 */
import "dotenv/config";

const PAYOK_KEYS = [
  "PAYOK_MERCHANT_ID",
  "PAYOK_MERCHANT_ID_ENC",
  "PAYOK_MERCHANT_PRI_KEY",
  "PAYOK_MERCHANT_PRI_KEY_ENC",
  "PAYOK_MERCHANT_PRIVATE_KEY_ENC",
  "PAYOK_BASE_URL",
  "PAYOK_BASE_URL_ENC",
  "PAYOK_PLATFORM_PUB_KEY",
  "PAYOK_PLATFORM_PUB_KEY_ENC",
  "ENCRYPTION_MASTER_KEY",
];

console.log("Payok env check (present = ✓, missing = ✗):\n");
for (const key of PAYOK_KEYS) {
  const val = process.env[key];
  const set = val !== undefined && val !== "";
  console.log(`  ${set ? "✓" : "✗"} ${key}`);
}
console.log("\nExpected for encrypted: PAYOK_*_ENC + ENCRYPTION_MASTER_KEY");
console.log("Expected for plain: PAYOK_MERCHANT_ID, PAYOK_MERCHANT_PRI_KEY, PAYOK_BASE_URL, PAYOK_PLATFORM_PUB_KEY");
