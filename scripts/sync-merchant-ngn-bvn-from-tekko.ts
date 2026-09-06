#!/usr/bin/env npx tsx
/**
 * Ops: pull Tekko BVN status for one merchant and persist to merchant_market_compliance.
 * Use when BVN was verified on Tekko but Transacty never stored it (or local is stale/failed).
 *
 *   npm run tekko:sync-ngn-bvn -- 85305e39-5cd5-4e81-b5ea-58ba10c0f110
 *   npx tsx scripts/sync-merchant-ngn-bvn-from-tekko.ts <merchant-uuid>
 */
import "dotenv/config";
import { forceSyncMerchantTekkoBvnStatusFromTekko } from "../services/integrations/tekko/ngn-va.js";
import { getNigeriaMarketCompliance } from "../src/lib/merchant-market-compliance.js";
import { assertMerchantAllowedForNgnBvnOpsSync } from "../src/lib/tekko-ngn-bvn-ops-sync-allowlist.js";

async function main(): Promise<void> {
  const merchantId = process.argv[2]?.trim();
  if (!merchantId || !/^[0-9a-f-]{36}$/i.test(merchantId)) {
    console.error("Usage: npm run tekko:sync-ngn-bvn -- <merchant-uuid>");
    console.error("Requires TEKKO_NGN_BVN_OPS_SYNC_MERCHANT_ALLOWLIST to include that merchant.");
    process.exit(1);
  }

  const gate = assertMerchantAllowedForNgnBvnOpsSync(merchantId);
  if (!gate.ok) {
    console.error("[sync-ngn-bvn] %s", gate.message);
    process.exit(1);
  }

  const before = await getNigeriaMarketCompliance(merchantId);
  console.log("[sync-ngn-bvn] merchantId=%s localBefore=%s va=%s", merchantId, before?.bvnVerificationStatus ?? "none", before?.vaAccountNumber ? "yes" : "no");

  const result = await forceSyncMerchantTekkoBvnStatusFromTekko(merchantId);
  console.log(JSON.stringify(result, null, 2));

  const after = await getNigeriaMarketCompliance(merchantId);
  console.log("[sync-ngn-bvn] localAfter=%s bvnVerifiedAt=%s", after?.bvnVerificationStatus ?? "none", after?.bvnVerifiedAt?.toISOString() ?? "null");

  if (result.error) {
    process.exitCode = 1;
    return;
  }
  if (result.appliedStatus !== "verified") {
    console.error(
      "[sync-ngn-bvn] Tekko BVN is not verified (%s). Merchant must POST /portal/me/ngn/virtual-account with BVN again.",
      result.appliedStatus
    );
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
