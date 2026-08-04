/**
 * Per-market entitlements and KYB (Bangladesh / India / Europe).
 * Wallets are settlement pockets; markets control which rails a merchant may use.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { merchantMarkets, merchants, wallets } from "../db/schema/index.js";
import { audit } from "./audit.js";
import {
  limitsForMerchantWalletCurrency,
  merchantWalletRegionForCurrency,
  merchantWalletRegionLabel,
  type PortalWalletBalanceItem,
  type PortalWalletRegion,
} from "./portal-wallet-balance.js";
import { normalizeMoneyAmountToTwoDecimals } from "./money.js";
import { getOrCreateMerchantWallet } from "../../services/integrations/tylt/crossramp-payin.js";

export const MERCHANT_MARKETS = ["bangladesh", "india", "europe", "brazil", "pyusd"] as const;
export type MerchantMarket = (typeof MERCHANT_MARKETS)[number];

export const MARKET_ENTITLEMENT_STATUSES = [
  "disabled",
  "requested",
  "kyb_in_review",
  "approved",
  "suspended",
] as const;
export type MarketEntitlementStatus = (typeof MARKET_ENTITLEMENT_STATUSES)[number];

export const MARKET_KYB_STATUSES = ["not_started", "pending", "verified", "rejected"] as const;
export type MarketKybStatus = (typeof MARKET_KYB_STATUSES)[number];

export const WALLET_ACTIVATION_STATUSES = [
  "active",
  "not_enabled",
  "pending_kyb",
  "suspended",
] as const;
export type WalletActivationStatus = (typeof WALLET_ACTIVATION_STATUSES)[number];

/** Settlement currencies provisioned when a market is approved. */
export const MARKET_SETTLEMENT_CURRENCIES: Record<MerchantMarket, readonly string[]> = {
  bangladesh: ["BDT"],
  india: ["USDT"],
  europe: ["USDC"],
  brazil: ["BRL"],
  /** PYUSD checkout settles to the merchant USDC pocket (shared with europe wallet row). */
  pyusd: ["USDC"],
};

export function marketForCurrency(currency: string): MerchantMarket | null {
  const region = merchantWalletRegionForCurrency(currency);
  if (region === "bangladesh") return "bangladesh";
  if (region === "india") return "india";
  if (region === "europe") return "europe";
  if (region === "brazil") return "brazil";
  return null;
}

export function isMerchantMarket(value: string): value is MerchantMarket {
  return (MERCHANT_MARKETS as readonly string[]).includes(value);
}

export type MerchantMarketRow = {
  market: MerchantMarket;
  entitlementStatus: MarketEntitlementStatus;
  kybStatus: MarketKybStatus;
  requestedAt: Date | null;
  approvedAt: Date | null;
};

function parseEntitlementStatus(raw: string): MarketEntitlementStatus {
  if ((MARKET_ENTITLEMENT_STATUSES as readonly string[]).includes(raw)) {
    return raw as MarketEntitlementStatus;
  }
  return "disabled";
}

function parseKybStatus(raw: string): MarketKybStatus {
  if ((MARKET_KYB_STATUSES as readonly string[]).includes(raw)) {
    return raw as MarketKybStatus;
  }
  return "not_started";
}

export async function ensureMerchantMarkets(merchantId: string): Promise<void> {
  const existing = await db
    .select({ market: merchantMarkets.market })
    .from(merchantMarkets)
    .where(eq(merchantMarkets.merchantId, merchantId));

  const have = new Set(existing.map((r) => r.market));
  const missing = MERCHANT_MARKETS.filter((m) => !have.has(m));
  if (missing.length === 0) return;

  await db.insert(merchantMarkets).values(
    missing.map((market) => ({
      merchantId,
      market,
      entitlementStatus: "disabled",
      kybStatus: "not_started",
    }))
  );
}

export async function listMerchantMarkets(merchantId: string): Promise<MerchantMarketRow[]> {
  await ensureMerchantMarkets(merchantId);
  const rows = await db
    .select({
      market: merchantMarkets.market,
      entitlementStatus: merchantMarkets.entitlementStatus,
      kybStatus: merchantMarkets.kybStatus,
      requestedAt: merchantMarkets.requestedAt,
      approvedAt: merchantMarkets.approvedAt,
    })
    .from(merchantMarkets)
    .where(eq(merchantMarkets.merchantId, merchantId));

  const byMarket = new Map(rows.map((r) => [r.market, r]));
  return MERCHANT_MARKETS.map((market) => {
    const row = byMarket.get(market);
    return {
      market,
      entitlementStatus: parseEntitlementStatus(row?.entitlementStatus ?? "disabled"),
      kybStatus: parseKybStatus(row?.kybStatus ?? "not_started"),
      requestedAt: row?.requestedAt ?? null,
      approvedAt: row?.approvedAt ?? null,
    };
  });
}

