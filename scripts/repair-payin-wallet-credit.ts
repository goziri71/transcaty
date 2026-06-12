#!/usr/bin/env npx tsx
/**
 * Move a pay-in credit from the wrong merchant wallet currency to tx.currency (e.g. BDT).
 * Usage: npx tsx scripts/repair-payin-wallet-credit.ts <transactionId>
 */
import "dotenv/config";
import { repairMisCreditedPayinWallet } from "../services/domestic/bangladesh/payin-reconcile.js";

async function main() {
  const transactionId = process.argv[2]?.trim();
  if (!transactionId) {
    console.error("Usage: npx tsx scripts/repair-payin-wallet-credit.ts <transactionId>");
    process.exit(1);
  }

  const result = await repairMisCreditedPayinWallet(transactionId);
  console.log(JSON.stringify(result, null, 2));

  if (result.outcome === "error") {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
