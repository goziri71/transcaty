#!/usr/bin/env npx tsx
/**
 * Diagnose PayOK Brazil vs Bangladesh merchant/country pairing.
 * Logs merchant ID suffix only (never the full key).
 *
 * Usage: npx tsx scripts/payok-brazil-check.ts
 */
import "dotenv/config";
import {
  getDefaultPayokEnvironment,
  getPayokConfigForEnvironment,
  resolvePayokMerchantIdForCountry,
} from "../services/domestic/bangladesh/provider/config.js";
import { payokPayinPaymentMethods } from "../services/domestic/bangladesh/provider/client.js";

function maskMerchantId(id: string): string {
  if (id.length <= 8) return "***";
  return `…${id.slice(-8)}`;
}

async function probeCountry(environment: "test" | "live", countryCode: "BD" | "BR") {
  const defaultConfig = getPayokConfigForEnvironment(environment);
  const merchantId = resolvePayokMerchantIdForCountry(
    environment,
    countryCode,
    defaultConfig.merchantId
  );
  const brOverride = merchantId !== defaultConfig.merchantId;

  console.log(`\n=== ${environment.toUpperCase()} / ${countryCode} ===`);
  console.log(`  merchantId: ${maskMerchantId(merchantId)}${brOverride ? " (PAYOK_*_BR_MERCHANT_ID override)" : ""}`);

  try {
    const { status, body } = await payokPayinPaymentMethods({ environment, countryCode });
    console.log(`  HTTP: ${status}`);
    console.log(`  PayOK code: ${String(body.code ?? "—")}`);
    if (body.message) console.log(`  PayOK message: ${body.message}`);
    const list = Array.isArray(body.list) ? body.list : [];
    if (list.length) {
      console.log(`  payment methods (${list.length}):`);
      for (const item of list.slice(0, 10)) {
        const row = item as { category?: string; name?: string; countryName?: string };
        console.log(`    - ${row.category ?? "?"} (${row.name ?? "?"})`);
      }
    } else {
      console.log("  payment methods: (empty or not returned)");
    }
  } catch (err) {
    console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  const environment = getDefaultPayokEnvironment();
  console.log(`PayOK default environment: ${environment}`);
  console.log(
    "BR override env:",
    process.env[`PAYOK_${environment === "test" ? "TEST" : "LIVE"}_BR_MERCHANT_ID`] ? "set" : "not set"
  );

  await probeCountry(environment, "BD");
  await probeCountry(environment, "BR");

  console.log("\nIf BR returns country mismatch or empty methods, PayOK has not enabled Brazil/PIX");
  console.log("on this merchant ID. Ask PayOK to enable it, or set PAYOK_*_BR_MERCHANT_ID if they");
  console.log("issued a separate Brazil merchant ID (same private key and base URL).\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
