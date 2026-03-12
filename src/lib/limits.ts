/** Bangladesh BDT limits for Payok flows. */
export const LIMITS = {
  payin: { min: 200, max: 25_000 },
  payout: { min: 100, max: 25_000 },
} as const;
