import { addAmount, normalizeMoneyAmountToTwoDecimals } from "../money.js";

export type FxProduct = "cpg_payout" | "eur_payout";
export type SpreadMode = "on_output" | "on_rate";

/** Increase crypto debit for send-out: amount × (1 + bps/10000). */
export function applySpreadToCryptoAmount(amount: string, spreadBps: number): {
  baseAmount: string;
  spreadAmount: string;
  totalDebit: string;
} {
  const base = normalizeMoneyAmountToTwoDecimals(amount);
  if (spreadBps <= 0) {
    return { baseAmount: base, spreadAmount: "0.00", totalDebit: base };
  }
  const baseNum = Number(base);
  const spreadNum = (baseNum * spreadBps) / 10_000;
  const spreadAmount = normalizeMoneyAmountToTwoDecimals(String(spreadNum));
  const totalDebit = addAmount(base, spreadAmount);
  return { baseAmount: base, spreadAmount, totalDebit };
}

/** Worse rate for merchant on EUR quotes: rate × (1 + bps/10000). */
export function applySpreadToRate(rate: number, spreadBps: number): number {
  if (!Number.isFinite(rate) || spreadBps <= 0) return rate;
  return rate * (1 + spreadBps / 10_000);
}
