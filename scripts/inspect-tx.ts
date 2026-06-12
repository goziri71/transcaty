#!/usr/bin/env npx tsx
import "dotenv/config";
import { eq, and } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { transactions, wallets, ledgerEntries } from "../src/db/schema/index.js";

const txId = process.argv[2]?.trim();
if (!txId) {
  console.error("Usage: npx tsx scripts/inspect-tx.ts <transactionId>");
  process.exit(1);
}

const [tx] = await db.select().from(transactions).where(eq(transactions.id, txId)).limit(1);
console.log(
  "TX:",
  tx
    ? {
        id: tx.id,
        status: tx.status,
        amount: tx.amount,
        currency: tx.currency,
        paidAmount: tx.paidAmount,
        externalId: tx.externalId,
        merchantId: tx.merchantId,
        env: tx.environment,
      }
    : null
);

if (tx) {
  const ws = await db
    .select({ id: wallets.id, currency: wallets.currency, balance: wallets.balance })
    .from(wallets)
    .where(
      and(
        eq(wallets.merchantId, tx.merchantId),
        eq(wallets.environment, tx.environment),
        eq(wallets.type, "merchant")
      )
    );
  console.log("Wallets:", ws);

  const le = await db
    .select({
      walletId: ledgerEntries.walletId,
      amount: ledgerEntries.amount,
      type: ledgerEntries.type,
      direction: ledgerEntries.direction,
    })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.referenceId, txId));
  console.log("Ledger for tx:", le);
}
