import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { ledgerEntries } from "../../db/schema/index.js";
import { cmpAmount, subAmount } from "../money.js";
import type { TransactionFeeType } from "./fee-calculator.js";
import {
  feeAmountFromSchedule,
  payoutTotalWalletDebit,
  previewTransactionFee,
  transactionFeeReferenceId,
  type TransactionFeePreviewInput,
} from "./apply-transaction-fee.js";
import { feeScheduleCacheKey, resolveFeeSchedulesBatch } from "./fee-schedules.js";

export const transactionFeesSchema = z.object({
  platformFee: z.string(),
  /** Provider/rail fee (e.g. Tekko NGN withdraw fee). Zero when none. */
  providerFee: z.string().default("0.00"),
  feeType: z.enum(["payin", "payout"]),
  feeStatus: z.enum(["none", "estimated", "applied"]),
});

export const transactionFeeBreakdownFieldsSchema = z.object({
  currency: z.string(),
  fees: transactionFeesSchema,
  netAmount: z.string().nullable(),
  totalWalletDebit: z.string().nullable(),
});

export type TransactionFeeBreakdownFields = z.infer<typeof transactionFeeBreakdownFieldsSchema>;

export const transactionFeeSummaryFieldsSchema = z.object({
  fees: transactionFeesSchema,
  netAmount: z.string().nullable(),
  totalWalletDebit: z.string().nullable(),
});

export type TransactionFeeSummaryFields = z.infer<typeof transactionFeeSummaryFieldsSchema>;

export interface TransactionFeeBreakdownInput {
  merchantId: string;
  environment: "test" | "live";
  transactionId: string;
  type: string;
  status: string;
  amount: string;
  paidAmount?: string | null;
  currency: string;
  provider?: string | null;
  metadata?: string | null;
}

const ZERO_FEE = "0.00";

function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase() || "BDT";
}

/** Tekko (and similar) rail fee stored on payout metadata when known. */
export function providerFeeFromMetadata(metadata?: string | null): string | null {
  if (!metadata?.trim()) return null;
  try {
    const meta = JSON.parse(metadata) as Record<string, unknown>;
    const raw = meta.tekkoFee ?? meta.providerFee;
    if (typeof raw !== "string" && typeof raw !== "number") return null;
    const n = String(raw).trim();
    if (!n) return null;
    if (cmpAmount(n, "0") <= 0) return null;
    return n.includes(".") ? n : `${n}.00`;
  } catch {
    return null;
  }
}

/** Amount used for fee schedule lookup (may differ from display amount on EUR rails). */
export function resolveTransactionFeeBaseAmount(input: {
  type: string;
  amount: string;
  paidAmount?: string | null;
  provider?: string | null;
  metadata?: string | null;
}): string {
  if (input.metadata) {
    try {
      const meta = JSON.parse(input.metadata) as Record<string, unknown>;
      if (
        input.type === "payout" &&
        input.provider === "tylt-eur-payout" &&
        typeof meta.debitAmount === "string" &&
        meta.debitAmount.trim()
      ) {
        return meta.debitAmount;
      }
    } catch {
      /* ignore malformed metadata */
    }
  }
  if (input.type === "payin" && input.paidAmount?.trim()) {
    return input.paidAmount;
  }
  return input.amount;
}

function feePreviewInput(input: TransactionFeeBreakdownInput, feeType: TransactionFeeType): TransactionFeePreviewInput {
  const feeBaseAmount = resolveTransactionFeeBaseAmount(input);
  return {
    merchantId: input.merchantId,
    environment: input.environment,
    transactionId: input.transactionId,
    currency: input.currency,
    provider: input.provider,
    amount: feeBaseAmount,
    feeType,
  };
}

export async function getAppliedTransactionFeeAmount(
  transactionId: string,
  feeType: TransactionFeeType
): Promise<string | null> {
  const refId = transactionFeeReferenceId(transactionId, feeType);
  const [row] = await db
    .select({ amount: ledgerEntries.amount })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.referenceId, refId),
        eq(ledgerEntries.type, "platform_fee"),
        eq(ledgerEntries.direction, "debit")
      )
    )
    .limit(1);
  return row ? String(row.amount) : null;
}

