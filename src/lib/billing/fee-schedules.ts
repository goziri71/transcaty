import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { merchantFeeSchedules, merchantPricing } from "../../db/schema/index.js";
import type { TransactionFeeType } from "./fee-calculator.js";
import { getMerchantPricing, type MerchantPricingRow } from "./pricing.js";
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

  // NGN schedules are stored under rail `nigeria`. Fall back if provider mapping
  // still resolves elsewhere (e.g. older builds mapped tekko-* → europe).
  if (currency === "NGN" && rail !== "nigeria") {
    const ngnSchedule = await lookupSchedule({
      merchantId: params.merchantId,
      environment: params.environment,
      rail: "nigeria",
      currency: "NGN",
      feeType: params.feeType,
      now,
    });
    if (ngnSchedule) return ngnSchedule;
  }

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

export function feeScheduleCacheKey(params: {
  merchantId: string;
  environment: "test" | "live";
  currency: string;
  feeType: TransactionFeeType;
  provider?: string | null;
}): string {
  const rail = providerToFeeRail(params.provider, params.currency);
  const currency = params.currency.trim().toUpperCase();
  return `${params.merchantId}|${params.environment}|${rail}|${currency}|${params.feeType}`;
}

export interface FeeScheduleBatchKey {
  merchantId: string;
  environment: "test" | "live";
  currency: string;
  feeType: TransactionFeeType;
  provider?: string | null;
}

