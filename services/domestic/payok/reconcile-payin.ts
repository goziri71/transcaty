/**
 * Payok domestic pay-in reconcile: dispatch by transaction provider (BD vs BR).
 */
import { eq } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions } from "../../../src/db/schema/index.js";
import {
  reconcileBangladeshPayokPayinByTransactionId,
  type ReconcilePayokPayinResult,
} from "../bangladesh/payin-reconcile.js";
import { reconcileBrazilPayokPayinByTransactionId } from "../brazil/payin-reconcile.js";

export type { ReconcilePayokPayinResult };

export async function reconcilePayokPayinByTransactionId(
  transactionId: string
): Promise<ReconcilePayokPayinResult> {
  const [tx] = await db
    .select({ provider: transactions.provider })
    .from(transactions)
    .where(eq(transactions.id, transactionId))
    .limit(1);

  if (tx?.provider?.startsWith("payok-br")) {
    return reconcileBrazilPayokPayinByTransactionId(transactionId);
  }

  return reconcileBangladeshPayokPayinByTransactionId(transactionId);
}
