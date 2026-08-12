/**
 * Merchant-visible fees + admin pricing/adjustments board for dashboard depth.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  merchantAuditLog,
  merchantFeeSchedules,
  merchantPricing,
  providerActionRequests,
} from "../db/schema/index.js";
import { getMerchantPricing } from "./billing/pricing.js";

const FEE_ENV = ["test", "live"] as const;
export type FeeEnvironment = (typeof FEE_ENV)[number];

export type FeeLine = {
  id: string;
  source: "schedule" | "legacy";
  environment: FeeEnvironment | "legacy";
  rail: string;
  currency: string;
  feeType: "payin" | "payout";
  billingMode: string;
  feePercentage: string | null;
  feeFlat: string | null;
  feeMin: string | null;
  feeMax: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  status: string;
};

function mapScheduleRow(r: typeof merchantFeeSchedules.$inferSelect): FeeLine {
  return {
    id: r.id,
    source: "schedule",
    environment: r.environment as FeeEnvironment,
    rail: r.rail,
    currency: r.currency,
    feeType: r.feeType as "payin" | "payout",
    billingMode: r.billingMode,
    feePercentage: r.feePercentage != null ? String(r.feePercentage) : null,
    feeFlat: r.feeFlat != null ? String(r.feeFlat) : null,
    feeMin: r.feeMin != null ? String(r.feeMin) : null,
    feeMax: r.feeMax != null ? String(r.feeMax) : null,
    effectiveFrom: r.effectiveFrom.toISOString(),
    effectiveTo: r.effectiveTo?.toISOString() ?? null,
    status: r.status,
  };
}

function legacyLines(pricing: NonNullable<Awaited<ReturnType<typeof getMerchantPricing>>>): FeeLine[] {
  const base = {
    source: "legacy" as const,
    environment: "legacy" as const,
    rail: "bangladesh",
    currency: "BDT",
    billingMode: pricing.billingMode,
    feeFlat: "0",
    effectiveFrom: null as string | null,
    effectiveTo: null as string | null,
    status: "active",
  };
  return [
    {
      ...base,
      id: "legacy-payin",
      feeType: "payin" as const,
      feePercentage: pricing.feePercentagePayin,
      feeMin: pricing.feeMinPayin,
      feeMax: pricing.feeMaxPayin,
    },
    {
      ...base,
      id: "legacy-payout",
      feeType: "payout" as const,
      feePercentage: pricing.feePercentagePayout,
      feeMin: pricing.feeMinPayout,
      feeMax: pricing.feeMaxPayout,
    },
  ];
}

/** Read-only fee board for the merchant portal. */
export async function buildMerchantFeesExperience(params: {
  merchantId: string;
  environment?: FeeEnvironment;
}): Promise<{
  environment: FeeEnvironment | "all";
  items: FeeLine[];
  note: string;
}> {
  const conditions = [
    eq(merchantFeeSchedules.merchantId, params.merchantId),
    eq(merchantFeeSchedules.status, "active"),
  ];
  if (params.environment) {
    conditions.push(eq(merchantFeeSchedules.environment, params.environment));
  }

  const schedules = await db
    .select()
    .from(merchantFeeSchedules)
    .where(and(...conditions))
    .orderBy(desc(merchantFeeSchedules.effectiveFrom));

  const items: FeeLine[] = schedules.map(mapScheduleRow);

  // Surface legacy BD % only when no matching schedule exists for that env+rail.
  const hasBdSchedule = items.some(
    (i) => i.rail === "bangladesh" && i.currency === "BDT" && (!params.environment || i.environment === params.environment)
  );
  if (!hasBdSchedule) {
    const legacy = await getMerchantPricing(params.merchantId);
    if (legacy) items.push(...legacyLines(legacy));
  }

  return {
    environment: params.environment ?? "all",
    items,
    note: "Fees shown are contractual rates. Transaction detail still shows the exact fee applied.",
  };
}

