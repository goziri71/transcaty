#!/usr/bin/env npx tsx
/**
 * Test Payok API connectivity – balance inquiry.
 * Usage: npx tsx scripts/payok-test.ts
 */
import "dotenv/config";
import { payokBalanceQuery } from "../src/lib/payok-client.js";

async function main() {
  console.log("Calling Payok balance inquiry...\n");

  try {
    const { status, body } = await payokBalanceQuery();
    console.log("Status:", status);
    console.log("Body:", JSON.stringify(body, null, 2));

    if (status === 200) {
      console.log("\n✓ Payok API 200 – Phase 0 verified.");
    } else {
      console.log("\n✗ Unexpected status. Check credentials and base URL.");
      process.exit(1);
    }
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error("Error:", e.message);
    if (e.cause) console.error("Cause:", e.cause instanceof Error ? e.cause.message : e.cause);
    if (e.message === "fetch failed") {
      console.error("\nPossible causes: network unreachable, wrong PAYOK_BASE_URL, DNS failure, or firewall.");
    }
    process.exit(1);
  }
}

main();
