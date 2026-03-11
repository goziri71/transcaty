#!/usr/bin/env npx tsx
/**
 * Create a test merchant and API key.
 * Usage: npx tsx scripts/seed-merchant.ts
 */
import "dotenv/config";
import { randomBytes, createHash, createHmac } from "node:crypto";
import { db } from "../src/db/index.js";
import { merchants, merchantApiKeys, wallets } from "../src/db/schema/index.js";
import { encrypt } from "../src/lib/encryption.js";

const masterKey = process.env.ENCRYPTION_MASTER_KEY;
if (!masterKey) {
  console.error("ENCRYPTION_MASTER_KEY required");
  process.exit(1);
}

function generateKey(): string {
  return "transcaty_test_" + randomBytes(24).toString("hex");
}

function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

async function main() {
  const [merchant] = await db
    .insert(merchants)
    .values({
      name: "Test Merchant",
      status: "active",
      kycStatus: "verified",
    })
    .returning({ id: merchants.id });

  if (!merchant) {
    console.error("Failed to create merchant");
    process.exit(1);
  }

  const apiKey = generateKey();
  const secret = generateSecret();
  const keyHash = hashKey(apiKey);
  const secretEnc = encrypt(secret, masterKey);

  await db.insert(merchantApiKeys).values({
    merchantId: merchant.id,
    keyHash,
    secretEnc,
    environment: "test",
    scopes: "payin:create,payout:create,balance:read,*",
    status: "active",
  });

  await db.insert(wallets).values({
    merchantId: merchant.id,
    type: "merchant",
    balance: "0",
    currency: "BDT",
    status: "active",
  });

  console.log("\nTest merchant created:\n");
  console.log("  Merchant ID:", merchant.id);
  console.log("  API Key:", apiKey);
  console.log("  Secret:", secret);
  console.log("\nTo sign requests: HMAC-SHA256(timestamp + '.' + body, secret)");
  console.log("Headers: X-Transcaty-Key, X-Transcaty-Signature, X-Transcaty-Timestamp");
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
