import { getMerchantPricing } from "./pricing.js";
import { computeTransactionFee, type TransactionFeeType } from "./fee-calculator.js";
import { applyTransactionFee } from "./fee-applier.js";

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
 */
export async function tryApplyTransactionFee(
  input: TryApplyTransactionFeeInput
): Promise<{ applied: boolean; feeAmount?: string }> {
  const { merchantId, transactionId, environment, amount, feeType } = input;

  const pricing = await getMerchantPricing(merchantId);
  if (!pricing) {
    return { applied: false };
  }

  const computed = computeTransactionFee(pricing, amount, feeType);
  if (!computed || Number(computed.feeAmount) <= 0) {
    return { applied: false };
  }

  const applied = await applyTransactionFee({
    merchantId,
    transactionId,
    environment,
    amount,
    feeAmount: computed.feeAmount,
    feeType,
  });

  return applied
    ? { applied: true, feeAmount: computed.feeAmount }
    : { applied: false };
}
