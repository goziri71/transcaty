/**
 * Sum pending pay-in amounts per settlement currency (ledger not yet credited).
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { transactions } from "../db/schema/index.js";
import { normalizeMoneyAmountToTwoDecimals } from "./money.js";

export async function sumPendingPayinAmountsByCurrency(params: {
  merchantId: string;
  environment: "test" | "live";
}): Promise<Map<string, string>> {
  const rows = await db
    .select({
      currency: transactions.currency,
      total: sql<string>`coalesce(sum(${transactions.amount}::numeric), 0)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.merchantId, params.merchantId),
        eq(transactions.environment, params.environment),
        eq(transactions.type, "payin"),
        eq(transactions.status, "pending")
      )
    )
    .groupBy(transactions.currency);

  const out = new Map<string, string>();
  for (const row of rows) {
    const cur = String(row.currency ?? "").trim();
    if (!cur) continue;
    out.set(cur, normalizeMoneyAmountToTwoDecimals(String(row.total ?? "0")));
  }
  return out;
}
