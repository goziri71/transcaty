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
import { isBangladeshPaymentsPaused } from "./bangladesh-rail-pause.js";
import { PLATFORM_MERCHANT_ID } from "./billing/platform-wallet.js";
import {
  PYUSD_SETTLEMENT_CURRENCY,
  PYUSD_SETTLEMENT_DISPLAY_NAME,
} from "./pyusd-settlement.js";

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
  /** Tekko PYUSD proceeds — not the Europe Tylt USDC pocket. */
  pyusd: [PYUSD_SETTLEMENT_CURRENCY],
};

export function marketForCurrency(currency: string): MerchantMarket | null {
  const region = merchantWalletRegionForCurrency(currency);
  if (region === "bangladesh") return "bangladesh";
  if (region === "india") return "india";
  if (region === "europe") return "europe";
  if (region === "brazil") return "brazil";
  if (region === "pyusd") return "pyusd";
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

export function walletActivationForMarket(market: MerchantMarketRow): WalletActivationStatus {
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

const WALLET_ACTIVATION_RANK: Record<WalletActivationStatus, number> = {
  active: 0,
  pending_kyb: 1,
  suspended: 2,
  not_enabled: 3,
};

/**
 * Pick the market card that owns a settlement currency. After the PYUSD split,
 * USDC is Europe-only and PYUSD-USDC is PYUSD-only. If two markets ever settle
 * the same code, prefer the more usable entitlement.
 */
export function pickOwningMarketForSharedCurrency(
  markets: MerchantMarketRow[],
  currency: string
): MerchantMarketRow | null {
  const key = currency.trim().toUpperCase();
  const owners = markets.filter((m) =>
    MARKET_SETTLEMENT_CURRENCIES[m.market].some((c) => c.trim().toUpperCase() === key)
  );
  if (owners.length === 0) return null;
  return [...owners].sort((a, b) => {
    const rankA = WALLET_ACTIVATION_RANK[walletActivationForMarket(a)];
    const rankB = WALLET_ACTIVATION_RANK[walletActivationForMarket(b)];
    if (rankA !== rankB) return rankA - rankB;
    return MERCHANT_MARKETS.indexOf(a.market) - MERCHANT_MARKETS.indexOf(b.market);
  })[0]!;
}

export const MARKET_DISPLAY_NAMES: Record<MerchantMarket, string> = {
  bangladesh: "Bangladesh",
  india: "India",
  europe: "Europe",
  brazil: "Brazil",
  pyusd: "PYUSD",
};

export const MARKET_BLOCKER_CODES = [
  "not_requested",
  "awaiting_review",
  "kyb_pending",
  "kyb_rejected",
  "global_kyc_pending",
  "suspended",
  "wallet_not_provisioned",
  "provider_unavailable",
] as const;
export type MarketBlockerCode = (typeof MARKET_BLOCKER_CODES)[number];

export type MarketBlocker = { code: MarketBlockerCode; message: string };

export type MerchantMarketBoardRow = MerchantMarketRow & {
  displayName: string;
  activationStatus: WalletActivationStatus;
  canRequest: boolean;
  ready: boolean;
  unlockReason: string | null;
  blockers: MarketBlocker[];
  settlementCurrencies: string[];
  walletsProvisioned: boolean;
};

function pushBlocker(blockers: MarketBlocker[], code: MarketBlockerCode, message: string): void {
  if (blockers.some((b) => b.code === code)) return;
  blockers.push({ code, message });
}

/** Derive dashboard blockers / unlock copy for one market. */
export function deriveMarketBoardFields(params: {
  market: MerchantMarketRow;
  globalKycStatus: string;
  walletsProvisioned: boolean;
}): Pick<
  MerchantMarketBoardRow,
  | "displayName"
  | "activationStatus"
  | "canRequest"
  | "ready"
  | "unlockReason"
  | "blockers"
  | "settlementCurrencies"
  | "walletsProvisioned"
> {
  const { market, globalKycStatus, walletsProvisioned } = params;
  const displayName = MARKET_DISPLAY_NAMES[market.market];
  const activationStatus = walletActivationForMarket(market);
  const settlementCurrencies = [...MARKET_SETTLEMENT_CURRENCIES[market.market]];
  const blockers: MarketBlocker[] = [];
  const globalKycOk = globalKycStatus === "verified";

  if (market.entitlementStatus === "suspended") {
    pushBlocker(blockers, "suspended", `${displayName} is suspended. Contact support.`);
  } else if (market.entitlementStatus === "disabled") {
    pushBlocker(
      blockers,
      "not_requested",
      `${displayName} is not enabled. Request access to start activation.`
    );
  } else if (
    market.entitlementStatus === "requested" ||
    market.entitlementStatus === "kyb_in_review"
  ) {
    pushBlocker(
      blockers,
      "awaiting_review",
      `${displayName} access was requested and is waiting on Transacty review.`
    );
  }

  if (market.kybStatus === "rejected") {
    pushBlocker(
      blockers,
      "kyb_rejected",
      `${displayName} KYB was rejected. Update documents or contact support.`
    );
  } else if (
    market.entitlementStatus === "approved" &&
    market.kybStatus !== "verified" &&
    !globalKycOk
  ) {
    pushBlocker(
      blockers,
      "kyb_pending",
      `${displayName} KYB must be verified before this service is usable.`
    );
    if (globalKycStatus === "pending" || globalKycStatus === "rejected") {
      pushBlocker(
        blockers,
        "global_kyc_pending",
        "Complete account KYC activation before live rails unlock."
      );
    }
  } else if (
    market.entitlementStatus === "approved" &&
    market.kybStatus !== "verified" &&
    globalKycOk
  ) {
    // Global KYC verified usually unlocks market API; still surface pending market KYB for clarity.
    if (market.kybStatus === "pending" || market.kybStatus === "not_started") {
      pushBlocker(
        blockers,
        "kyb_pending",
        `${displayName} market KYB is still ${market.kybStatus.replace("_", " ")}.`
      );
    }
  }

  if (activationStatus === "active" && !walletsProvisioned) {
    pushBlocker(
      blockers,
      "wallet_not_provisioned",
      `${displayName} settlement wallet is not provisioned yet. Contact support.`
    );
  }

  if (market.market === "bangladesh" && isBangladeshPaymentsPaused()) {
    pushBlocker(
      blockers,
      "provider_unavailable",
      "Bangladesh pay-in and payout are temporarily unavailable. Existing balances and transfers still work."
    );
  }

  const canRequest = market.entitlementStatus === "disabled";
  const hardBlocked = blockers.some(
    (b) =>
      b.code === "suspended" ||
      b.code === "kyb_rejected" ||
      b.code === "not_requested" ||
      b.code === "awaiting_review" ||
      b.code === "wallet_not_provisioned" ||
      b.code === "global_kyc_pending" ||
      b.code === "provider_unavailable" ||
      (b.code === "kyb_pending" && !globalKycOk)
  );
  const ready =
    market.entitlementStatus === "approved" &&
    walletsProvisioned &&
    (market.kybStatus === "verified" || globalKycOk) &&
    market.kybStatus !== "rejected" &&
    !hardBlocked;

  const visibleBlockers = ready
    ? blockers.filter((b) => b.code === "kyb_pending")
    : blockers;

  return {
    displayName,
    activationStatus,
    canRequest,
    ready,
    unlockReason: ready ? null : (blockers[0]?.message ?? null),
    blockers: visibleBlockers,
    settlementCurrencies,
    walletsProvisioned,
  };
}

export async function getMerchantGlobalKycStatus(merchantId: string): Promise<string> {
  const [row] = await db
    .select({ kycStatus: merchants.kycStatus })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);
  return row?.kycStatus ?? "pending";
}

async function settlementWalletsExist(params: {
  merchantId: string;
  environment: "test" | "live";
  market: MerchantMarket;
}): Promise<boolean> {
  const currencies = MARKET_SETTLEMENT_CURRENCIES[params.market].map((c) => c.trim().toUpperCase());
  if (currencies.length === 0) return false;
  const rows = await db
    .select({ id: wallets.id, currency: wallets.currency })
    .from(wallets)
    .where(
      and(
        eq(wallets.merchantId, params.merchantId),
        eq(wallets.environment, params.environment),
        eq(wallets.type, "merchant"),
        eq(wallets.status, "active"),
        inArray(wallets.currency, currencies)
      )
    );
  const have = new Set(rows.map((r) => r.currency.trim().toUpperCase()));
  return currencies.every((c) => have.has(c));
}

export async function buildMerchantMarketBoard(params: {
  merchantId: string;
  environment?: "test" | "live";
}): Promise<{
  globalKycStatus: string;
  items: MerchantMarketBoardRow[];
}> {
  const environment = params.environment ?? "live";
  const [globalKycStatus, markets] = await Promise.all([
    getMerchantGlobalKycStatus(params.merchantId),
    listMerchantMarkets(params.merchantId),
  ]);

  const items: MerchantMarketBoardRow[] = [];
  for (const market of markets) {
    const walletsProvisioned = await settlementWalletsExist({
      merchantId: params.merchantId,
      environment,
      market: market.market,
    });
    const derived = deriveMarketBoardFields({
      market,
      globalKycStatus,
      walletsProvisioned,
    });
    items.push({ ...market, ...derived });
  }

  return { globalKycStatus, items };
}

export async function provisionSettlementWalletsForMarket(
  merchantId: string,
  market: MerchantMarket
): Promise<void> {
  const currencies = MARKET_SETTLEMENT_CURRENCIES[market];
  // Tekko PYUSD is live-only; do not create a test PYUSD-USDC pocket that can never be credited.
  const environments: Array<"test" | "live"> = market === "pyusd" ? ["live"] : ["test", "live"];
  for (const environment of environments) {
    for (const currency of currencies) {
      const wallet = await getOrCreateMerchantWallet({ merchantId, environment, currency });
      if (
        currency === PYUSD_SETTLEMENT_CURRENCY &&
        (wallet.label == null || wallet.label.trim() === "")
      ) {
        await db
          .update(wallets)
          .set({ label: PYUSD_SETTLEMENT_DISPLAY_NAME, updatedAt: new Date() })
          .where(eq(wallets.id, wallet.id));
      }
    }
  }
  if (market === "pyusd") {
    try {
      await getOrCreateMerchantWallet({
        merchantId: PLATFORM_MERCHANT_ID,
        environment: "live",
        currency: PYUSD_SETTLEMENT_CURRENCY,
      });
    } catch {
      // Merchant pocket still works; fee apply skips if the platform row is missing.
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
  globalKycStatus: string;
}): PortalWalletBalanceItem {
  const { market, currency, wallet } = params;
  const region =
    market.market === "pyusd"
      ? ("pyusd" as PortalWalletRegion)
      : (merchantWalletRegionForCurrency(currency) as PortalWalletRegion);
  const activationStatus = walletActivationForMarket(market);
  const walletActivated = wallet != null && activationStatus === "active";
  const derived = deriveMarketBoardFields({
    market,
    globalKycStatus: params.globalKycStatus,
    walletsProvisioned: wallet != null,
  });

  const balance = wallet ? String(wallet.balance) : "0.00";
  const pendingRaw = wallet
    ? (params.pendingByCurrency.get(currency.trim().toUpperCase()) ?? "0")
    : "0";
  const pendingBalance = normalizeMoneyAmountToTwoDecimals(pendingRaw);
  const lastUpdated = wallet?.updatedAt?.toISOString() ?? null;
  const displayLabel =
    wallet?.label?.trim() || merchantWalletRegionLabel(region, currency);

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
    unlockReason: derived.ready ? null : derived.unlockReason,
    blockers: derived.ready ? [] : derived.blockers,
  };
}

/** Portal balance cards: all markets × settlement currencies, merged with DB wallets. */
export async function buildPortalWalletCatalog(params: {
  merchantId: string;
  environment: "test" | "live";
  pendingByCurrency: Map<string, string>;
  globalKycStatus?: string;
}): Promise<PortalWalletBalanceItem[]> {
  const markets = await listMerchantMarkets(params.merchantId);
  const pyusdMarket = markets.find((m) => m.market === "pyusd");
  if (pyusdMarket?.entitlementStatus === "approved") {
    await provisionSettlementWalletsForMarket(params.merchantId, "pyusd");
  }
  const globalKycStatus =
    params.globalKycStatus ?? (await getMerchantGlobalKycStatus(params.merchantId));
  const currencyList = [
    ...new Set(
      markets.flatMap((m) => MARKET_SETTLEMENT_CURRENCIES[m.market].map((c) => c.trim().toUpperCase()))
    ),
  ];
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
  for (const key of currencyList) {
    const market = pickOwningMarketForSharedCurrency(markets, key);
    if (!market) continue;
    const w = walletByCurrency.get(key) ?? null;
    items.push(
      presentSlot({
        market,
        currency: key,
        environment: params.environment,
        wallet: w,
        pendingByCurrency: params.pendingByCurrency,
        globalKycStatus,
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

export async function buildMerchantServicesBoard(params: {
  merchantId: string;
  environment: "test" | "live";
  pendingByCurrency: Map<string, string>;
}): Promise<{
  environment: "test" | "live";
  globalKycStatus: string;
  markets: MerchantMarketBoardRow[];
  wallets: PortalWalletBalanceItem[];
}> {
  const { globalKycStatus, items: markets } = await buildMerchantMarketBoard({
    merchantId: params.merchantId,
    environment: params.environment,
  });
  const wallets = await buildPortalWalletCatalog({
    merchantId: params.merchantId,
    environment: params.environment,
    pendingByCurrency: params.pendingByCurrency,
    globalKycStatus,
  });

  return {
    environment: params.environment,
    globalKycStatus,
    markets,
    wallets,
  };
}

export function filterBalanceItemsToApprovedMarkets(
  items: PortalWalletBalanceItem[]
): PortalWalletBalanceItem[] {
  return items.filter((i) => i.activationStatus === "active" && i.walletActivated);
}
