/**
 * Per-rail money overview for merchant portal dashboards.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { transactions } from "../db/schema/index.js";
import {
  buildMerchantMarketBoard,
  MARKET_DISPLAY_NAMES,
  MARKET_SETTLEMENT_CURRENCIES,
  type MerchantMarket,
  type MerchantMarketBoardRow,
} from "./merchant-markets.js";

export type MoneyRailCapabilities = {
  canCreatePayin: boolean;
  canCreatePayout: boolean;
  payinPath: string | null;
  payoutPath: string | null;
  statusPath: string | null;
  integrationHint: string | null;
};

const RAIL_CAPABILITIES: Record<MerchantMarket, MoneyRailCapabilities> = {
  bangladesh: {
    canCreatePayin: true,
    canCreatePayout: true,
    payinPath: "/portal/me/payins",
    payoutPath: "/portal/me/payouts",
    statusPath: null,
    integrationHint: null,
  },
  brazil: {
    canCreatePayin: true,
    canCreatePayout: true,
    payinPath: "/portal/me/br/payins",
    payoutPath: "/portal/me/br/payouts",
    statusPath: null,
    integrationHint: null,
  },
  india: {
    canCreatePayin: true,
    canCreatePayout: true,
    payinPath: "/portal/me/h2h/payin-instances",
    payoutPath: "/portal/me/cpg/payout-requests",
    statusPath: "/portal/me/h2h/payin-instances/:transactionId",
    integrationHint: null,
  },
  europe: {
    canCreatePayin: false,
    canCreatePayout: true,
    payinPath: null,
    payoutPath: "/portal/me/eur/payout-instances",
    statusPath: "/portal/me/eur/payout-instances/:transactionId",
    integrationHint: "Europe pay-in remains on HMAC /v1/eur/payin-instances",
  },
  pyusd: {
    canCreatePayin: true,
    canCreatePayout: false,
    payinPath: "/portal/me/pyusd/payment-intents",
    payoutPath: null,
    statusPath: "/portal/me/pyusd/payment-intents/:transactionId",
    integrationHint: null,
  },
};

function providerSqlForMarket(market: MerchantMarket) {
  switch (market) {
    case "bangladesh":
      return sql`${transactions.provider} like 'payok-bd%'`;
    case "brazil":
      return sql`${transactions.provider} like 'payok-br%'`;
    case "india":
      return sql`(${transactions.provider} like 'tylt%' and ${transactions.provider} not like 'tylt-eur%')`;
    case "europe":
      return sql`${transactions.provider} like 'tylt-eur%'`;
    case "pyusd":
      return sql`${transactions.provider} = 'tekko-pyusd-payin'`;
  }
}

export type MoneyOverviewRail = {
  market: MerchantMarket;
  displayName: string;
  ready: boolean;
  unlockReason: string | null;
  settlementCurrencies: string[];
  counts: {
    payin: { pending: number; success: number; failed: number; total: number };
    payout: { pending: number; success: number; failed: number; total: number };
  };
  capabilities: MoneyRailCapabilities;
  transactionsQuery: string;
};

function emptyCounts() {
  return {
    payin: { pending: 0, success: 0, failed: 0, total: 0 },
    payout: { pending: 0, success: 0, failed: 0, total: 0 },
  };
}

export async function buildPortalMoneyOverview(params: {
  merchantId: string;
  environment: "test" | "live";
}): Promise<{
  environment: "test" | "live";
  globalKycStatus: string;
  rails: MoneyOverviewRail[];
}> {
  const board = await buildMerchantMarketBoard({
    merchantId: params.merchantId,
    environment: params.environment,
  });

  const countRows = await db
    .select({
      provider: transactions.provider,
      type: transactions.type,
      status: transactions.status,
      n: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.merchantId, params.merchantId),
        eq(transactions.environment, params.environment)
      )
    )
    .groupBy(transactions.provider, transactions.type, transactions.status);

  const byMarket = new Map<MerchantMarket, ReturnType<typeof emptyCounts>>();
  for (const market of Object.keys(RAIL_CAPABILITIES) as MerchantMarket[]) {
    byMarket.set(market, emptyCounts());
  }

  for (const row of countRows) {
    const provider = row.provider ?? "";
    let market: MerchantMarket | null = null;
    if (provider.startsWith("payok-bd")) market = "bangladesh";
    else if (provider.startsWith("payok-br")) market = "brazil";
    else if (provider.startsWith("tylt-eur")) market = "europe";
    else if (provider === "tekko-pyusd-payin") market = "pyusd";
    else if (provider.startsWith("tylt")) market = "india";
    if (!market) continue;
    if (row.type !== "payin" && row.type !== "payout") continue;
    const bucket = byMarket.get(market)!;
    const side = bucket[row.type as "payin" | "payout"];
    const n = Number(row.n ?? 0);
    if (row.status === "pending") side.pending += n;
    else if (row.status === "success") side.success += n;
    else if (row.status === "failed") side.failed += n;
    side.total += n;
  }

  const rails: MoneyOverviewRail[] = board.items.map((m: MerchantMarketBoardRow) => {
    const caps = { ...RAIL_CAPABILITIES[m.market] };
    // Gate create flags on market readiness
    if (!m.ready) {
      caps.canCreatePayin = false;
      caps.canCreatePayout = false;
    }
    return {
      market: m.market,
      displayName: MARKET_DISPLAY_NAMES[m.market],
      ready: m.ready,
      unlockReason: m.unlockReason,
      settlementCurrencies: [...MARKET_SETTLEMENT_CURRENCIES[m.market]],
      counts: byMarket.get(m.market) ?? emptyCounts(),
      capabilities: caps,
      transactionsQuery: `rail=${m.market}`,
    };
  });

  return {
    environment: params.environment,
    globalKycStatus: board.globalKycStatus,
    rails,
  };
}

/** Exported for tests — rail provider predicate presence. */
export function moneyOverviewProviderPredicate(market: MerchantMarket) {
  return providerSqlForMarket(market);
}
