import type { MerchantPricingRow } from "./pricing.js";

export type TransactionFeeType = "payin" | "payout";

/**
 * Compute transaction fee based on merchant pricing.
 * Returns fee amount in BDT (string for decimal precision).
 */
export function computeTransactionFee(
  pricing: MerchantPricingRow,
  amount: string,
  feeType: TransactionFeeType
): { feeAmount: string; feePercentage: string } | null {
  if (pricing.billingMode === "monthly_only") {
    return null;
  }

  const pct =
    feeType === "payin"
      ? (pricing.feePercentagePayin && Number(pricing.feePercentagePayin)) || 0
      : (pricing.feePercentagePayout && Number(pricing.feePercentagePayout)) || 0;

  if (pct <= 0) {
    return null;
  }

  const amt = Number(amount);
  if (amt <= 0 || !Number.isFinite(amt)) {
    return null;
  }

  let fee = (amt * pct) / 100;

  const min =
    feeType === "payin"
      ? (pricing.feeMinPayin ? Number(pricing.feeMinPayin) : 0)
      : (pricing.feeMinPayout ? Number(pricing.feeMinPayout) : 0);
  const maxRaw =
    feeType === "payin" ? pricing.feeMaxPayin : pricing.feeMaxPayout;
  const max = maxRaw ? Number(maxRaw) : undefined;

  if (min > 0 && fee < min) {
    fee = min;
  }
  if (max !== undefined && Number.isFinite(max) && max > 0 && fee > max) {
    fee = max;
  }

  return {
    feeAmount: fee.toFixed(2),
    feePercentage: pct.toFixed(4),
  };
}
