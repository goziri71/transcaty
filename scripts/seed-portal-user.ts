#!/usr/bin/env npx tsx
/**
 * Create a test merchant + portal user for dashboard login.
 * Usage: npx tsx scripts/seed-portal-user.ts
 *
 * Creates: merchant (pending), merchant_user (email + password), wallet.
 * Use POST /portal/auth/login with the email/password below.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { merchantPricing, merchants, merchantUsers, wallets } from "../src/db/schema/index.js";
import { hashPassword } from "../src/lib/portal-auth.js";

const EMAIL = "merchant@example.com";
const PASSWORD = "password123";

async function main() {
  const [existing] = await db
    .select({ id: merchantUsers.id })
    .from(merchantUsers)
    .where(eq(merchantUsers.email, EMAIL))
    .limit(1);

  if (existing) {
    console.log("\nPortal user already exists:", EMAIL);
    console.log("Use POST /portal/auth/login with email and password.\n");
    return;
  }

  const passwordHash = await hashPassword(PASSWORD);

  const [merchant] = await db
    .insert(merchants)
    .values({
      name: "Example Merchant",
      status: "pending",
      kycStatus: "pending",
    })
    .returning({ id: merchants.id });

  if (!merchant) {
    console.error("Failed to create merchant");
    process.exit(1);
  }

  await db.insert(merchantUsers).values({
    merchantId: merchant.id,
    email: EMAIL,
    passwordHash,
    role: "admin",
  });

  await db.insert(wallets).values({
    merchantId: merchant.id,
    type: "merchant",
    balance: "0",
    currency: "BDT",
    status: "active",
  });

  await db.insert(merchantPricing).values({
    merchantId: merchant.id,
    billingMode: "percentage_only",
    feePercentagePayin: "3",
    feePercentagePayout: "2",
    feeMinPayin: "0",
    feeMinPayout: "0",
  });

  console.log("\nPortal user created:\n");
  console.log("  Email:", EMAIL);
  console.log("  Password:", PASSWORD);
  console.log("\nLogin: POST /portal/auth/login");
  console.log("  Body: { \"email\": \"" + EMAIL + "\", \"password\": \"" + PASSWORD + "\" }");
  console.log("\nSet PORTAL_JWT_SECRET in .env for portal auth.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
