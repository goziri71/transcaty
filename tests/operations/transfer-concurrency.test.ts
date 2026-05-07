/**
 * Integration test: transferToCustomer must not allow overdraft under
 * concurrent calls. Requires a reachable Postgres; skipped otherwise.
 *
 * Seeds a merchant wallet at 200.00 and a customer wallet at 0. Fires 10
 * parallel transfers of 30.00 each. Expectations:
 *   - exactly six transfers succeed (200 / 30 = 6 with 20 left over);
 *   - the four other transfers reject with "Insufficient balance";
 *   - the merchant + customer balances sum back to the original 200.00.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

const skip =
  !process.env.DATABASE_URL &&
  !(process.env.DATABASE_URL_ENC && process.env.ENCRYPTION_MASTER_KEY);

test("transferToCustomer does not overdraft under concurrent calls", { skip }, async () => {
  const { db } = await import("../../src/db/index.js");
  const { transferToCustomer } = await import(
    "../../services/operations/transfers.js"
  );
  const { merchants, wallets, transactions, ledgerEntries } = await import(
    "../../src/db/schema/index.js"
  );

  const [merchant] = await db
    .insert(merchants)
    .values({
      name: `test-transfer-${randomUUID().slice(0, 8)}`,
      status: "active",
      kycStatus: "verified",
    })
    .returning();
  assert.ok(merchant);

  const [merchantWallet] = await db
    .insert(wallets)
    .values({
      merchantId: merchant.id,
      type: "merchant",
      environment: "test",
      balance: "200.00",
      currency: "BDT",
      status: "active",
    })
    .returning();
  assert.ok(merchantWallet);

  const [customerWallet] = await db
    .insert(wallets)
    .values({
      merchantId: merchant.id,
      type: "customer",
      environment: "test",
      parentId: merchantWallet.id,
      balance: "0.00",
      currency: "BDT",
      status: "active",
    })
    .returning();
  assert.ok(customerWallet);

  const createdTxIds: string[] = [];

  try {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        transferToCustomer({
          merchantId: merchant.id,
          customerWalletId: customerWallet.id,
          environment: "test",
          amount: "30.00",
          reason: "concurrency test",
        })
      )
    );

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    for (const r of succeeded) {
      if (r.status === "fulfilled" && r.value?.id) createdTxIds.push(r.value.id);
    }

    assert.equal(succeeded.length, 6, `expected 6 successes, got ${succeeded.length}`);
    assert.equal(rejected.length, 4, `expected 4 rejections, got ${rejected.length}`);
    for (const r of rejected) {
      if (r.status === "rejected") {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        assert.match(msg, /Insufficient balance/);
      }
    }

    const [m] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.id, merchantWallet.id))
      .limit(1);
    const [c] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.id, customerWallet.id))
      .limit(1);

    // 6 * 30 = 180 transferred, merchant: 200 - 180 = 20, customer: 0 + 180 = 180.
    assert.equal(m?.balance, "20.00");
    assert.equal(c?.balance, "180.00");

    // Ledger conservation: sum of debits == sum of credits == 180.
    const debitRows = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.walletId, merchantWallet.id));
    const creditRows = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.walletId, customerWallet.id));
    const sum = (rows: typeof debitRows) =>
      rows.reduce((acc, r) => acc + Math.round(Number(r.amount) * 100), 0);
    assert.equal(sum(debitRows), 18000);
    assert.equal(sum(creditRows), 18000);
  } finally {
    if (createdTxIds.length > 0) {
      await db.delete(ledgerEntries).where(inArray(ledgerEntries.referenceId, createdTxIds));
      await db.delete(transactions).where(inArray(transactions.id, createdTxIds));
    }
    await db.delete(wallets).where(eq(wallets.id, customerWallet.id));
    await db.delete(wallets).where(eq(wallets.id, merchantWallet.id));
    await db.delete(merchants).where(eq(merchants.id, merchant.id));
  }
});