async function loadAppliedFeesByReferenceIds(referenceIds: string[]): Promise<Map<string, string>> {
  if (referenceIds.length === 0) return new Map();
  const rows = await db
    .select({ referenceId: ledgerEntries.referenceId, amount: ledgerEntries.amount })
    .from(ledgerEntries)
    .where(
      and(
        inArray(ledgerEntries.referenceId, referenceIds),
        eq(ledgerEntries.type, "platform_fee"),
        eq(ledgerEntries.direction, "debit")
      )
    );
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.referenceId) map.set(row.referenceId, String(row.amount));
  }
  return map;
}

export function formatTransactionFeeBreakdown(params: {
  type: "payin" | "payout";
  status: string;
  amount: string;
  paidAmount?: string | null;
  currency: string;
  platformFee: string | null;
  feeStatus: "none" | "estimated" | "applied";
  provider?: string | null;
  metadata?: string | null;
  providerFee?: string | null;
}): TransactionFeeBreakdownFields {
  const platformFee = params.platformFee ?? ZERO_FEE;
  const providerFee =
    params.providerFee ?? providerFeeFromMetadata(params.metadata) ?? ZERO_FEE;
  const currency = normalizeCurrency(params.currency);
  const fees = {
    platformFee,
    providerFee,
    feeType: params.type,
    feeStatus: params.feeStatus,
  } as const;

  if (params.type === "payin") {
    const gross = params.paidAmount?.trim() ? params.paidAmount : params.amount;
    let net = subAmount(gross, platformFee);
    if (providerFee !== ZERO_FEE && cmpAmount(providerFee, "0") > 0) {
      try {
        net = subAmount(net, providerFee);
      } catch {
        /* keep platform-only net */
      }
    }
    return {
      currency,
      fees,
      netAmount: net,
      totalWalletDebit: null,
    };
  }

  const payoutBase = resolveTransactionFeeBaseAmount({
    type: "payout",
    amount: params.amount,
    provider: params.provider,
    metadata: params.metadata,
  });
  const platformForTotal = platformFee === ZERO_FEE ? null : platformFee;
  const providerForTotal =
    providerFee === ZERO_FEE || cmpAmount(providerFee, "0") <= 0 ? null : providerFee;
  return {
    currency,
    fees,
    netAmount: null,
    totalWalletDebit: payoutTotalWalletDebit(payoutBase, platformForTotal, providerForTotal),
  };
}

function formatFieldsFromInput(input: TransactionFeeBreakdownInput) {
  return {
    amount: input.amount,
    paidAmount: input.paidAmount,
    currency: input.currency,
    provider: input.provider,
    metadata: input.metadata,
  };
}

export async function buildTransactionFeeBreakdown(
  input: TransactionFeeBreakdownInput
): Promise<TransactionFeeBreakdownFields | null> {
  if (input.type !== "payin" && input.type !== "payout") {
    return null;
  }
  const feeType = input.type;
  const providerFee = providerFeeFromMetadata(input.metadata);

  if (input.status === "failed") {
    return formatTransactionFeeBreakdown({
      type: feeType,
      status: input.status,
      ...formatFieldsFromInput(input),
      platformFee: ZERO_FEE,
      feeStatus: "none",
      providerFee,
    });
  }

  if (input.status === "success") {
    const applied = await getAppliedTransactionFeeAmount(input.transactionId, feeType);
    if (applied) {
      return formatTransactionFeeBreakdown({
        type: feeType,
        status: input.status,
        ...formatFieldsFromInput(input),
        platformFee: applied,
        feeStatus: "applied",
        providerFee,
      });
    }
    const preview = await previewTransactionFee(feePreviewInput(input, feeType));
    return formatTransactionFeeBreakdown({
      type: feeType,
      status: input.status,
      ...formatFieldsFromInput(input),
      platformFee: preview,
      feeStatus: preview ? "estimated" : "none",
      providerFee,
    });
  }

  const preview = await previewTransactionFee(feePreviewInput(input, feeType));
  return formatTransactionFeeBreakdown({
    type: feeType,
    status: input.status,
    ...formatFieldsFromInput(input),
    platformFee: preview,
    feeStatus: preview ? "estimated" : "none",
    providerFee,
  });
}