function walletActivationForMarket(market: MerchantMarketRow): WalletActivationStatus {
  if (market.entitlementStatus === "suspended") return "suspended";
  if (market.entitlementStatus === "approved") {
    if (market.kybStatus === "verified") return "active";
    return "pending_kyb";
  }
  if (market.entitlementStatus === "requested" || market.entitlementStatus === "kyb_in_review") {
    return "pending_kyb";
  }
  return "not_enabled";
}

export async function provisionSettlementWalletsForMarket(
  merchantId: string,
  market: MerchantMarket
): Promise<void> {
  const currencies = MARKET_SETTLEMENT_CURRENCIES[market];
  for (const environment of ["test", "live"] as const) {
    for (const currency of currencies) {
      await getOrCreateMerchantWallet({ merchantId, environment, currency });
    }
  }
}

export async function requestMerchantMarket(merchantId: string, market: MerchantMarket): Promise<MerchantMarketRow> {
  await ensureMerchantMarkets(merchantId);
  const now = new Date();
  const [global] = await db
    .select({ kycStatus: merchants.kycStatus })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);

  const nextKyb: MarketKybStatus =
    global?.kycStatus === "verified" ? "pending" : "not_started";

  await db
    .update(merchantMarkets)
    .set({
      entitlementStatus: "requested",
      kybStatus: nextKyb,
      requestedAt: now,
      updatedAt: now,
    })
    .where(and(eq(merchantMarkets.merchantId, merchantId), eq(merchantMarkets.market, market)));

  audit({
    action: "merchant.market.requested",
    resource: merchantId,
    merchantId,
    meta: { market },
  });

  const rows = await listMerchantMarkets(merchantId);
  return rows.find((r) => r.market === market)!;
}

export async function setMerchantMarketByProvider(params: {
  merchantId: string;
  market: MerchantMarket;
  entitlementStatus?: MarketEntitlementStatus;
  kybStatus?: MarketKybStatus;
  actor?: string;
}): Promise<MerchantMarketRow> {
  await ensureMerchantMarkets(params.merchantId);
  const now = new Date();
  const patch: Partial<typeof merchantMarkets.$inferInsert> = { updatedAt: now };

  if (params.entitlementStatus) {
    patch.entitlementStatus = params.entitlementStatus;
    if (params.entitlementStatus === "approved") {
      patch.approvedAt = now;
      if (!params.kybStatus) {
        const [global] = await db
          .select({ kycStatus: merchants.kycStatus })
          .from(merchants)
          .where(eq(merchants.id, params.merchantId))
          .limit(1);
        if (global?.kycStatus === "verified") {
          patch.kybStatus = "verified";
        }
      }
    }
    if (params.entitlementStatus === "disabled") {
      patch.approvedAt = null;
    }
  }
  if (params.kybStatus) {
    patch.kybStatus = params.kybStatus;
  }

  await db
    .update(merchantMarkets)
    .set(patch)
    .where(
      and(eq(merchantMarkets.merchantId, params.merchantId), eq(merchantMarkets.market, params.market))
    );

  const row = (await listMerchantMarkets(params.merchantId)).find((r) => r.market === params.market)!;

  if (params.entitlementStatus === "approved") {
    await provisionSettlementWalletsForMarket(params.merchantId, params.market);
  }

  audit({
    action: "provider.merchant.market_updated",
    actor: params.actor ?? "provider",
    resource: params.merchantId,
    merchantId: params.merchantId,
    meta: {
      market: params.market,
      entitlementStatus: row.entitlementStatus,
      kybStatus: row.kybStatus,
    },
  });

  return row;
}

export type MerchantMarketApiAccessResult =
  | { ok: true }
  | {
      ok: false;
      market: MerchantMarket;
      code: "market_not_enabled" | "market_kyb_required" | "market_suspended";
      message: string;
    };

export async function assertMerchantMarketApiAccess(params: {
  merchantId: string;
  market: MerchantMarket;
  kycRequired: boolean;
}): Promise<MerchantMarketApiAccessResult> {
  const markets = await listMerchantMarkets(params.merchantId);
  const row = markets.find((m) => m.market === params.market);
  if (!row) {
    return {
      ok: false,
      market: params.market,
      code: "market_not_enabled",
      message: `Payment market "${params.market}" is not available on this account.`,
    };
  }

  if (row.entitlementStatus === "suspended") {
    return {
      ok: false,
      market: params.market,
      code: "market_suspended",
      message: `Payment market "${params.market}" is suspended. Contact support.`,
    };
  }

  if (row.entitlementStatus !== "approved") {
    return {
      ok: false,
      market: params.market,
      code: "market_not_enabled",
      message: `Payment market "${params.market}" is not enabled. Request activation in the merchant portal.`,
    };
  }

  if (params.kycRequired) {
    const [global] = await db
      .select({ kycStatus: merchants.kycStatus })
      .from(merchants)
      .where(eq(merchants.id, params.merchantId))
      .limit(1);
    const globalOk = global?.kycStatus === "verified";
    const marketOk = row.kybStatus === "verified";
    if (!globalOk && !marketOk) {
      return {
        ok: false,
        market: params.market,
        code: "market_kyb_required",
        message: `KYB for "${params.market}" is required before using this rail.`,
      };
    }
  }

  return { ok: true };
}

