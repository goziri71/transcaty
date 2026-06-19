const CURRENCY_PRIORITY = ["BDT", "USDT", "USDC", "INR", "EUR", "GBP"] as const;

export type MerchantWalletBalanceRow = {
  environment: string;
  currency: string;
  balance: string;
};

export type PrimaryMerchantWalletBalance = {
  balance: string;
  currency: string;
  environment: "test" | "live";
};

function walletSortScore(wallet: MerchantWalletBalanceRow): number {
  const liveScore = wallet.environment === "live" ? 0 : 1;
  const currency = wallet.currency.trim().toUpperCase();
  const currencyIndex = CURRENCY_PRIORITY.indexOf(currency as (typeof CURRENCY_PRIORITY)[number]);
  const currencyScore = currencyIndex >= 0 ? currencyIndex : CURRENCY_PRIORITY.length;
  return liveScore * 100 + currencyScore;
}

/** Pick one wallet to display on provider merchant list (live BDT preferred). */
export function pickPrimaryMerchantWallet<T extends MerchantWalletBalanceRow>(
  wallets: T[]
): (T & PrimaryMerchantWalletBalance) | null {
  if (wallets.length === 0) return null;
  const sorted = [...wallets].sort((a, b) => walletSortScore(a) - walletSortScore(b));
  const primary = sorted[0];
  if (!primary) return null;
  return {
    ...primary,
    balance: String(primary.balance),
    currency: primary.currency.trim().toUpperCase(),
    environment: primary.environment === "live" ? "live" : "test",
  };
}

export function primaryMerchantBalanceByMerchantId(
  walletRows: (MerchantWalletBalanceRow & { merchantId: string })[],
  merchantIds: string[],
  environment?: "test" | "live"
): Map<string, PrimaryMerchantWalletBalance> {
  const filtered = environment
    ? walletRows.filter((w) => w.environment === environment)
    : walletRows;
  const map = new Map<string, PrimaryMerchantWalletBalance>();
  for (const merchantId of merchantIds) {
    const primary = pickPrimaryMerchantWallet(filtered.filter((w) => w.merchantId === merchantId));
    if (primary) {
      map.set(merchantId, {
        balance: primary.balance,
        currency: primary.currency,
        environment: primary.environment,
      });
    }
  }
  return map;
}