export async function buildTransactionFeeBreakdownBatch(
  rows: TransactionFeeBreakdownInput[]
): Promise<(TransactionFeeBreakdownFields | null)[]> {
  const feeRows = rows.filter((row) => row.type === "payin" || row.type === "payout");
  const appliedRefIds = feeRows
    .filter((row) => row.status === "success")
    .map((row) => transactionFeeReferenceId(row.transactionId, row.type as TransactionFeeType));
  const appliedByRef = await loadAppliedFeesByReferenceIds(appliedRefIds);

  const previewKeys = rows
    .filter((row) => {
      if (row.type !== "payin" && row.type !== "payout") return false;
      if (row.status === "success") {
        const applied = appliedByRef.get(
          transactionFeeReferenceId(row.transactionId, row.type as TransactionFeeType)
        );
        if (applied) return false;
      }
      return true;
    })
    .map((row) => ({
      merchantId: row.merchantId,
      environment: row.environment,
      currency: row.currency,
      feeType: row.type as TransactionFeeType,
      provider: row.provider,
    }));
  const scheduleMap = await resolveFeeSchedulesBatch(previewKeys);

  return Promise.all(
    rows.map(async (row) => {
      if (row.type !== "payin" && row.type !== "payout") {
        return null;
      }
      const feeType = row.type;
      const providerFee = providerFeeFromMetadata(row.metadata);

      if (row.status === "failed") {
        return formatTransactionFeeBreakdown({
          type: feeType,
          status: row.status,
          ...formatFieldsFromInput(row),
          platformFee: ZERO_FEE,
          feeStatus: "none",
          providerFee,
        });
      }

      if (row.status === "success") {
        const applied = appliedByRef.get(transactionFeeReferenceId(row.transactionId, feeType)) ?? null;
        if (applied) {
          return formatTransactionFeeBreakdown({
            type: feeType,
            status: row.status,
            ...formatFieldsFromInput(row),
            platformFee: applied,
            feeStatus: "applied",
            providerFee,
          });
        }
      }

      const previewArgs = feePreviewInput(row, feeType);
      const cacheKey = feeScheduleCacheKey({
        merchantId: row.merchantId,
        environment: row.environment,
        currency: row.currency,
        feeType,
        provider: row.provider,
      });
      const schedule = scheduleMap.get(cacheKey) ?? null;
      const preview = feeAmountFromSchedule(schedule, previewArgs.amount, feeType);
      return formatTransactionFeeBreakdown({
        type: feeType,
        status: row.status,
        ...formatFieldsFromInput(row),
        platformFee: preview,
        feeStatus: preview ? "estimated" : "none",
        providerFee,
      });
    })
  );
}

export function attachFeeBreakdown<T extends Record<string, unknown>>(
  base: T,
  breakdown: TransactionFeeBreakdownFields | null
): T & Partial<TransactionFeeBreakdownFields> {
  if (!breakdown) return base;
  return { ...base, ...breakdown };
}

export function feeSummaryFromBreakdown(
  breakdown: TransactionFeeBreakdownFields | null
): TransactionFeeSummaryFields | Record<string, never> {
  if (!breakdown) return {};
  return {
    fees: breakdown.fees,
    netAmount: breakdown.netAmount,
    totalWalletDebit: breakdown.totalWalletDebit,
  };
}

/** Flatten fee breakdown for merchant webhook payloads. */
export function feeBreakdownToWebhookFields(
  breakdown: TransactionFeeBreakdownFields | null
): Record<string, unknown> {
  if (!breakdown) return {};
  return {
    currency: breakdown.currency,
    fees: breakdown.fees,
    ...(breakdown.netAmount != null ? { netAmount: breakdown.netAmount } : {}),
    ...(breakdown.totalWalletDebit != null ? { totalWalletDebit: breakdown.totalWalletDebit } : {}),
  };
}
