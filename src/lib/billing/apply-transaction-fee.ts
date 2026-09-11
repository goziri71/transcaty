import { and, eq } from "drizzle-orm";
import { ledgerEntries } from "../../db/schema/index.js";
import { addAmount, toCents } from "../money.js";
import { computeFeeFromSchedule, type TransactionFeeType } from "./fee-calculator.js";
import { applyTransactionFee, type DbTx } from "./fee-applier.js";
import { resolveFeeSchedule } from "./fee-schedules.js";
import type { FeeScheduleRow } from "./fee-rail.js";

export interface TryApplyTransactionFeeInput {
  merchantId: string;
  transactionId: string;
  environment: "test" | "live";
  currency: string;
  provider?: string | null;
  amount: string;
  feeType: TransactionFeeType;
}

export type TransactionFeePreviewInput = Omit<TryApplyTransactionFeeInput, "transactionId"> & {
  transactionId?: string;
};

export function transactionFeeReferenceId(transactionId: string, feeType: TransactionFeeType): string {
  return `fee:${transactionId}:${feeType}`;
}

export function feeAmountFromSchedule(
  schedule: FeeScheduleRow | null,
  amount: string,
  feeType: TransactionFeeType
): string | null {
  if (!schedule) return null;
  const computed = computeFeeFromSchedule(schedule, amount, feeType);
  if (!computed || toCents(computed.feeAmount) <= 0n) return null;
  return computed.feeAmount;
}

async function computeTransactionFeeAmount(input: TransactionFeePreviewInput): Promise<string | null> {
  const schedule = await resolveFeeSchedule({
    merchantId: input.merchantId,
    environment: input.environment,
    currency: input.currency,
    feeType: input.feeType,
    provider: input.provider,
  });
  return feeAmountFromSchedule(schedule, input.amount, input.feeType);
}

/** Resolve configured fee for a payout/payin amount (no ledger write). */
export async function previewTransactionFee(input: TransactionFeePreviewInput): Promise<string | null> {
  return computeTransactionFeeAmount(input);
}

/**
 * Payout debit + Transacty platform fee + optional provider/rail fee.
 * Used to validate wallet balance before create and for API totalWalletDebit.
 */
export function payoutTotalWalletDebit(
  payoutAmount: string,
  feeAmount: string | null,
  providerFeeAmount?: string | null
): string {
  let total = feeAmount ? addAmount(payoutAmount, feeAmount) : payoutAmount;
  if (providerFeeAmount) {
    try {
      const pf = providerFeeAmount.trim();
      if (pf && pf !== "0" && pf !== "0.00") {
        total = addAmount(total, pf);
      }
    } catch {
      /* ignore malformed provider fee */
    }
  }
  return total;
}

export async function hasTransactionFeeApplied(
  transactionId: string,
  feeType: TransactionFeeType,
  txDb: DbTx
): Promise<boolean> {
  const refId = transactionFeeReferenceId(transactionId, feeType);
  const [row] = await txDb
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.referenceId, refId),
        eq(ledgerEntries.type, "platform_fee"),
        eq(ledgerEntries.direction, "debit")
      )
    )
    .limit(1);
  return !!row;
}

/**
 * Resolve fee schedule, compute fee, and apply if applicable.
 * Pass `parentTx` when already inside a db.transaction.
 */
export async function tryApplyTransactionFee(
  input: TryApplyTransactionFeeInput,
  parentTx?: DbTx
): Promise<{ applied: boolean; feeAmount?: string }> {
  const feeAmount = await computeTransactionFeeAmount(input);
  if (!feeAmount) {
    return { applied: false };
  }

  const applied = await applyTransactionFee(
    {
      merchantId: input.merchantId,
      transactionId: input.transactionId,
      environment: input.environment,
      currency: input.currency,
      amount: input.amount,
      feeAmount,
      feeType: input.feeType,
    },
    parentTx
  );

  return applied ? { applied: true, feeAmount } : { applied: false };
}

/** Idempotent payout fee collection (success webhook or retry). */
export async function ensurePayoutFeeCollected(
  input: TryApplyTransactionFeeInput,
  txDb: DbTx
): Promise<{ applied: boolean; feeAmount?: string }> {
  if (await hasTransactionFeeApplied(input.transactionId, input.feeType, txDb)) {
    return { applied: true };
  }
  return tryApplyTransactionFee(input, txDb);
}
