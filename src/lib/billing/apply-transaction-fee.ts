import { getMerchantPricing } from "./pricing.js";
import { computeTransactionFee, type TransactionFeeType } from "./fee-calculator.js";
import { applyTransactionFee, type DbTx } from "./fee-applier.js";
import { toCents } from "../money.js";

export interface TryApplyTransactionFeeInput {
  merchantId: string;
  transactionId: string;
  environment: "test" | "live";
  amount: string;
  feeType: TransactionFeeType;
}

/**
 * Get merchant pricing, compute fee, and apply if applicable.
 * No-op when: no pricing, monthly_only mode, zero fee, or insufficient balance.
 *
 * Pass `parentTx` when the caller is already inside a `db.transaction` so the
 * fee posting commits or rolls back atomically with the parent operation.
 */
export async function tryApplyTransactionFee(
  input: TryApplyTransactionFeeInput,
  parentTx?: DbTx
): Promise<{ applied: boolean; feeAmount?: string }> {
  const { merchantId, transactionId, environment, amount, feeType } = input;

  const pricing = await getMerchantPricing(merchantId);
  if (!pricing) {
    return { applied: false };
  }

  const computed = computeTransactionFee(pricing, amount, feeType);
  if (!computed || toCents(computed.feeAmount) <= 0n) {
    return { applied: false };
  }

  const applied = await applyTransactionFee(
    {
      merchantId,
      transactionId,
      environment,
      amount,
      feeAmount: computed.feeAmount,
      feeType,
    },
    parentTx
  );

  return applied
    ? { applied: true, feeAmount: computed.feeAmount }
    : { applied: false };
}