function parseJsonPayload(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Admin board: legacy + schedules + pending wallet adjustments + recent pricing audit. */
export async function buildAdminPricingOverview(merchantId: string): Promise<{
  legacy: {
    billingMode: string;
    feePercentagePayin: string | null;
    feePercentagePayout: string | null;
    feeMinPayin: string | null;
    feeMaxPayin: string | null;
    feeMinPayout: string | null;
    feeMaxPayout: string | null;
    monthlyAmount: string | null;
  };
  feeSchedules: FeeLine[];
  pendingAdjustments: {
    count: number;
    items: Array<{
      id: string;
      actionType: string;
      status: string;
      resourceType: string;
      resourceId: string;
      riskLevel: string;
      direction: string | null;
      amount: string | null;
      reason: string | null;
      ticketId: string | null;
      requestedBy: string | null;
      createdAt: string;
      reviewPath: string;
    }>;
  };
  recentPricingActions: Array<{
    id: string;
    action: string;
    resource: string | null;
    actorEmail: string | null;
    createdAt: string;
  }>;
  links: {
    legacyPricing: string;
    feeSchedules: string;
    createFeeSchedule: string;
    approvals: string;
    merchantWalletAdjust: string;
  };
}> {
  const [legacyRow, schedules, pendingRows, recent] = await Promise.all([
    db.select().from(merchantPricing).where(eq(merchantPricing.merchantId, merchantId)).limit(1),
    db
      .select()
      .from(merchantFeeSchedules)
      .where(eq(merchantFeeSchedules.merchantId, merchantId))
      .orderBy(desc(merchantFeeSchedules.effectiveFrom)),
    db
      .select()
      .from(providerActionRequests)
      .where(
        and(
          eq(providerActionRequests.status, "pending"),
          eq(providerActionRequests.actionType, "wallet_adjustment"),
          sql`(${providerActionRequests.payload}::json->>'merchantId') = ${merchantId}`
        )
      )
      .orderBy(desc(providerActionRequests.createdAt))
      .limit(50),
    db
      .select({
        id: merchantAuditLog.id,
        action: merchantAuditLog.action,
        resource: merchantAuditLog.resource,
        actorEmail: merchantAuditLog.actorEmail,
        createdAt: merchantAuditLog.createdAt,
      })
      .from(merchantAuditLog)
      .where(
        and(
          eq(merchantAuditLog.merchantId, merchantId),
          inArray(merchantAuditLog.action, [
            "provider.merchant.pricing_changed",
            "provider.merchant.fee_schedule_changed",
            "provider.wallet.adjusted",
          ])
        )
      )
      .orderBy(desc(merchantAuditLog.createdAt))
      .limit(20),
  ]);

  const row = legacyRow[0];
  const pendingItems = pendingRows.map((r) => {
    const payload = parseJsonPayload(r.payload);
    return {
      id: r.id,
      actionType: r.actionType,
      status: r.status,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      riskLevel: r.riskLevel,
      direction: typeof payload.direction === "string" ? payload.direction : null,
      amount: typeof payload.amount === "string" ? payload.amount : null,
      reason: r.reason,
      ticketId: r.ticketId,
      requestedBy: r.requestedBy,
      createdAt: r.createdAt.toISOString(),
      reviewPath: `/provider/approvals/${r.id}`,
    };
  });

  return {
    legacy: {
      billingMode: row?.billingMode ?? "percentage_only",
      feePercentagePayin: row?.feePercentagePayin ?? null,
      feePercentagePayout: row?.feePercentagePayout ?? null,
      feeMinPayin: row?.feeMinPayin ?? null,
      feeMaxPayin: row?.feeMaxPayin ?? null,
      feeMinPayout: row?.feeMinPayout ?? null,
      feeMaxPayout: row?.feeMaxPayout ?? null,
      monthlyAmount: row?.monthlyAmount ?? null,
    },
    feeSchedules: schedules.map(mapScheduleRow),
    pendingAdjustments: {
      count: pendingItems.length,
      items: pendingItems,
    },
    recentPricingActions: recent.map((r) => ({
      id: r.id,
      action: r.action,
      resource: r.resource,
      actorEmail: r.actorEmail,
      createdAt: r.createdAt.toISOString(),
    })),
    links: {
      legacyPricing: `/provider/merchants/${merchantId}/pricing`,
      feeSchedules: `/provider/merchants/${merchantId}/fee-schedules`,
      createFeeSchedule: `/provider/merchants/${merchantId}/fee-schedules`,
      approvals: `/provider/approvals?status=pending&actionType=wallet_adjustment&merchantId=${merchantId}`,
      merchantWalletAdjust: `/provider/merchants/${merchantId}/wallet-adjustments`,
    },
  };
}
