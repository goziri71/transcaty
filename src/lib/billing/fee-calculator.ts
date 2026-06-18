import type { FeeScheduleRow } from "./fee-rail.js";

export type TransactionFeeType = "payin" | "payout";

/**
 * Compute transaction fee from a fee schedule row.
 * Returns fee amount as decimal string in the transaction settlement currency.
 */
export function computeFeeFromSchedule(
  schedule: FeeScheduleRow,
  amount: string,
  feeType: TransactionFeeType
): { feeAmount: string; feePercentage: string; scheduleId: string } | null {
  void feeType;
  if (schedule.billingMode === "monthly_only") {
    return null;
  }

  const pct = (schedule.feePercentage && Number(schedule.feePercentage)) || 0;
  const flat = (schedule.feeFlat && Number(schedule.feeFlat)) || 0;

  if (pct <= 0 && flat <= 0) {
    return null;
  }

  const amt = Number(amount);
  if (amt <= 0 || !Number.isFinite(amt)) {
    return null;
  }

  let fee = flat + (amt * pct) / 100;

  const min = schedule.feeMin ? Number(schedule.feeMin) : 0;
  const maxRaw = schedule.feeMax;
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
    scheduleId: schedule.id,
  };
}

/** @deprecated Use computeFeeFromSchedule via resolveFeeSchedule. */
export function computeTransactionFee(
  pricing: {
    billingMode: string;
    feePercentagePayin: string | null;
    feePercentagePayout: string | null;
    feeMinPayin: string | null;
    feeMaxPayin: string | null;
    feeMinPayout: string | null;
    feeMaxPayout: string | null;
  },
  amount: string,
  feeType: TransactionFeeType
): { feeAmount: string; feePercentage: string } | null {
  const schedule: FeeScheduleRow = {
    id: "legacy",
    billingMode: pricing.billingMode,
    feePercentage: feeType === "payin" ? pricing.feePercentagePayin : pricing.feePercentagePayout,
    feeFlat: "0",
    feeMin: feeType === "payin" ? pricing.feeMinPayin : pricing.feeMinPayout,
    feeMax: feeType === "payin" ? pricing.feeMaxPayin : pricing.feeMaxPayout,
  };
  const computed = computeFeeFromSchedule(schedule, amount, feeType);
  if (!computed) return null;
  return { feeAmount: computed.feeAmount, feePercentage: computed.feePercentage };
}
