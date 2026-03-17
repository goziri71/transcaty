#!/usr/bin/env npx tsx
/**
 * Check Payok platform public key (for webhook verification).
 * Run with Render env: ensures PAYOK_PLATFORM_PUB_KEY is correct format.
 */
import "dotenv/config";
import { getPayokConfig } from "../services/domestic/bangladesh/provider/config.js";
import { verifyPayokCallback } from "../services/domestic/bangladesh/provider/signature.js";

function main() {
  try {
    const config = getPayokConfig();
    const key = config.platformPublicKey;

    const isPem = key.includes("-----BEGIN PUBLIC KEY-----");
    const len = key.length;
    const raw = key.replace(/\s/g, "");
    const firstChars = raw.slice(0, 80);

    console.log("PAYOK_PLATFORM_PUB_KEY check:\n");
    console.log("  Format:", isPem ? "PEM" : "base64");
    console.log("  Length:", len);
    console.log("  First 50 chars (no spaces):", firstChars);

    // Common typo: 101 vs lO1, S1 vs Sl
    if (firstChars.includes("101nNhy") && !firstChars.includes("lO1nNhy")) {
      console.log("\n  ✗ TYPO: Should be 'lO1' (letter L, letter O, digit 1), not '101'");
      process.exit(1);
    }
    if (firstChars.includes("qeS10Y") && !firstChars.includes("qeSl0Y")) {
      console.log("\n  ✗ TYPO: Should be 'Sl' (letter L), not 'S1' (digit 1)");
      process.exit(1);
    }

    // Sanity: verify rejects wrong signature
    const ok = verifyPayokCallback('{"test":1}&/webhooks/payok/payin', "/webhooks/payok/payin", "invalid", key);
    if (ok) {
      console.log("\n  ✗ Key accepted invalid signature - key may be wrong");
      process.exit(1);
    }

    console.log("\n  ✓ Platform key loads. If webhooks still 401, contact Payok for exact callback sign format.");
  } catch (err) {
    console.log("\n  ✗ Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
