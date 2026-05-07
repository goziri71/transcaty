/**
 * Merchant operations: create customer wallet, transfer, refund.
 * Double-entry ledger: debit merchant, credit customer.
 *
 * Concurrency model: every monetary mutation runs inside `db.transaction` and
 * locks both participating wallets with `SELECT ... FOR UPDATE`. To avoid
 * deadlocks under cross-direction concurrent operations, we acquire locks in
 * a deterministic order based on `wallet.id`.
 */
import { eq, and, asc, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { wallets, ledgerEntries, transactions } from "../../src/db/schema/index.js";
import { addAmount, assertPositive, cmpAmount, subAmount } from "../../src/lib/money.js";

export async function createCustomerWallet(params: {
  merchantId: string;
  environment?: "test" | "live";
  label?: string;
}) {
  const environment = params.environment ?? "test";
  const [merchantWallet] = await db
    .select()
    .from(wallets)
    .where(
      and(
        eq(wallets.merchantId, params.merchantId),
        eq(wallets.environment, environment),
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
      environment,
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
  environment?: "test" | "live";
  amount: string;
  reason?: string;
}) {
  const environment = params.environment ?? "test";
  assertPositive(params.amount);

  return db.transaction(async (txDb) => {
    // Resolve both wallet ids first (without lock) so we can acquire FOR UPDATE
    // in deterministic id order to prevent deadlocks under concurrent operations.
    const [merchantWalletRef] = await txDb
      .select({ id: wallets.id })
      .from(wallets)
      .where(
        and(
          eq(wallets.merchantId, params.merchantId),
          eq(wallets.environment, environment),
          eq(wallets.type, "merchant"),
          eq(wallets.status, "active")
        )
      )
      .limit(1);

    const [customerWalletRef] = await txDb
      .select({ id: wallets.id })
      .from(wallets)
      .where(
        and(
          eq(wallets.id, params.customerWalletId),
          eq(wallets.merchantId, params.merchantId),
          eq(wallets.environment, environment),
          eq(wallets.type, "customer")
        )
      )
      .limit(1);

    if (!merchantWalletRef || !customerWalletRef) {
      throw new Error("Wallet not found");
    }

    const ids = [merchantWalletRef.id, customerWalletRef.id].sort();
    const locked = await txDb
      .select()
      .from(wallets)
      .where(inArray(wallets.id, ids))
      .for("update")
      .orderBy(asc(wallets.id));

    const merchantWallet = locked.find((w) => w.id === merchantWalletRef.id);
    const customerWallet = locked.find((w) => w.id === customerWalletRef.id);

    if (!merchantWallet || !customerWallet) {
      throw new Error("Wallet not found");
    }

    if (customerWallet.status !== "active") {
      throw new Error("Customer wallet is blocked or pending");
    }

    if (cmpAmount(merchantWallet.balance, params.amount) < 0) {
      throw new Error("Insufficient balance");
    }

    const [tx] = await txDb
      .insert(transactions)
      .values({
        merchantId: params.merchantId,
        walletId: customerWallet.id,
        environment,
        type: "transfer",
        status: "success",
        amount: params.amount,
        currency: "BDT",
        provider: "internal-transfer",
        metadata: params.reason
          ? JSON.stringify({ reason: params.reason })
          : null,
      })
      .returning();

    if (!tx) throw new Error("Failed to create transaction");

    await txDb.insert(ledgerEntries).values([
      {
        walletId: merchantWallet.id,
        environment,
        amount: params.amount,
        direction: "debit",
        type: "transfer",
        referenceId: tx.id,
      },
      {
        walletId: customerWallet.id,
        environment,
        amount: params.amount,
        direction: "credit",
        type: "transfer",
        referenceId: tx.id,
      },
    ]);

    await txDb
      .update(wallets)
      .set({
        balance: subAmount(merchantWallet.balance, params.amount),
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, merchantWallet.id));

    await txDb
      .update(wallets)
      .set({
        balance: addAmount(customerWallet.balance, params.amount),
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, customerWallet.id));

    return tx;
  });
}

export async function refundToCustomer(params: {
  merchantId: string;
  customerWalletId: string;
  environment?: "test" | "live";
  amount: string;
  refundOfTransactionId: string;
  reason?: string;
}) {
  const environment = params.environment ?? "test";
  assertPositive(params.amount);

  return db.transaction(async (txDb) => {
    const [merchantWalletRef] = await txDb
      .select({ id: wallets.id })
      .from(wallets)
      .where(
        and(
          eq(wallets.merchantId, params.merchantId),
          eq(wallets.environment, environment),
          eq(wallets.type, "merchant"),
          eq(wallets.status, "active")
        )
      )
      .limit(1);

    const [customerWalletRef] = await txDb
      .select({ id: wallets.id })
      .from(wallets)
      .where(
        and(
          eq(wallets.id, params.customerWalletId),
          eq(wallets.merchantId, params.merchantId),
          eq(wallets.environment, environment),
          eq(wallets.type, "customer")
        )
      )
      .limit(1);

    if (!merchantWalletRef || !customerWalletRef) {
      throw new Error("Wallet not found");
    }

    const ids = [merchantWalletRef.id, customerWalletRef.id].sort();
    const locked = await txDb
      .select()
      .from(wallets)
      .where(inArray(wallets.id, ids))
      .for("update")
      .orderBy(asc(wallets.id));

    const merchantWallet = locked.find((w) => w.id === merchantWalletRef.id);
    const customerWallet = locked.find((w) => w.id === customerWalletRef.id);

    if (!merchantWallet || !customerWallet) {
      throw new Error("Wallet not found");
    }

    if (customerWallet.status !== "active") {
      throw new Error("Customer wallet is blocked or pending");
    }

    if (cmpAmount(merchantWallet.balance, params.amount) < 0) {
      throw new Error("Insufficient balance");
    }

    const metadata: Record<string, string> = {
      refundOfTransactionId: params.refundOfTransactionId,
    };
    if (params.reason) metadata.reason = params.reason;

    const [tx] = await txDb
      .insert(transactions)
      .values({
        merchantId: params.merchantId,
        walletId: customerWallet.id,
        environment,
        type: "refund",
        status: "success",
        amount: params.amount,
        currency: "BDT",
        provider: "internal-refund",
        metadata: JSON.stringify(metadata),
      })
      .returning();

    if (!tx) throw new Error("Failed to create refund transaction");

    await txDb.insert(ledgerEntries).values([
      {
        walletId: merchantWallet.id,
        environment,
        amount: params.amount,
        direction: "debit",
        type: "refund",
        referenceId: tx.id,
      },
      {
        walletId: customerWallet.id,
        environment,
        amount: params.amount,
        direction: "credit",
        type: "refund",
        referenceId: tx.id,
      },
    ]);

    await txDb
      .update(wallets)
      .set({
        balance: subAmount(merchantWallet.balance, params.amount),
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, merchantWallet.id));

    await txDb
      .update(wallets)
      .set({
        balance: addAmount(customerWallet.balance, params.amount),
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, customerWallet.id));

    return tx;
  });
}
