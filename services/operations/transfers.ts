/**
 * Merchant operations: create customer wallet, transfer, refund.
 * Double-entry ledger: debit merchant, credit customer.
 */
import { eq, and } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { wallets, ledgerEntries, transactions } from "../../src/db/schema/index.js";

export async function createCustomerWallet(params: {
  merchantId: string;
  label?: string;
}) {
  const [merchantWallet] = await db
    .select()
    .from(wallets)
    .where(
      and(
        eq(wallets.merchantId, params.merchantId),
        eq(wallets.type, "merchant"),
        eq(wallets.status, "active")
      )
    )
    .limit(1);

  if (!merchantWallet) {
    throw new Error("Merchant wallet not found");
  }

  const [customer] = await db
    .insert(wallets)
    .values({
      merchantId: params.merchantId,
      type: "customer",
      parentId: merchantWallet.id,
      label: params.label ?? null,
      balance: "0",
      currency: "BDT",
      status: "active",
    })
    .returning();

  if (!customer) throw new Error("Failed to create customer wallet");
  return customer;
}

export async function transferToCustomer(params: {
  merchantId: string;
  customerWalletId: string;
  amount: string;
  reason?: string;
}) {
  const amount = parseFloat(params.amount);
  if (amount <= 0 || isNaN(amount)) {
    throw new Error("Invalid amount");
  }

  const [merchantWallet] = await db
    .select()
    .from(wallets)
    .where(
      and(
        eq(wallets.merchantId, params.merchantId),
        eq(wallets.type, "merchant"),
        eq(wallets.status, "active")
      )
    )
    .limit(1);

  const [customerWallet] = await db
    .select()
    .from(wallets)
    .where(
      and(
        eq(wallets.id, params.customerWalletId),
        eq(wallets.merchantId, params.merchantId),
        eq(wallets.type, "customer")
      )
    )
    .limit(1);

  if (!merchantWallet || !customerWallet) {
    throw new Error("Wallet not found");
  }

  if (customerWallet.status !== "active") {
    throw new Error("Customer wallet is blocked or pending");
  }

  const merchantBalance = Number(merchantWallet.balance);
  if (merchantBalance < amount) {
    throw new Error("Insufficient balance");
  }

  const [tx] = await db
    .insert(transactions)
    .values({
      merchantId: params.merchantId,
      walletId: customerWallet.id,
      type: "transfer",
      status: "success",
      amount: params.amount,
      currency: "BDT",
      metadata: params.reason
        ? JSON.stringify({ reason: params.reason })
        : null,
    })
    .returning();

  if (!tx) throw new Error("Failed to create transaction");

  await db.insert(ledgerEntries).values([
    {
      walletId: merchantWallet.id,
      amount: params.amount,
      direction: "debit",
      type: "transfer",
      referenceId: tx.id,
    },
    {
      walletId: customerWallet.id,
      amount: params.amount,
      direction: "credit",
      type: "transfer",
      referenceId: tx.id,
    },
  ]);

  await db
    .update(wallets)
    .set({
      balance: String(merchantBalance - amount),
      updatedAt: new Date(),
    })
    .where(eq(wallets.id, merchantWallet.id));

  await db
    .update(wallets)
    .set({
      balance: String(Number(customerWallet.balance) + amount),
      updatedAt: new Date(),
    })
    .where(eq(wallets.id, customerWallet.id));

  return tx;
}

export async function refundToCustomer(params: {
  merchantId: string;
  customerWalletId: string;
  amount: string;
  refundOfTransactionId: string;
  reason?: string;
}) {
  const amount = parseFloat(params.amount);
  if (amount <= 0 || isNaN(amount)) {
    throw new Error("Invalid amount");
  }

  const [merchantWallet] = await db
    .select()
    .from(wallets)
    .where(
      and(
        eq(wallets.merchantId, params.merchantId),
        eq(wallets.type, "merchant"),
        eq(wallets.status, "active")
      )
    )
    .limit(1);

  const [customerWallet] = await db
    .select()
    .from(wallets)
    .where(
      and(
        eq(wallets.id, params.customerWalletId),
        eq(wallets.merchantId, params.merchantId),
        eq(wallets.type, "customer")
      )
    )
    .limit(1);

  if (!merchantWallet || !customerWallet) {
    throw new Error("Wallet not found");
  }

  if (customerWallet.status !== "active") {
    throw new Error("Customer wallet is blocked or pending");
  }

  const merchantBalance = Number(merchantWallet.balance);
  if (merchantBalance < amount) {
    throw new Error("Insufficient balance");
  }

  const metadata: Record<string, string> = {
    refundOfTransactionId: params.refundOfTransactionId,
  };
  if (params.reason) metadata.reason = params.reason;

  const [tx] = await db
    .insert(transactions)
    .values({
      merchantId: params.merchantId,
      walletId: customerWallet.id,
      type: "refund",
      status: "success",
      amount: params.amount,
      currency: "BDT",
      metadata: JSON.stringify(metadata),
    })
    .returning();

  if (!tx) throw new Error("Failed to create refund transaction");

  await db.insert(ledgerEntries).values([
    {
      walletId: merchantWallet.id,
      amount: params.amount,
      direction: "debit",
      type: "refund",
      referenceId: tx.id,
    },
    {
      walletId: customerWallet.id,
      amount: params.amount,
      direction: "credit",
      type: "refund",
      referenceId: tx.id,
    },
  ]);

  await db
    .update(wallets)
    .set({
      balance: String(merchantBalance - amount),
      updatedAt: new Date(),
    })
    .where(eq(wallets.id, merchantWallet.id));

  await db
    .update(wallets)
    .set({
      balance: String(Number(customerWallet.balance) + amount),
      updatedAt: new Date(),
    })
    .where(eq(wallets.id, customerWallet.id));

  return tx;
}
