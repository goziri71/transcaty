/**
 * Integration test: the partial unique index on
 * (provider, environment, external_id) blocks duplicate transaction
 * rows from being created for the same provider order id. NULL provider
 * or NULL external_id falls outside the partial index and is allowed.
 *
 * Skipped when no DATABASE_URL is configured.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

const skip =
  !process.env.DATABASE_URL &&
  !(process.env.DATABASE_URL_ENC && process.env.ENCRYPTION_MASTER_KEY);

test(
  "transactions(provider, environment, external_id) partial unique index",
  { skip },
  async () => {
    const { db } = await import("../../src/db/index.js");
    const { merchants, transactions } = await import("../../src/db/schema/index.js");
    const { eq } = await import("drizzle-orm");

    const [merchant] = await db
      .insert(merchants)
      .values({
        name: `test-prov-${randomUUID().slice(0, 8)}`,
        status: "active",
        kycStatus: "verified",
      })
      .returning();
    assert.ok(merchant);
    const merchantId = merchant.id;

    const externalId = `ext-${randomUUID()}`;

    try {
      const [first] = await db
        .insert(transactions)
        .values({
          merchantId,
          environment: "test",
          type: "payin",
          status: "pending",
          amount: "1.00",
          currency: "BDT",
          provider: "payok-bd-payin",
          externalId,
        })
        .returning();
      assert.ok(first);

      // Same (provider, environment, external_id) → must violate the
      // partial unique index.
      await assert.rejects(
        db.insert(transactions).values({
          merchantId,
          environment: "test",
          type: "payin",
          status: "pending",
          amount: "1.00",
          currency: "BDT",
          provider: "payok-bd-payin",
          externalId,
        }),
        /(unique|duplicate)/i
      );

      // Same external id under a different provider must be allowed.
      const [second] = await db
        .insert(transactions)
        .values({
          merchantId,
          environment: "test",
          type: "payin",
          status: "pending",
          amount: "1.00",
          currency: "USDT",
          provider: "tylt-cpg-payin",
          externalId,
        })
        .returning();
      assert.ok(second);

      // Same provider + external id but different environment must be allowed.
      const [third] = await db
        .insert(transactions)
        .values({
          merchantId,
          environment: "live",
          type: "payin",
          status: "pending",
          amount: "1.00",
          currency: "BDT",
          provider: "payok-bd-payin",
          externalId,
        })
        .returning();
      assert.ok(third);

      // NULL external id (not yet returned by provider) must be allowed
      // multiple times.
      const inserts = await Promise.all([
        db
          .insert(transactions)
          .values({
            merchantId,
            environment: "test",
            type: "payin",
            status: "pending",
            amount: "1.00",
            currency: "BDT",
            provider: "payok-bd-payin",
          })
          .returning(),
        db
          .insert(transactions)
          .values({
            merchantId,
            environment: "test",
            type: "payin",
            status: "pending",
            amount: "1.00",
            currency: "BDT",
            provider: "payok-bd-payin",
          })
          .returning(),
      ]);
      assert.equal(inserts.length, 2);
    } finally {
      await db.delete(transactions).where(eq(transactions.merchantId, merchantId));
      await db.delete(merchants).where(eq(merchants.id, merchantId));
    }
  }
);
