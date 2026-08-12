/**
 * Admin ops queues: KYC/KYB review + reconcile console.
 */
import { and, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { merchantMarkets, merchants, transactions } from "../db/schema/index.js";
import { MARKET_DISPLAY_NAMES, type MerchantMarket } from "./merchant-markets.js";
import {
  presentTransactionRail,
  type MerchantTransactionRail,
} from "./transaction-rail-label.js";
import { reconcileStatusFromTransaction } from "./present-transaction.js";

export type KycQueueReason = "global_kyc_pending" | "market_requested" | "market_kyb_in_review";

export type KycQueueItem = {
  merchantId: string;
  slug: string;
  name: string;
  status: string;
  globalKycStatus: string;
  queueReasons: KycQueueReason[];
  marketsNeedingReview: Array<{
    market: string;
    displayName: string;
    entitlementStatus: string;
    kybStatus: string;
    requestedAt: string | null;
  }>;
  createdAt: string;
};

export async function buildKycQueue(params: {
  reason?: "global" | "market" | "all";
  market?: string;
  limit: number;
  offset: number;
}): Promise<{ items: KycQueueItem[]; total: number }> {
  const reason = params.reason ?? "all";

  const marketRows = await db
    .select({
      merchantId: merchantMarkets.merchantId,
      market: merchantMarkets.market,
      entitlementStatus: merchantMarkets.entitlementStatus,
      kybStatus: merchantMarkets.kybStatus,
      requestedAt: merchantMarkets.requestedAt,
    })
    .from(merchantMarkets)
    .where(inArray(merchantMarkets.entitlementStatus, ["requested", "kyb_in_review"]));

  const marketsByMerchant = new Map<string, typeof marketRows>();
  for (const row of marketRows) {
    if (params.market && row.market !== params.market) continue;
    const list = marketsByMerchant.get(row.merchantId) ?? [];
    list.push(row);
    marketsByMerchant.set(row.merchantId, list);
  }

  const globalPending = await db
    .select({
      id: merchants.id,
      slug: merchants.slug,
      name: merchants.name,
      status: merchants.status,
      kycStatus: merchants.kycStatus,
      createdAt: merchants.createdAt,
    })
    .from(merchants)
    .where(eq(merchants.kycStatus, "pending"));

  const merchantIds = new Set<string>();
  if (reason === "all" || reason === "global") {
    for (const m of globalPending) merchantIds.add(m.id);
  }
  if (reason === "all" || reason === "market") {
    for (const id of marketsByMerchant.keys()) merchantIds.add(id);
  }

  if (merchantIds.size === 0) {
    return { items: [], total: 0 };
  }

  const ids = [...merchantIds];
  const merchantRows = await db
    .select({
      id: merchants.id,
      slug: merchants.slug,
      name: merchants.name,
      status: merchants.status,
      kycStatus: merchants.kycStatus,
      createdAt: merchants.createdAt,
    })
    .from(merchants)
    .where(inArray(merchants.id, ids))
    .orderBy(desc(merchants.createdAt));

  const globalSet = new Set(globalPending.map((m) => m.id));

  const items: KycQueueItem[] = merchantRows.map((m) => {
    const queueReasons: KycQueueReason[] = [];
    if (globalSet.has(m.id) || m.kycStatus === "pending") {
      queueReasons.push("global_kyc_pending");
    }
    const needing = marketsByMerchant.get(m.id) ?? [];
    for (const row of needing) {
      if (row.entitlementStatus === "requested") queueReasons.push("market_requested");
      if (row.entitlementStatus === "kyb_in_review") queueReasons.push("market_kyb_in_review");
    }
    const uniqueReasons = [...new Set(queueReasons)];
    return {
      merchantId: m.id,
      slug: m.slug ?? m.id,
      name: m.name,
      status: m.status,
      globalKycStatus: m.kycStatus ?? "pending",
      queueReasons: uniqueReasons,
      marketsNeedingReview: needing.map((row) => ({
        market: row.market,
        displayName: MARKET_DISPLAY_NAMES[row.market as MerchantMarket] ?? row.market,
        entitlementStatus: row.entitlementStatus,
        kybStatus: row.kybStatus,
        requestedAt: row.requestedAt?.toISOString() ?? null,
      })),
      createdAt: m.createdAt.toISOString(),
    };
  });

  // Filter by reason after compose (market-only merchants without matching market already excluded)
  const filtered =
    reason === "global"
      ? items.filter((i) => i.queueReasons.includes("global_kyc_pending"))
      : reason === "market"
        ? items.filter(
            (i) =>
              i.queueReasons.includes("market_requested") ||
              i.queueReasons.includes("market_kyb_in_review")
          )
        : items;

  const total = filtered.length;
  const page = filtered.slice(params.offset, params.offset + params.limit);
  return { items: page, total };
}

export async function countMarketKybPendingMerchants(): Promise<number> {
  const rows = await db
    .select({ merchantId: merchantMarkets.merchantId })
    .from(merchantMarkets)
    .where(inArray(merchantMarkets.entitlementStatus, ["requested", "kyb_in_review"]));
  return new Set(rows.map((r) => r.merchantId)).size;
}

export type ReconcileActionHint = {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, string>;
} | null;

export function reconcileActionForProvider(params: {
  provider: string | null;
  type: string;
  transactionId: string;
}): { reconcileAction: ReconcileActionHint; inspectAction: ReconcileActionHint } {
  const provider = (params.provider ?? "").trim();
  const id = params.transactionId;
  const inspectAction: ReconcileActionHint =
    provider.startsWith("payok")
      ? { method: "GET", path: `/provider/transactions/${id}/reconcile` }
      : { method: "GET", path: `/provider/transactions/${id}` };

  if (provider === "payok-bd-payin" || provider === "payok-br-payin") {
    return {
      reconcileAction: {
        method: "POST",
        path: "/provider/payok/payin/reconcile",
        body: { transactionId: id },
      },
      inspectAction,
    };
  }
  if (provider.startsWith("payok") && params.type === "payout") {
    return {
      reconcileAction: null,
      inspectAction: { method: "GET", path: `/provider/transactions/${id}/reconcile` },
    };
  }
  if (provider === "tylt-crossramp" || provider.includes("crossramp")) {
    return {
      reconcileAction: {
        method: "POST",
        path: "/provider/tylt/crossramp/reconcile-payin",
        body: { transactionId: id },
      },
      inspectAction,
    };
  }
  if (provider === "tekko-pyusd-payin") {
    return {
      reconcileAction: {
        method: "POST",
        path: "/provider/tekko/pyusd/reconcile",
        body: { transactionId: id },
      },
      inspectAction,
    };
  }
  return { reconcileAction: null, inspectAction };
}

export type ReconcileQueueItem = {
  id: string;
  merchantId: string;
  merchantName: string;
  type: string;
  status: string;
  amount: string;
  paidAmount: string | null;
  currency: string;
  environment: string;
  provider: string | null;
  platformOrderId: string | null;
  reviewRequired: boolean;
  reconcileStatus: "open" | "settled" | "failed" | "review_required";
  rail: MerchantTransactionRail;
  railLabel: string;
  ageSeconds: number;
  reconcileAction: ReconcileActionHint;
  inspectAction: ReconcileActionHint;
  createdAt: string;
  updatedAt: string;
};

function isReviewRequired(metadata: string | null): boolean {
  if (!metadata) return false;
  try {
    const meta = JSON.parse(metadata) as { reviewRequired?: boolean };
    return meta.reviewRequired === true;
  } catch {
    return metadata.includes('"reviewRequired":true');
  }
}

export async function buildReconcileQueue(params: {
  environment?: "test" | "live";
  rail?: MerchantTransactionRail;
  limit: number;
  offset: number;
}): Promise<{ items: ReconcileQueueItem[]; total: number }> {
  const conditions = [
    or(
      eq(transactions.status, "pending"),
      eq(transactions.status, "failed"),
      and(eq(transactions.status, "pending"), ilike(transactions.metadata, '%"reviewRequired":true%'))
    )!,
  ];
  if (params.environment) {
    conditions.push(eq(transactions.environment, params.environment));
  }

  const rows = await db
    .select({
      id: transactions.id,
      merchantId: transactions.merchantId,
      merchantName: merchants.name,
      type: transactions.type,
      status: transactions.status,
      amount: transactions.amount,
      paidAmount: transactions.paidAmount,
      currency: transactions.currency,
      environment: transactions.environment,
      provider: transactions.provider,
      externalId: transactions.externalId,
      metadata: transactions.metadata,
      createdAt: transactions.createdAt,
      updatedAt: transactions.updatedAt,
    })
    .from(transactions)
    .innerJoin(merchants, eq(transactions.merchantId, merchants.id))
    .where(and(...conditions))
    .orderBy(desc(transactions.createdAt))
    .limit(500);

  const now = Date.now();
  let items: ReconcileQueueItem[] = rows.map((r) => {
    const rail = presentTransactionRail({
      provider: r.provider,
      currency: r.currency,
      metadata: r.metadata,
    });
    const reviewRequired = isReviewRequired(r.metadata);
    const actions = reconcileActionForProvider({
      provider: r.provider,
      type: r.type,
      transactionId: r.id,
    });
    return {
      id: r.id,
      merchantId: r.merchantId,
      merchantName: r.merchantName,
      type: r.type,
      status: r.status,
      amount: String(r.amount),
      paidAmount: r.paidAmount ? String(r.paidAmount) : null,
      currency: r.currency,
      environment: r.environment,
      provider: r.provider,
      platformOrderId: r.externalId,
      reviewRequired,
      reconcileStatus: reconcileStatusFromTransaction({
        status: r.status,
        metadata: r.metadata,
      }),
      rail: rail.rail,
      railLabel: rail.railLabel,
      ageSeconds: Math.max(0, Math.floor((now - r.createdAt.getTime()) / 1000)),
      reconcileAction: actions.reconcileAction,
      inspectAction: actions.inspectAction,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  });

  if (params.rail) {
    items = items.filter((i) => i.rail === params.rail);
  }

  // Deduplicate pending+reviewRequired overlap from OR (already unique by id)
  const total = items.length;
  return {
    items: items.slice(params.offset, params.offset + params.limit),
    total,
  };
}

export async function countReconcileQueueOpen(): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(transactions)
    .where(
      or(
        eq(transactions.status, "pending"),
        eq(transactions.status, "failed")
      )!
    );
  return Number(row?.count ?? 0);
}
