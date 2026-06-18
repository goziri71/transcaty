import type { TransactionFeeType } from "./fee-calculator.js";

export type FeeRail = "bangladesh" | "india" | "europe" | "cpg_crypto";

export function providerToFeeRail(provider: string | null | undefined, currency: string): FeeRail {
  const p = provider?.trim() ?? "";
  const c = currency.trim().toUpperCase();
  if (p.startsWith("payok")) return "bangladesh";
  if (p === "tylt-cpg-payout" || p === "tylt-cpg-payin") return "cpg_crypto";
  if (p === "tylt-eur-payout" || p === "tylt-eur-payin" || p.startsWith("tylt-eur")) return "europe";
  if (p.startsWith("tylt-")) return "india";
  if (c === "BDT") return "bangladesh";
  if (c === "EUR" || c === "USDC") return "europe";
  if (c === "USDT" || c === "INR") return "india";
  return "bangladesh";
}

export type FeeScheduleRow = {
  id: string;
  billingMode: string;
  feePercentage: string | null;
  feeFlat: string | null;
  feeMin: string | null;
  feeMax: string | null;
};

export function legacyPricingToSchedule(
  pricing: {
    billingMode: string;
    feePercentagePayin: string | null;
    feePercentagePayout: string | null;
    feeMinPayin: string | null;
    feeMaxPayin: string | null;
    feeMinPayout: string | null;
    feeMaxPayout: string | null;
  },
  feeType: TransactionFeeType
): FeeScheduleRow {
  return {
    id: "legacy-merchant-pricing",
    billingMode: pricing.billingMode,
    feePercentage:
      feeType === "payin" ? pricing.feePercentagePayin : pricing.feePercentagePayout,
    feeFlat: "0",
    feeMin: feeType === "payin" ? pricing.feeMinPayin : pricing.feeMinPayout,
    feeMax: feeType === "payin" ? pricing.feeMaxPayin : pricing.feeMaxPayout,
  };
}
