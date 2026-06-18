import { and, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { transactions } from "../db/schema/index.js";
import { presentTransactionRail } from "./transaction-rail-label.js";

export type ReconciliationReportParams = {
  merchantId: string;
  environment: "test" | "live";
  from: Date;
  to: Date;
};

export type ReconciliationRow = {
  transactionId: string;
  type: string;
  status: string;
  amount: string;
  paidAmount: string | null;
  currency: string;
  rail: string;
  railLabel: string;
  platformOrderId: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type ReconciliationReport = {
  merchantId: string;
  environment: "test" | "live";
  from: string;
  to: string;
  summary: {
    totalTransactions: number;
    payinCount: number;
    payoutCount: number;
    successCount: number;
    failedCount: number;
    pendingCount: number;
    payinVolume: string;
    payoutVolume: string;
  };
  rows: ReconciliationRow[];
};

function sumAmounts(rows: { amount: string }[]): string {
  let cents = 0n;
  for (const r of rows) {
    const n = Number(r.amount);
    if (Number.isFinite(n)) cents += BigInt(Math.round(n * 100));
  }
  return (Number(cents) / 100).toFixed(2);
}

export async function buildReconciliationReport(
  params: ReconciliationReportParams
): Promise<ReconciliationReport> {
  const rows = await db
    .select({
      id: transactions.id,
      type: transactions.type,
      status: transactions.status,
      amount: transactions.amount,
      paidAmount: transactions.paidAmount,
      currency: transactions.currency,
      provider: transactions.provider,
      metadata: transactions.metadata,
      externalId: transactions.externalId,
      createdAt: transactions.createdAt,
      updatedAt: transactions.updatedAt,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.merchantId, params.merchantId),
        eq(transactions.environment, params.environment),
        gte(transactions.createdAt, params.from),
        lte(transactions.createdAt, params.to)
      )
    )
    .orderBy(sql`${transactions.createdAt} desc`);

  const payins = rows.filter((r) => r.type === "payin");
  const payouts = rows.filter((r) => r.type === "payout");

  const mapped: ReconciliationRow[] = rows.map((tx) => {
    const rail = presentTransactionRail({
      provider: tx.provider,
      currency: tx.currency,
      metadata: tx.metadata,
    });
    return {
      transactionId: tx.id,
      type: tx.type,
      status: tx.status,
      amount: String(tx.amount),
      paidAmount: tx.paidAmount != null ? String(tx.paidAmount) : null,
      currency: rail.currency,
      rail: rail.rail,
      railLabel: rail.railLabel,
      platformOrderId: tx.externalId,
      createdAt: tx.createdAt.toISOString(),
      completedAt: tx.status === "success" ? tx.updatedAt.toISOString() : null,
    };
  });

  return {
    merchantId: params.merchantId,
    environment: params.environment,
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    summary: {
      totalTransactions: rows.length,
      payinCount: payins.length,
      payoutCount: payouts.length,
      successCount: rows.filter((r) => r.status === "success").length,
      failedCount: rows.filter((r) => r.status === "failed").length,
      pendingCount: rows.filter((r) => r.status === "pending").length,
      payinVolume: sumAmounts(payins),
      payoutVolume: sumAmounts(payouts),
    },
    rows: mapped,
  };
}

export function reconciliationReportToCsv(report: ReconciliationReport): string {
  const header =
    "transaction_id,type,status,amount,paid_amount,currency,rail,platform_order_id,created_at,completed_at";
  const lines = report.rows.map((r) =>
    [
      r.transactionId,
      r.type,
      r.status,
      r.amount,
      r.paidAmount ?? "",
      r.currency,
      r.rail,
      r.platformOrderId ?? "",
      r.createdAt,
      r.completedAt ?? "",
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",")
  );
  return [header, ...lines].join("\n");
}