export async function resolveFeeSchedulesBatch(
  keys: FeeScheduleBatchKey[],
  at?: Date
): Promise<Map<string, FeeScheduleRow | null>> {
  const now = at ?? new Date();
  const result = new Map<string, FeeScheduleRow | null>();

  interface KeyRecord {
    merchantId: string;
    environment: "test" | "live";
    rail: FeeRail;
    currency: string;
    feeType: TransactionFeeType;
  }
  const records = new Map<string, KeyRecord>();
  const merchantIds = new Set<string>();
  const environments = new Set<"test" | "live">();

  for (const key of keys) {
    const rail = providerToFeeRail(key.provider, key.currency);
    const currency = key.currency.trim().toUpperCase();
    const cacheKey = feeScheduleCacheKey({
      merchantId: key.merchantId,
      environment: key.environment,
      currency: key.currency,
      feeType: key.feeType,
      provider: key.provider,
    });
    if (!records.has(cacheKey)) {
      records.set(cacheKey, {
        merchantId: key.merchantId,
        environment: key.environment,
        rail,
        currency,
        feeType: key.feeType,
      });
    }
    merchantIds.add(key.merchantId);
    environments.add(key.environment);
  }

  if (records.size === 0) {
    return result;
  }

  const distinctMerchantIds = Array.from(merchantIds);
  const distinctEnvironments = Array.from(environments);

  const rows = await db
    .select({
      id: merchantFeeSchedules.id,
      merchantId: merchantFeeSchedules.merchantId,
      environment: merchantFeeSchedules.environment,
      feeType: merchantFeeSchedules.feeType,
      rail: merchantFeeSchedules.rail,
      currency: merchantFeeSchedules.currency,
      effectiveFrom: merchantFeeSchedules.effectiveFrom,
      billingMode: merchantFeeSchedules.billingMode,
      feePercentage: merchantFeeSchedules.feePercentage,
      feeFlat: merchantFeeSchedules.feeFlat,
      feeMin: merchantFeeSchedules.feeMin,
      feeMax: merchantFeeSchedules.feeMax,
    })
    .from(merchantFeeSchedules)
    .where(
      and(
        inArray(merchantFeeSchedules.merchantId, distinctMerchantIds),
        inArray(merchantFeeSchedules.environment, distinctEnvironments),
        eq(merchantFeeSchedules.status, "active"),
        lte(merchantFeeSchedules.effectiveFrom, now),
        or(isNull(merchantFeeSchedules.effectiveTo), sql`${merchantFeeSchedules.effectiveTo} > ${now}`)
      )
    );

  const bestByKey = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const cacheKey = `${row.merchantId}|${row.environment}|${row.rail}|${row.currency}|${row.feeType}`;
    if (!records.has(cacheKey)) continue;
    const existing = bestByKey.get(cacheKey);
    if (!existing || row.effectiveFrom > existing.effectiveFrom) {
      bestByKey.set(cacheKey, row);
    }
  }

  // Also index nigeria/NGN rows so europe-mapped NGN lookups can fall back.
  const nigeriaNgnByLookup = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (row.rail !== "nigeria" || row.currency !== "NGN") continue;
    const alt = `${row.merchantId}|${row.environment}|NGN|${row.feeType}`;
    const existing = nigeriaNgnByLookup.get(alt);
    if (!existing || row.effectiveFrom > existing.effectiveFrom) {
      nigeriaNgnByLookup.set(alt, row);
    }
  }

  for (const [cacheKey, row] of bestByKey) {
    result.set(cacheKey, {
      id: row.id,
      billingMode: row.billingMode,
      feePercentage: row.feePercentage != null ? String(row.feePercentage) : null,
      feeFlat: row.feeFlat != null ? String(row.feeFlat) : null,
      feeMin: row.feeMin != null ? String(row.feeMin) : null,
      feeMax: row.feeMax != null ? String(row.feeMax) : null,
    });
  }

  for (const [cacheKey, record] of records) {
    if (result.has(cacheKey)) continue;
    if (record.currency !== "NGN") continue;
    const alt = `${record.merchantId}|${record.environment}|NGN|${record.feeType}`;
    const row = nigeriaNgnByLookup.get(alt);
    if (!row) continue;
    result.set(cacheKey, {
      id: row.id,
      billingMode: row.billingMode,
      feePercentage: row.feePercentage != null ? String(row.feePercentage) : null,
      feeFlat: row.feeFlat != null ? String(row.feeFlat) : null,
      feeMin: row.feeMin != null ? String(row.feeMin) : null,
      feeMax: row.feeMax != null ? String(row.feeMax) : null,
    });
  }

  const fallbackMerchantIds = new Set<string>();
  for (const [cacheKey, record] of records) {
    if (result.has(cacheKey)) continue;
    if (record.rail === "bangladesh" && record.currency === "BDT") {
      fallbackMerchantIds.add(record.merchantId);
    }
  }

  if (fallbackMerchantIds.size > 0) {
    const pricingRows = await db
      .select({
        merchantId: merchantPricing.merchantId,
        billingMode: merchantPricing.billingMode,
        feePercentagePayin: merchantPricing.feePercentagePayin,
        feePercentagePayout: merchantPricing.feePercentagePayout,
        feeMinPayin: merchantPricing.feeMinPayin,
        feeMaxPayin: merchantPricing.feeMaxPayin,
        feeMinPayout: merchantPricing.feeMinPayout,
        feeMaxPayout: merchantPricing.feeMaxPayout,
        monthlyAmount: merchantPricing.monthlyAmount,
      })
      .from(merchantPricing)
      .where(inArray(merchantPricing.merchantId, Array.from(fallbackMerchantIds)));

    const pricingByMerchant = new Map<string, MerchantPricingRow>();
    for (const row of pricingRows) {
      const { merchantId, ...pricing } = row;
      pricingByMerchant.set(merchantId, pricing as MerchantPricingRow);
    }

    for (const [cacheKey, record] of records) {
      if (result.has(cacheKey)) continue;
      if (record.rail === "bangladesh" && record.currency === "BDT") {
        const pricing = pricingByMerchant.get(record.merchantId);
        if (pricing) {
          result.set(cacheKey, legacyPricingToSchedule(pricing, record.feeType));
        }
      }
    }
  }

  for (const cacheKey of records.keys()) {
    if (!result.has(cacheKey)) {
      result.set(cacheKey, null);
    }
  }

  return result;
}
