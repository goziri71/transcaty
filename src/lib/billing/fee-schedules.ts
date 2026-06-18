import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { merchantFeeSchedules } from "../../db/schema/index.js";
import type { TransactionFeeType } from "./fee-calculator.js";
import { getMerchantPricing } from "./pricing.js";
import {
  legacyPricingToSchedule,
  providerToFeeRail,
  type FeeRail,
  type FeeScheduleRow,
} from "./fee-rail.js";

export async function resolveFeeSchedule(params: {
  merchantId: string;
  environment: "test" | "live";
  currency: string;
  feeType: TransactionFeeType;
  provider?: string | null;
  at?: Date;
}): Promise<FeeScheduleRow | null> {
  const now = params.at ?? new Date();
  const rail = providerToFeeRail(params.provider, params.currency);
  const currency = params.currency.trim().toUpperCase();

  const schedule = await lookupSchedule({
    merchantId: params.merchantId,
    environment: params.environment,
    rail,
    currency,
    feeType: params.feeType,
    now,
  });
  if (schedule) return schedule;

  if (rail === "bangladesh" && currency === "BDT") {
    const legacy = await getMerchantPricing(params.merchantId);
    if (legacy) {
      return legacyPricingToSchedule(legacy, params.feeType);
    }
  }

  return null;
}

async function lookupSchedule(params: {
  merchantId: string;
  environment: "test" | "live";
  rail: FeeRail;
  currency: string;
  feeType: TransactionFeeType;
  now: Date;
}): Promise<FeeScheduleRow | null> {
  const activeWindow = and(
    lte(merchantFeeSchedules.effectiveFrom, params.now),
    or(isNull(merchantFeeSchedules.effectiveTo), sql`${merchantFeeSchedules.effectiveTo} > ${params.now}`)
  );

  const baseWhere = and(
    eq(merchantFeeSchedules.merchantId, params.merchantId),
    eq(merchantFeeSchedules.environment, params.environment),
    eq(merchantFeeSchedules.feeType, params.feeType),
    eq(merchantFeeSchedules.status, "active"),
    activeWindow
  );

  const [exact] = await db
    .select({
      id: merchantFeeSchedules.id,
      billingMode: merchantFeeSchedules.billingMode,
      feePercentage: merchantFeeSchedules.feePercentage,
      feeFlat: merchantFeeSchedules.feeFlat,
      feeMin: merchantFeeSchedules.feeMin,
      feeMax: merchantFeeSchedules.feeMax,
    })
    .from(merchantFeeSchedules)
    .where(
      and(baseWhere, eq(merchantFeeSchedules.rail, params.rail), eq(merchantFeeSchedules.currency, params.currency))
    )
    .orderBy(desc(merchantFeeSchedules.effectiveFrom))
    .limit(1);

  if (exact) {
    return {
      id: exact.id,
      billingMode: exact.billingMode,
      feePercentage: exact.feePercentage != null ? String(exact.feePercentage) : null,
      feeFlat: exact.feeFlat != null ? String(exact.feeFlat) : null,
      feeMin: exact.feeMin != null ? String(exact.feeMin) : null,
      feeMax: exact.feeMax != null ? String(exact.feeMax) : null,
    };
  }

  return null;
}
