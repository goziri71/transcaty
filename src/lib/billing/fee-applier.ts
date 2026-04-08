import { db } from "../../db/index.js";
import { ledgerEntries, wallets } from "../../db/schema/index.js";
import { and, eq } from "drizzle-orm";
import { PLATFORM_WALLET_ID } from "./platform-wallet.js";
import { audit } from "../audit.js";
import type { TransactionFeeType } from "./fee-calculator.js";

export interface ApplyFeeInput {
  merchantId: string;
  transactionId: string;
  environment: "test" | "live";
  amount: string;
  feeAmount: string;
  feeType: TransactionFeeType;
}

/**
 * Apply transaction fee: debit merchant wallet, credit platform wallet.
 * Skips if merchant has insufficient balance (logs audit, no throw).
 */
export async function applyTransactionFee(input: ApplyFeeInput): Promise<boolean> {
  const { merchantId, transactionId, environment, amount, feeAmount, feeType } = input;

  const fee = Number(feeAmount);
  if (fee <= 0 || !Number.isFinite(fee)) {
    return false;
  }

  const [merchantWallet] = await db
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

  const balance = Number(merchantWallet.balance);
  if (balance < fee) {
    audit({
      action: "billing.fee_skipped",
      resource: transactionId,
      merchantId,
      meta: {
        reason: "insufficient_balance",
        feeType,
        feeAmount,
        balance: String(balance),
      },
    });
    return false;
  }

  await db.transaction(async (tx) => {
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
        walletId: PLATFORM_WALLET_ID,
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
        balance: String(balance - fee),
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, merchantWallet.id));

    const [plat] = await tx
      .select({ balance: wallets.balance })
      .from(wallets)
      .where(eq(wallets.id, PLATFORM_WALLET_ID))
      .limit(1);
    const platBalance = plat ? Number(plat.balance) : 0;
    await tx
      .update(wallets)
      .set({
        balance: String(platBalance + fee),
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, PLATFORM_WALLET_ID));
  });

  audit({
    action: "billing.fee_applied",
    resource: transactionId,
    merchantId,
    meta: { feeType, amount: String(amount), feeAmount },
  });

  return true;
}
