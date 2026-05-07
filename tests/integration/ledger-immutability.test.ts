/**
 * Integration test: ledger_entries is immutable.
 *
 * Verifies that the trigger created by drizzle/0017_ledger_immutability.sql
 * rejects UPDATE and DELETE on ledger_entries from a normal client
 * session. Skipped when no DATABASE_URL is configured.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

const skip =
  !process.env.DATABASE_URL &&
  !(process.env.DATABASE_URL_ENC && process.env.ENCRYPTION_MASTER_KEY);

test("ledger_entries rejects UPDATE", { skip }, async () => {
  const { db } = await import("../../src/db/index.js");
  const { merchants, wallets, ledgerEntries } = await import("../../src/db/schema/index.js");
  const { eq } = await import("drizzle-orm");

  const [merchant] = await db
    .insert(merchants)
    .values({
      name: `test-ledger-${randomUUID().slice(0, 8)}`,
      status: "active",
      kycStatus: "verified",
    })
    .returning();
  assert.ok(merchant);
  const [wallet] = await db
    .insert(wallets)
    .values({
      merchantId: merchant.id,
      type: "merchant",
      environment: "test",
      balance: "0.00",
      currency: "BDT",
      status: "active",
    })
    .returning();
  assert.ok(wallet);

  const [entry] = await db
    .insert(ledgerEntries)
    .values({
      walletId: wallet.id,
      environment: "test",
      amount: "1.00",
      direction: "credit",
      type: "test",
      referenceId: "test-ref",
    })
    .returning();
  assert.ok(entry);

  try {
    await assert.rejects(
      db.update(ledgerEntries).set({ type: "tampered" }).where(eq(ledgerEntries.id, entry.id)),
      /append-only/i
    );
    await assert.rejects(
      db.delete(ledgerEntries).where(eq(ledgerEntries.id, entry.id)),
      /append-only/i
    );
  } finally {
    const { sql } = await import("drizzle-orm");
    // Use the documented escape hatch to delete the test row, then take
    // down the wallet and merchant. SET LOCAL only lasts for the
    // session; we wrap in a single transaction.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_ledger_mutation = 'true'`);
      await tx.delete(ledgerEntries).where(eq(ledgerEntries.id, entry.id));
    });
    await db.delete(wallets).where(eq(wallets.id, wallet.id));
    await db.delete(merchants).where(eq(merchants.id, merchant.id));
  }
});
