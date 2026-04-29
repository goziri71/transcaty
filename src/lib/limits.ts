/** Bangladesh BDT limits for Payok flows. */
export const LIMITS = {
  payin: { min: 200, max: 25_000 },
  payout: { min: 100, max: 25_000 },
  /** CrossRamp UPI (Tylt): quoted amount limits by currency symbol sent to Tylt. */
  tyltCrossRamp: {
    USDT: { min: 1, max: 500_000 },
    INR: { min: 200, max: 500_000 },
  },
  /** CPG pay-in: `baseAmount` bounds before forwarding to Tylt. */
  tyltCpgPayin: {
    baseAmountMin: 1e-8,
    baseAmountMax: 1e15,
  },
} as const;
