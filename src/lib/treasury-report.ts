/**
 * Treasury overview aggregation for the provider/admin dashboard.
 *
 * Reports what the ledger can state ACCURATELY today: retained earnings held in
 * the platform wallets (per currency), gross platform revenue (platform_fee +
 * monthly_fee credits) over a period, processed volume, and a gross take-rate.
 *
 * Deliberately honest about what is NOT yet computable: net margin needs
 * provider cost (PayOK transFee / Tylt rate), which is not persisted today, and
 * FX spread is not yet ledgered. Those show up as `disclosures` flags so the UI
 * can label the numbers "gross, not net". See docs/TREASURY_MANAGEMENT_RESEARCH.md.
 */
import { and, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { wallets, ledgerEntries, transactions } from "../db/schema/index.js";
import { PLATFORM_MERCHANT_ID } from "./billing/platform-wallet.js";
import { providerToFeeRail } from "./billing/fee-rail.js";
import { addAmount } from "./money.js";

export type TreasuryEnv = "test" | "live";

export interface TreasuryOverviewParams {
  environment: TreasuryEnv;
  from: Date;
  to: Date;
}

export interface PlatformBalanceItem {
  currency: string;
  /** Current retained earnings held in the platform wallet (lifetime; no sweeps exist yet). */
  balance: string;
}

export interface RevenueByCurrencyItem {
  currency: string;
  platformFee: string;
  monthlyFee: string;
  total: string;
}

export interface VolumeByKeyItem {
  /** currency (byCurrency) or rail name (byRail) */
  key: string;
  payin: string;
  payout: string;
  total: string;
}

export interface TakeRateItem {
  currency: string;
  revenue: string;
  volume: string;
  /** Gross take rate in basis points (revenue / volume × 10000); null when volume is 0. */
  takeRateBps: number | null;
}

export interface TreasuryLiquidityBucket {
  currency: string;
  amount: string;
  count: number;
}

export interface TreasuryOverview {
  environment: TreasuryEnv;
  from: string;
  to: string;
  platformBalances: PlatformBalanceItem[];
  revenue: {
    byCurrency: RevenueByCurrencyItem[];
  };
  volume: {
    byCurrency: VolumeByKeyItem[];
    byRail: VolumeByKeyItem[];
  };
  takeRate: TakeRateItem[];
  /** Ledger-only liquidity snapshot (no upstream provider float). */
  liquidity: {
    pendingPayinByCurrency: TreasuryLiquidityBucket[];
    pendingPayoutByCurrency: TreasuryLiquidityBucket[];
    merchantBalancesByCurrency: TreasuryLiquidityBucket[];
    note: string;
  };
  disclosures: {
    /** Revenue is GROSS (before provider cost). */
    basis: "gross";
    /** True once provider cost (PayOK transFee / Tylt rate) is persisted and net margin is computable. */
    netMarginAvailable: boolean;
    /** True once provider cost is captured per transaction. */
    providerCostTracked: boolean;
    /** True once the FX spread is posted to the ledger as platform revenue. */
    fxSpreadLedgered: boolean;
    note: string;
  };
}

function norm(currency: string): string {
  return currency.trim().toUpperCase() || "UNKNOWN";
}

function toNum(s: string | null | undefined): number {
  const n = Number(s ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export async function buildTreasuryOverview(params: TreasuryOverviewParams): Promise<TreasuryOverview> {
  const { environment, from, to } = params;

  // 1. Platform wallets = where retained earnings sit, per currency.
  const platformWalletRows = await db
    .select({ id: wallets.id, currency: wallets.currency, balance: wallets.balance })
    .from(wallets)
    .where(
      and(
        eq(wallets.merchantId, PLATFORM_MERCHANT_ID),
        eq(wallets.environment, environment),
        eq(wallets.type, "merchant"),
        eq(wallets.status, "active")
      )
    );

  const currencyByWalletId = new Map<string, string>();
  const platformBalances: PlatformBalanceItem[] = platformWalletRows
    .map((w) => {
      currencyByWalletId.set(w.id, norm(w.currency));
      return { currency: norm(w.currency), balance: String(w.balance) };
    })
    .sort((a, b) => a.currency.localeCompare(b.currency));

  // 2. Gross revenue = platform_fee + monthly_fee CREDITS to the platform wallets in range.
  const walletIds = platformWalletRows.map((w) => w.id);
  const revenueByCurrency = new Map<string, { platformFee: string; monthlyFee: string }>();
  if (walletIds.length > 0) {
    const revRows = await db
      .select({
        walletId: ledgerEntries.walletId,
        type: ledgerEntries.type,
        total: sql<string>`sum(${ledgerEntries.amount})`,
      })
      .from(ledgerEntries)
      .where(
        and(
          inArray(ledgerEntries.walletId, walletIds),
          eq(ledgerEntries.direction, "credit"),
          inArray(ledgerEntries.type, ["platform_fee", "monthly_fee"]),
          eq(ledgerEntries.environment, environment),
          gte(ledgerEntries.createdAt, from),
          lt(ledgerEntries.createdAt, to)
        )
      )
      .groupBy(ledgerEntries.walletId, ledgerEntries.type);

    for (const r of revRows) {
      const currency = currencyByWalletId.get(r.walletId) ?? "UNKNOWN";
      const bucket = revenueByCurrency.get(currency) ?? { platformFee: "0", monthlyFee: "0" };
      const amt = String(r.total ?? "0");
      if (r.type === "platform_fee") bucket.platformFee = addAmount(bucket.platformFee, amt);
      else if (r.type === "monthly_fee") bucket.monthlyFee = addAmount(bucket.monthlyFee, amt);
      revenueByCurrency.set(currency, bucket);
    }
  }

  const revenue = {
    byCurrency: [...revenueByCurrency.entries()]
      .map(([currency, b]) => ({
        currency,
        platformFee: b.platformFee,
        monthlyFee: b.monthlyFee,
        total: addAmount(b.platformFee, b.monthlyFee),
      }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
  };

  // 3. Processed volume (successful pay-in/payout) in range — by currency and by rail.
  const volRows = await db
    .select({
      currency: transactions.currency,
      type: transactions.type,
      provider: transactions.provider,
      total: sql<string>`sum(case when ${transactions.type} = 'payin' and ${transactions.paidAmount} is not null then ${transactions.paidAmount} else ${transactions.amount} end)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.environment, environment),
        eq(transactions.status, "success"),
        inArray(transactions.type, ["payin", "payout"]),
        gte(transactions.createdAt, from),
        lt(transactions.createdAt, to)
      )
    )
    .groupBy(transactions.currency, transactions.type, transactions.provider);

  const volByCurrency = new Map<string, { payin: string; payout: string }>();
  const volByRail = new Map<string, { payin: string; payout: string }>();
  for (const r of volRows) {
    const currency = norm(r.currency);
    const rail = providerToFeeRail(r.provider, currency);
    const amt = String(r.total ?? "0");
    const c = volByCurrency.get(currency) ?? { payin: "0", payout: "0" };
    const rl = volByRail.get(rail) ?? { payin: "0", payout: "0" };
    if (r.type === "payin") {
      c.payin = addAmount(c.payin, amt);
      rl.payin = addAmount(rl.payin, amt);
    } else {
      c.payout = addAmount(c.payout, amt);
      rl.payout = addAmount(rl.payout, amt);
    }
    volByCurrency.set(currency, c);
    volByRail.set(rail, rl);
  }

  const toVolItems = (m: Map<string, { payin: string; payout: string }>): VolumeByKeyItem[] =>
    [...m.entries()]
      .map(([key, v]) => ({ key, payin: v.payin, payout: v.payout, total: addAmount(v.payin, v.payout) }))
      .sort((a, b) => a.key.localeCompare(b.key));

  const volume = { byCurrency: toVolItems(volByCurrency), byRail: toVolItems(volByRail) };

  // 4. Gross take rate per currency = revenue.total / (payin + payout volume).
  const takeRate: TakeRateItem[] = [];
  const currencies = new Set<string>([
    ...revenue.byCurrency.map((r) => r.currency),
    ...volume.byCurrency.map((v) => v.key),
  ]);
  for (const currency of [...currencies].sort()) {
    const rev = revenue.byCurrency.find((r) => r.currency === currency)?.total ?? "0";
    const vol = volume.byCurrency.find((v) => v.key === currency)?.total ?? "0";
    const volNum = toNum(vol);
    takeRate.push({
      currency,
      revenue: rev,
      volume: vol,
      takeRateBps: volNum > 0 ? Math.round((toNum(rev) / volNum) * 10000) : null,
    });
  }

  // 5. Liquidity snapshot (pending txs + merchant wallet liability).
  const pendingRows = await db
    .select({
      currency: transactions.currency,
      type: transactions.type,
      total: sql<string>`sum(${transactions.amount})`,
      count: sql<number>`count(*)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.environment, environment),
        eq(transactions.status, "pending"),
        inArray(transactions.type, ["payin", "payout"])
      )
    )
    .groupBy(transactions.currency, transactions.type);

  const pendingPayin = new Map<string, { amount: string; count: number }>();
  const pendingPayout = new Map<string, { amount: string; count: number }>();
  for (const r of pendingRows) {
    const currency = norm(r.currency);
    const bucket = { amount: String(r.total ?? "0"), count: Number(r.count ?? 0) };
    if (r.type === "payin") pendingPayin.set(currency, bucket);
    else pendingPayout.set(currency, bucket);
  }

  const merchantWalletRows = await db
    .select({
      currency: wallets.currency,
      total: sql<string>`sum(${wallets.balance})`,
      count: sql<number>`count(*)`,
    })
    .from(wallets)
    .where(
      and(
        eq(wallets.environment, environment),
        eq(wallets.type, "merchant"),
        eq(wallets.status, "active"),
        ne(wallets.merchantId, PLATFORM_MERCHANT_ID)
      )
    )
    .groupBy(wallets.currency);

  const toBuckets = (m: Map<string, { amount: string; count: number }>): TreasuryLiquidityBucket[] =>
    [...m.entries()]
      .map(([currency, v]) => ({ currency, amount: v.amount, count: v.count }))
      .sort((a, b) => a.currency.localeCompare(b.currency));

  const liquidity = {
    pendingPayinByCurrency: toBuckets(pendingPayin),
    pendingPayoutByCurrency: toBuckets(pendingPayout),
    merchantBalancesByCurrency: merchantWalletRows
      .map((r) => ({
        currency: norm(r.currency),
        amount: String(r.total ?? "0"),
        count: Number(r.count ?? 0),
      }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    note: "Pending amounts are open pay-in/payout txs. Merchant balances are sum of active merchant settlement wallets (excludes platform retained-earnings wallets). Provider float is not polled here.",
  };

  return {
    environment,
    from: from.toISOString(),
    to: to.toISOString(),
    platformBalances,
    revenue,
    volume,
    takeRate,
    liquidity,
    disclosures: {
      basis: "gross",
      netMarginAvailable: false,
      providerCostTracked: false,
      fxSpreadLedgered: false,
      note: "Revenue is GROSS platform fees + subscriptions. Provider cost (PayOK transFee / Tylt rate) is not yet persisted and FX spread is not yet ledgered, so net margin is not computable. See docs/TREASURY_MANAGEMENT_RESEARCH.md.",
    },
  };
}
