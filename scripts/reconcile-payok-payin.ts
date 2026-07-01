#!/usr/bin/env npx tsx
/**
 * Finalize a pending Bangladesh Payok pay-in by querying Payok and applying the callback locally.
 * Usage: npx tsx scripts/reconcile-payok-payin.ts <transactionId>
 */
import "dotenv/config";
import { reconcilePayokPayinByTransactionId } from "../services/domestic/payok/reconcile-payin.js";

async function main() {
  const transactionId = process.argv[2]?.trim();
  if (!transactionId) {
    console.error("Usage: npx tsx scripts/reconcile-payok-payin.ts <transactionId>");
    process.exit(1);
  }

  const result = await reconcilePayokPayinByTransactionId(transactionId);
  console.log(JSON.stringify(result, null, 2));

  if (result.outcome === "error") {
    process.exit(1);
  }
  if (result.outcome === "not_terminal") {
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
