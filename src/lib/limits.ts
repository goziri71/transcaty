/** Bangladesh BDT limits for Payok flows. */
export const LIMITS = {
  payin: { min: 200, max: 25_000 },
  payout: { min: 100, max: 25_000 },
  /** Brazil BRL limits for PayOK PIX flows (per Tylt/PayOK payout doc: 10–15,000 BRL). */
  payokBr: {
    payin: { min: 10, max: 15_000 },
    payout: { min: 10, max: 15_000 },
  },
  /** Tylt UPI pay-in (merchant H2H): quoted amount limits by currency symbol. */
  tyltCrossRamp: {
    USDT: { min: 1, max: 500_000 },
    INR: { min: 200, max: 500_000 },
  },
  /** CPG pay-in: `baseAmount` bounds before forwarding to Tylt. */
  tyltCpgPayin: {
    baseAmountMin: 1e-8,
    baseAmountMax: 1e15,
  },
  /** CPG payout: `amount` bounds before forwarding to Tylt. */
  tyltCpgPayout: {
    amountMin: 1e-8,
    amountMax: 1e15,
  },
  /** Tylt internal transfer: `settledAmount` bounds before forwarding. */
  tyltInternalTransfer: {
    amountMin: 1e-8,
    amountMax: 1e15,
  },
  /** EU Open Banking: fiat amount on create (EUR / GBP pay-in, EUR payout). */
  tyltEurOpenBanking: {
    EUR: { min: 1, max: 50_000 },
    GBP: { min: 1, max: 50_000 },
  },
  /** Tekko PYUSD checkout (expected PYUSD amount). */
  tekkoPyusd: {
    payin: { min: 1, max: 500_000 },
  },
} as const;
