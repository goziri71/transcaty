import { computeFeeFromSchedule, type TransactionFeeType } from "./fee-calculator.js";
import { applyTransactionFee, type DbTx } from "./fee-applier.js";
import { resolveFeeSchedule } from "./fee-schedules.js";
import { toCents } from "../money.js";

export interface TryApplyTransactionFeeInput {
  merchantId: string;
  transactionId: string;
  environment: "test" | "live";
  currency: string;
  provider?: string | null;
  amount: string;
  feeType: TransactionFeeType;
}

/**
 * Resolve fee schedule, compute fee, and apply if applicable.
 * Pass `parentTx` when already inside a db.transaction.
 */
export async function tryApplyTransactionFee(
  input: TryApplyTransactionFeeInput,
  parentTx?: DbTx
): Promise<{ applied: boolean; feeAmount?: string }> {
  const { merchantId, transactionId, environment, currency, provider, amount, feeType } = input;

  const schedule = await resolveFeeSchedule({
    merchantId,
    environment,
    currency,
    feeType,
    provider,
  });
  if (!schedule) {
    return { applied: false };
  }

  const computed = computeFeeFromSchedule(schedule, amount, feeType);
  if (!computed || toCents(computed.feeAmount) <= 0n) {
    return { applied: false };
  }

  const applied = await applyTransactionFee(
    {
      merchantId,
      transactionId,
      environment,
      currency,
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
