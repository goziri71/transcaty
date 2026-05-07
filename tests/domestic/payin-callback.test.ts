/**
 * Integration test: handlePayinCallback must be idempotent under duplicate
 * provider callbacks. Requires a reachable Postgres (DATABASE_URL or
 * DATABASE_URL_ENC + ENCRYPTION_MASTER_KEY); skipped otherwise.
 *
 * The test seeds an isolated merchant + wallet + pending pay-in, then fires
 * two success callbacks in parallel. Expectations:
 *   - exactly one ledger row of type 'payin' with referenceId = tx.id;
 *   - the wallet balance reflects exactly one credit;
 *   - the second invocation returns null (no duplicate event).
 */
import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

const skip =
  !process.env.DATABASE_URL &&
  !(process.env.DATABASE_URL_ENC && process.env.ENCRYPTION_MASTER_KEY);

test("handlePayinCallback is idempotent across duplicate callbacks", { skip }, async () => {
  const { db } = await import("../../src/db/index.js");
  const { handlePayinCallback } = await import(
    "../../services/domestic/bangladesh/payin.js"
  );
  const {
    merchants,
    wallets,
    transactions,
    ledgerEntries,
  } = await import("../../src/db/schema/index.js");

  const [merchant] = await db
    .insert(merchants)
    .values({
      name: `test-payin-${randomUUID().slice(0, 8)}`,
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
      balance: "100.00",
      currency: "BDT",
      status: "active",
    })
    .returning();
  assert.ok(wallet);

  const [tx] = await db
    .insert(transactions)
    .values({
      merchantId: merchant.id,
      environment: "test",
      type: "payin",
      status: "pending",
      amount: "50.00",
      currency: "BDT",
    })
    .returning();
  assert.ok(tx);

  try {
    const callback = {
      code: "SUCCESS",
      status: "SUCCESS",
      merchantOrderId: tx.id,
      paidAmount: "50.00",
    };

    const [a, b] = await Promise.all([
      handlePayinCallback(callback),
      handlePayinCallback(callback),
    ]);

    // Exactly one of the two invocations should have produced a result.
    const winners = [a, b].filter((r) => r !== null);
    assert.equal(winners.length, 1, "expected exactly one invocation to succeed");

    const ledgerRows = await db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.walletId, wallet.id),
          eq(ledgerEntries.referenceId, tx.id),
          eq(ledgerEntries.type, "payin")
        )
      );
    assert.equal(ledgerRows.length, 1, "expected exactly one ledger entry");

    const [refreshed] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.id, wallet.id))
      .limit(1);
    assert.equal(refreshed?.balance, "150.00");

    // Third call after both finished must also be a no-op.
    const after = await handlePayinCallback(callback);
    assert.equal(after, null);
  } finally {
    await db.delete(ledgerEntries).where(eq(ledgerEntries.referenceId, tx.id));
    await db.delete(transactions).where(eq(transactions.id, tx.id));
    await db.delete(wallets).where(eq(wallets.id, wallet.id));
    await db.delete(merchants).where(eq(merchants.id, merchant.id));
  }
});

test("handlePayinCallback marks transaction failed when provider reports failure", { skip }, async () => {
  const { db } = await import("../../src/db/index.js");
  const { handlePayinCallback } = await import(
    "../../services/domestic/bangladesh/payin.js"
  );
  const { merchants, wallets, transactions, ledgerEntries } = await import(
    "../../src/db/schema/index.js"
  );

  const [merchant] = await db
    .insert(merchants)
    .values({
      name: `test-payin-fail-${randomUUID().slice(0, 8)}`,
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
      balance: "100.00",
      currency: "BDT",
      status: "active",
    })
    .returning();
  assert.ok(wallet);

  const [tx] = await db
    .insert(transactions)
    .values({
      merchantId: merchant.id,
      environment: "test",
      type: "payin",
      status: "pending",
      amount: "25.00",
      currency: "BDT",
    })
    .returning();
  assert.ok(tx);

  try {
    const result = await handlePayinCallback({
      code: "FAIL",
      status: "FAIL",
      merchantOrderId: tx.id,
    });
    assert.ok(result);
    assert.equal(result?.event.type, "payin.failed");

    const [refreshed] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.id, wallet.id))
      .limit(1);
    assert.equal(refreshed?.balance, "100.00", "balance must not change on failure");

    const [updatedTx] = await db
      .select()
      .from(transactions)
      .where(eq(transactions.id, tx.id))
      .limit(1);
    assert.equal(updatedTx?.status, "failed");
  } finally {
    await db.delete(ledgerEntries).where(eq(ledgerEntries.referenceId, tx.id));
    await db.delete(transactions).where(eq(transactions.id, tx.id));
    await db.delete(wallets).where(eq(wallets.id, wallet.id));
    await db.delete(merchants).where(eq(merchants.id, merchant.id));
  }
});