function syntheticWalletId(market: MerchantMarket, currency: string): string {
  return `market:${market}:${currency.trim().toUpperCase()}`;
}

type WalletRow = {
  id: string;
  currency: string;
  balance: string;
  status: string;
  label: string | null;
  updatedAt: Date | null;
  createdAt: Date;
};

function presentSlot(params: {
  market: MerchantMarketRow;
  currency: string;
  environment: "test" | "live";
  wallet: WalletRow | null;
  pendingByCurrency: Map<string, string>;
}): PortalWalletBalanceItem {
  const { market, currency, wallet } = params;
  const region = merchantWalletRegionForCurrency(currency) as PortalWalletRegion;
  const activationStatus = walletActivationForMarket(market);
  const walletActivated = wallet != null && activationStatus === "active";

  const balance = wallet ? String(wallet.balance) : "0.00";
  const pendingRaw = wallet
    ? (params.pendingByCurrency.get(currency.trim().toUpperCase()) ?? "0")
    : "0";
  const pendingBalance = normalizeMoneyAmountToTwoDecimals(pendingRaw);
  const lastUpdated = wallet?.updatedAt?.toISOString() ?? null;
  const displayLabel = wallet?.label?.trim() || merchantWalletRegionLabel(region, currency);

  return {
    id: wallet?.id ?? syntheticWalletId(market.market, currency),
    currency,
    balance,
    availableBalance: balance,
    pendingBalance,
    status: wallet?.status ?? (activationStatus === "active" ? "active" : "inactive"),
    label: wallet?.label ?? null,
    displayLabel,
    region,
    regionLabel: merchantWalletRegionLabel(region, currency),
    lastUpdated,
    updatedAt: lastUpdated,
    createdAt: (wallet?.createdAt ?? new Date(0)).toISOString(),
    limits: limitsForMerchantWalletCurrency(currency),
    market: market.market,
    entitlementStatus: market.entitlementStatus,
    kybStatus: market.kybStatus,
    activationStatus,
    walletActivated,
  };
}

/** Portal balance cards: all markets × settlement currencies, merged with DB wallets. */
export async function buildPortalWalletCatalog(params: {
  merchantId: string;
  environment: "test" | "live";
  pendingByCurrency: Map<string, string>;
}): Promise<PortalWalletBalanceItem[]> {
  const markets = await listMerchantMarkets(params.merchantId);
  const currencies = markets.flatMap((m) =>
    MARKET_SETTLEMENT_CURRENCIES[m.market].map((currency) => ({ market: m, currency }))
  );

  const currencyList = [...new Set(currencies.map((c) => c.currency.trim().toUpperCase()))];
  const walletRows =
    currencyList.length === 0
      ? []
      : await db
          .select({
            id: wallets.id,
            currency: wallets.currency,
            balance: wallets.balance,
            status: wallets.status,
            label: wallets.label,
            updatedAt: wallets.updatedAt,
            createdAt: wallets.createdAt,
          })
          .from(wallets)
          .where(
            and(
              eq(wallets.merchantId, params.merchantId),
              eq(wallets.environment, params.environment),
              eq(wallets.type, "merchant"),
              eq(wallets.status, "active"),
              inArray(wallets.currency, currencyList)
            )
          );

  const walletByCurrency = new Map(
    walletRows.map((w) => [w.currency.trim().toUpperCase(), w as WalletRow])
  );

  const items: PortalWalletBalanceItem[] = [];
  const seenCurrencies = new Set<string>();
  for (const { market, currency } of currencies) {
    const key = currency.trim().toUpperCase();
    // europe + pyusd both settle USDC — one balance card per currency.
    if (seenCurrencies.has(key)) continue;
    seenCurrencies.add(key);
    const w = walletByCurrency.get(key) ?? null;
    items.push(
      presentSlot({
        market,
        currency,
        environment: params.environment,
        wallet: w,
        pendingByCurrency: params.pendingByCurrency,
      })
    );
  }

  return items.sort((a, b) => {
    const order: Record<string, number> = {
      bangladesh: 0,
      india: 1,
      europe: 2,
      brazil: 3,
      pyusd: 4,
      other: 5,
    };
    const am = order[a.market] ?? 5;
    const bm = order[b.market] ?? 5;
    if (am !== bm) return am - bm;
    return a.currency.localeCompare(b.currency);
  });
}

export function filterBalanceItemsToApprovedMarkets(
  items: PortalWalletBalanceItem[]
): PortalWalletBalanceItem[] {
  return items.filter((i) => i.activationStatus === "active" && i.walletActivated);
}
