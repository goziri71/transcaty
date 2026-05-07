import { db } from "../../db/index.js";
import { ledgerEntries, wallets } from "../../db/schema/index.js";
import { and, eq } from "drizzle-orm";
import { PLATFORM_WALLET_ID } from "./platform-wallet.js";
import { audit } from "../audit.js";
import { addAmount, cmpAmount, subAmount, toCents } from "../money.js";
import type { TransactionFeeType } from "./fee-calculator.js";

export interface ApplyFeeInput {
  merchantId: string;
  transactionId: string;
  environment: "test" | "live";
  amount: string;
  feeAmount: string;
  feeType: TransactionFeeType;
}

/** Internal alias for an executor that supports the same query API as `db`. */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function applyFeeWithTx(tx: DbTx, input: ApplyFeeInput): Promise<boolean> {
  const { merchantId, transactionId, environment, amount, feeAmount, feeType } = input;

  if (toCents(feeAmount) <= 0n) {
    return false;
  }

  const [merchantWallet] = await tx
    .select()
    .from(wallets)
    .where(
      and(
        eq(wallets.merchantId, merchantId),
        eq(wallets.environment, environment),
        eq(wallets.type, "merchant"),
        eq(wallets.status, "active")
      )
    )
    .for("update")
    .limit(1);

  if (!merchantWallet) {
    audit({
      action: "billing.fee_skipped",
      resource: transactionId,
      merchantId,
      meta: { reason: "merchant_wallet_not_found", feeType, feeAmount },
    });
    return false;
  }

  if (cmpAmount(merchantWallet.balance, feeAmount) < 0) {
    audit({
      action: "billing.fee_skipped",
      resource: transactionId,
      merchantId,
      meta: {
        reason: "insufficient_balance",
        feeType,
        feeAmount,
        balance: merchantWallet.balance,
      },
    });
    return false;
  }

  const [platformWallet] = await tx
    .select({ id: wallets.id, balance: wallets.balance })
    .from(wallets)
    .where(eq(wallets.id, PLATFORM_WALLET_ID))
    .for("update")
    .limit(1);

  if (!platformWallet) {
    audit({
      action: "billing.fee_skipped",
      resource: transactionId,
      merchantId,
      meta: { reason: "platform_wallet_not_found", feeType, feeAmount },
    });
    return false;
  }

  const refId = `fee:${transactionId}:${feeType}`;

  await tx.insert(ledgerEntries).values([
    {
      walletId: merchantWallet.id,
      environment,
      amount: feeAmount,
      direction: "debit",
      type: "platform_fee",
      referenceId: refId,
    },
    {
      walletId: platformWallet.id,
      environment,
      amount: feeAmount,
      direction: "credit",
      type: "platform_fee",
      referenceId: refId,
    },
  ]);

  await tx
    .update(wallets)
    .set({
      balance: subAmount(merchantWallet.balance, feeAmount),
      updatedAt: new Date(),
    })
    .where(eq(wallets.id, merchantWallet.id));

  await tx
    .update(wallets)
    .set({
      balance: addAmount(platformWallet.balance, feeAmount),
      updatedAt: new Date(),
    })
    .where(eq(wallets.id, platformWallet.id));

  audit({
    action: "billing.fee_applied",
    resource: transactionId,
    merchantId,
    meta: { feeType, amount, feeAmount },
  });

  return true;
}

/**
 * Apply transaction fee: debit merchant wallet, credit platform wallet.
 * Skips (no throw, audit-logged) on missing wallet or insufficient balance.
 *
 * Pass `parentTx` when the caller is already inside a `db.transaction` so the
 * fee shares the same atomic boundary as the parent operation; otherwise this
 * opens its own transaction.
 */
export async function applyTransactionFee(
  input: ApplyFeeInput,
  parentTx?: DbTx
): Promise<boolean> {
  if (parentTx) {
    return applyFeeWithTx(parentTx, input);
  }
  return db.transaction((tx) => applyFeeWithTx(tx, input));
}
