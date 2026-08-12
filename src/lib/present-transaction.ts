/**
 * Shared transaction list/detail presentation for portal + provider dashboards.
 */
import { presentTransactionRail } from "./transaction-rail-label.js";
import {
  buildTransactionFeeBreakdownBatch,
  feeSummaryFromBreakdown,
  type TransactionFeeBreakdownInput,
  type TransactionFeeSummaryFields,
} from "./billing/transaction-fee-breakdown.js";

export type TransactionListRow = {
  id: string;
  type: string;
  status: string;
  amount: string | number;
  paidAmount: string | number | null;
  currency: string;
  provider: string | null;
  externalId: string | null;
  walletId: string | null;
  metadata: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PresentedTransactionListItem = {
  id: string;
  type: string;
  status: string;
  amount: string;
  paidAmount: string | null;
  platformOrderId: string | null;
  customerWalletId: string | null;
  refundOfTransactionId: string | null;
  settlementCurrency: string;
  createdAt: string;
  completedAt: string | null;
  currency: string;
  rail: string;
  railLabel: string;
} & Partial<TransactionFeeSummaryFields>;

function refundOfFromMetadata(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const meta = JSON.parse(metadata) as { refundOfTransactionId?: string };
    return meta.refundOfTransactionId ?? null;
  } catch {
    return null;
  }
}

function settlementCurrencyFromRow(row: TransactionListRow): string {
  if (row.metadata) {
    try {
      const meta = JSON.parse(row.metadata) as { settlementCurrency?: string };
      if (typeof meta.settlementCurrency === "string" && meta.settlementCurrency.trim()) {
        return meta.settlementCurrency.trim().toUpperCase();
      }
    } catch {
      /* ignore */
    }
  }
  return row.currency.trim().toUpperCase() || "BDT";
}

export function presentTransactionListItemBase(row: TransactionListRow): PresentedTransactionListItem {
  const rail = presentTransactionRail({
    provider: row.provider,
    currency: row.currency,
    metadata: row.metadata,
  });
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    amount: String(row.amount),
    paidAmount: row.paidAmount != null ? String(row.paidAmount) : null,
    platformOrderId: row.externalId,
    customerWalletId: row.walletId,
    refundOfTransactionId: refundOfFromMetadata(row.metadata),
    settlementCurrency: settlementCurrencyFromRow(row),
    createdAt: row.createdAt.toISOString(),
    completedAt: row.status === "success" ? row.updatedAt.toISOString() : null,
    ...rail,
  };
}

export async function presentTransactionListItems(params: {
  merchantId: string;
  environment: "test" | "live";
  rows: TransactionListRow[];
}): Promise<PresentedTransactionListItem[]> {
  const breakdowns = await buildTransactionFeeBreakdownBatch(
    params.rows.map(
      (r): TransactionFeeBreakdownInput => ({
        merchantId: params.merchantId,
        environment: params.environment,
        transactionId: r.id,
        type: r.type,
        status: r.status,
        amount: String(r.amount),
        paidAmount: r.paidAmount != null ? String(r.paidAmount) : null,
        currency: r.currency,
        provider: r.provider,
        metadata: r.metadata,
      })
    )
  );

  return params.rows.map((row, index) => ({
    ...presentTransactionListItemBase(row),
    ...feeSummaryFromBreakdown(breakdowns[index] ?? null),
  }));
}

export function reconcileStatusFromTransaction(params: {
  status: string;
  metadata: string | null;
}): "open" | "settled" | "failed" | "review_required" {
  if (params.metadata) {
    try {
      const meta = JSON.parse(params.metadata) as { reviewRequired?: boolean };
      if (meta.reviewRequired === true) return "review_required";
    } catch {
      /* ignore */
    }
  }
  if (params.status === "success") return "settled";
  if (params.status === "failed") return "failed";
  return "open";
}

export type ProviderRefs = {
  instanceId: string | null;
  paymentIntentId: string | null;
  checkoutUrl: string | null;
  depositAddress: string | null;
  utr: string | null;
  networkSymbol: string | null;
};

export function extractProviderRefs(params: {
  externalId: string | null;
  metadata: Record<string, unknown> | null;
}): ProviderRefs {
  const meta = params.metadata ?? {};
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;

  return {
    instanceId: str(meta.instanceId) ?? params.externalId,
    paymentIntentId: str(meta.paymentIntentId) ?? str(meta.tekkoPaymentIntentId),
    checkoutUrl: str(meta.checkoutUrl) ?? str(meta.paymentUrl) ?? str(meta.redirectUrl),
    depositAddress: str(meta.depositAddress) ?? str(meta.address),
    utr: str(meta.utr) ?? str(meta.UTR),
    networkSymbol: str(meta.networkSymbol) ?? str(meta.network),
  };
}

export type StatusTimelinePoint = {
  at: string;
  status: string;
  label: string;
};

export function buildStatusTimeline(params: {
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): StatusTimelinePoint[] {
  const points: StatusTimelinePoint[] = [
    { at: params.createdAt.toISOString(), status: "pending", label: "Created" },
  ];
  if (params.status === "success") {
    points.push({
      at: params.updatedAt.toISOString(),
      status: "success",
      label: "Completed",
    });
  } else if (params.status === "failed") {
    points.push({
      at: params.updatedAt.toISOString(),
      status: "failed",
      label: "Failed",
    });
  } else {
    points.push({
      at: params.updatedAt.toISOString(),
      status: "pending",
      label: "In progress",
    });
  }
  return points;
}
