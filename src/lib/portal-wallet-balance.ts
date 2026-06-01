/**
 * Portal dashboard: present merchant wallet rows as balance cards (per currency / region).
 */
import { z } from "zod";
import { LIMITS } from "./limits.js";
import { normalizeMoneyAmountToTwoDecimals } from "./money.js";

export const portalWalletLimitsSchema = z.object({
  payin: z.object({ min: z.number(), max: z.number() }),
  payout: z.object({ min: z.number(), max: z.number() }),
});

export const portalWalletBalanceItemSchema = z.object({
  id: z.string(),
  currency: z.string(),
  balance: z.string(),
  availableBalance: z.string(),
  pendingBalance: z.string(),
  status: z.string(),
  label: z.string().nullable(),
  displayLabel: z.string(),
  region: z.enum(["bangladesh", "india", "europe", "other"]),
  regionLabel: z.string(),
  lastUpdated: z.string().nullable(),
  updatedAt: z.string().nullable(),
  createdAt: z.string(),
  limits: portalWalletLimitsSchema,
});

export type PortalWalletBalanceItem = z.infer<typeof portalWalletBalanceItemSchema>;

export type PortalWalletRegion = PortalWalletBalanceItem["region"];

type PayinPayoutLimits = z.infer<typeof portalWalletLimitsSchema>;

export function merchantWalletRegionForCurrency(currency: string): PortalWalletRegion {
  const c = currency.trim().toUpperCase();
  if (c === "BDT") return "bangladesh";
  if (c === "INR" || c === "USDT") return "india";
  if (c === "USDC" || c === "EUR" || c === "GBP") return "europe";
  return "other";
}

export function merchantWalletRegionLabel(region: PortalWalletRegion, currency: string): string {
  const c = currency.trim().toUpperCase();
  switch (region) {
    case "bangladesh":
      return "Bangladesh";
    case "india":
      return c === "INR" ? "India (INR)" : "India (USDT)";
    case "europe":
      if (c === "USDC") return "Europe (USDC)";
      if (c === "EUR") return "Europe (EUR)";
      if (c === "GBP") return "Europe (GBP)";
      return `Europe (${c})`;
    default:
      return c || "Other";
  }
}

export function limitsForMerchantWalletCurrency(currency: string): PayinPayoutLimits {
  const c = currency.trim().toUpperCase();
  if (c === "BDT") {
    return { payin: { ...LIMITS.payin }, payout: { ...LIMITS.payout } };
  }
  if (c === "INR") {
    const l = LIMITS.tyltCrossRamp.INR;
    return { payin: { ...l }, payout: { ...l } };
  }
  if (c === "USDT") {
    const l = LIMITS.tyltCrossRamp.USDT;
    return { payin: { ...l }, payout: { ...l } };
  }
  if (c === "EUR" || c === "GBP") {
    const l = LIMITS.tyltEurOpenBanking[c];
    return { payin: { ...l }, payout: { ...l } };
  }
  if (c === "USDC") {
    const l = LIMITS.tyltEurOpenBanking.EUR;
    return { payin: { ...l }, payout: { ...l } };
  }
  return { payin: { ...LIMITS.payin }, payout: { ...LIMITS.payout } };
}

export function presentPortalWalletBalanceItem(
  row: {
    id: string;
    currency: string;
    balance: string;
    status: string;
    label: string | null;
    updatedAt: Date | null;
    createdAt: Date;
  },
  pendingByCurrency?: Map<string, string>
): PortalWalletBalanceItem {
  const balance = String(row.balance);
  const pendingRaw = pendingByCurrency?.get(row.currency.trim().toUpperCase()) ?? "0";
  const pendingBalance = normalizeMoneyAmountToTwoDecimals(pendingRaw);
  const region = merchantWalletRegionForCurrency(row.currency);
  const displayLabel = row.label?.trim() || merchantWalletRegionLabel(region, row.currency);
  const lastUpdated = row.updatedAt?.toISOString() ?? null;

  return {
    id: row.id,
    currency: row.currency,
    balance,
    availableBalance: balance,
    pendingBalance,
    status: row.status,
    label: row.label ?? null,
    displayLabel,
    region,
    regionLabel: merchantWalletRegionLabel(region, row.currency),
    lastUpdated,
    updatedAt: lastUpdated,
    createdAt: row.createdAt.toISOString(),
    limits: limitsForMerchantWalletCurrency(row.currency),
  };
}

/** Primary wallet card: BDT-first, then currency, then id (matches legacy `/portal/me/balance`). */
export function pickPrimaryPortalWalletItem(
  items: PortalWalletBalanceItem[]
): PortalWalletBalanceItem | null {
  if (items.length === 0) return null;
  const sorted = [...items].sort((a, b) => {
    const aBdt = a.currency.toUpperCase() === "BDT" ? 0 : 1;
    const bBdt = b.currency.toUpperCase() === "BDT" ? 0 : 1;
    if (aBdt !== bBdt) return aBdt - bBdt;
    const cur = a.currency.localeCompare(b.currency);
    if (cur !== 0) return cur;
    return a.id.localeCompare(b.id);
  });
  return sorted[0] ?? null;
}
