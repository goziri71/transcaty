import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { fxRateProfiles, merchantFxOverrides } from "../../db/schema/index.js";
import type { FxProduct } from "./spread.js";

export type ResolvedFxSpread = {
  rateProfileId: string | null;
  overrideId: string | null;
  product: FxProduct;
  settledCurrency: string;
  networkSymbol: string | null;
  spreadBps: number;
  spreadMode: "on_output" | "on_rate";
  manualRate: string | null;
  source: string;
  disabled: boolean;
};

function activeAt(now: Date) {
  return and(
    lte(fxRateProfiles.effectiveFrom, now),
    or(isNull(fxRateProfiles.effectiveTo), sql`${fxRateProfiles.effectiveTo} > ${now}`)
  );
}

export async function resolveFxSpread(params: {
  merchantId: string;
  environment: "test" | "live";
  product: FxProduct;
  settledCurrency: string;
  networkSymbol?: string | null;
  at?: Date;
}): Promise<ResolvedFxSpread | null> {
  const now = params.at ?? new Date();
  const currency = params.settledCurrency.trim().toUpperCase();
  const network = params.networkSymbol?.trim() || null;

  const [override] = await db
    .select()
    .from(merchantFxOverrides)
    .where(
      and(
        eq(merchantFxOverrides.merchantId, params.merchantId),
        eq(merchantFxOverrides.environment, params.environment),
        eq(merchantFxOverrides.product, params.product),
        eq(merchantFxOverrides.settledCurrency, currency),
        network
          ? eq(merchantFxOverrides.networkSymbol, network)
          : isNull(merchantFxOverrides.networkSymbol),
        lte(merchantFxOverrides.effectiveFrom, now),
        or(isNull(merchantFxOverrides.effectiveTo), sql`${merchantFxOverrides.effectiveTo} > ${now}`)
      )
    )
    .orderBy(desc(merchantFxOverrides.effectiveFrom))
    .limit(1);

  if (override?.disabled) {
    return {
      rateProfileId: null,
      overrideId: override.id,
      product: params.product,
      settledCurrency: currency,
      networkSymbol: network,
      spreadBps: 0,
      spreadMode: "on_output",
      manualRate: null,
      source: "disabled",
      disabled: true,
    };
  }

  const profileConditions = [
    eq(fxRateProfiles.product, params.product),
    eq(fxRateProfiles.settledCurrency, currency),
    eq(fxRateProfiles.status, "active"),
    activeAt(now),
  ];
  if (network) {
    profileConditions.push(eq(fxRateProfiles.networkSymbol, network));
  }

  const [profile] = await db
    .select()
    .from(fxRateProfiles)
    .where(and(...profileConditions))
    .orderBy(desc(fxRateProfiles.effectiveFrom))
    .limit(1);

  const spreadBps =
    override?.spreadBpsOverride != null ? override.spreadBpsOverride : (profile?.spreadBps ?? 0);
  const spreadMode =
    (profile?.spreadMode as "on_output" | "on_rate" | undefined) ?? "on_output";
  const manualRate =
    override?.manualRateOverride != null
      ? String(override.manualRateOverride)
      : profile?.manualRate != null
        ? String(profile.manualRate)
        : null;

  if (!profile && !override) {
    return {
      rateProfileId: null,
      overrideId: null,
      product: params.product,
      settledCurrency: currency,
      networkSymbol: network,
      spreadBps: 0,
      spreadMode: "on_output",
      manualRate: null,
      source: "none",
      disabled: false,
    };
  }

  return {
    rateProfileId: profile?.id ?? null,
    overrideId: override?.id ?? null,
    product: params.product,
    settledCurrency: currency,
    networkSymbol: network,
    spreadBps,
    spreadMode,
    manualRate,
    source: profile?.source ?? "override_only",
    disabled: false,
  };
}
