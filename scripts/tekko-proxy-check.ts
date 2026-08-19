#!/usr/bin/env npx tsx
/**
 * Check whether Tekko QuotaGuard CONNECT is configured and reachable.
 * Never prints proxy credentials or private keys.
 *
 *   npx tsx scripts/tekko-proxy-check.ts
 *   npm run tekko:proxy-check
 *
 * Tests the env loaded here (.env / shell). That is not Render unless you
 * run this on the Render instance or copy the same vars locally.
 */
import "dotenv/config";
import { fetch as undiciFetch } from "undici";
import { getTekkoLiveConfig } from "../services/integrations/tekko/config.js";
import { tekkoGet } from "../services/integrations/tekko/client.js";
import {
  describeTekkoStaticProxy,
  getTekkoStaticProxyDispatcher,
  resetTekkoStaticProxyForTests,
} from "../services/integrations/tekko/static-proxy.js";

function present(v: string | undefined | null): boolean {
  return Boolean(v?.trim());
}

function safeErr(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const cause =
    err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
  return `${msg}${cause ? ` (${cause})` : ""}`
    .replace(/\/\/[^@\s]+@/g, "//***@")
    .slice(0, 400);
}

async function fetchVia(
  url: string,
  dispatcher: ReturnType<typeof getTekkoStaticProxyDispatcher>
): Promise<{ status: number; body: string }> {
  const res = await undiciFetch(url, {
    method: "GET",
    dispatcher: dispatcher ?? undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.text()).trim().slice(0, 200);
  return { status: res.status, body };
}

async function main(): Promise<void> {
  console.log("Tekko QuotaGuard CONNECT check\n");
  console.log(`  NODE_ENV=${process.env.NODE_ENV ?? "(unset)"}`);

  for (const key of [
    "TEKKO_STATIC_PROXY_URL",
    "TEKKO_STATIC_PROXY_URL_ENC",
    "QUOTAGUARDSTATIC_URL",
    "QUOTAGUARDSTATIC_URL_ENC",
    "TEKKO_STATIC_PROXY_REQUIRED",
    "TEKKO_LIVE_KEY_ID",
    "TEKKO_KEY_ID",
    "TEKKO_LIVE_PRIVATE_KEY",
    "TEKKO_LIVE_PRIVATE_KEY_ENC",
    "TEKKO_LIVE_PRIVATE_KEY_PATH",
    "ENCRYPTION_MASTER_KEY",
  ] as const) {
    console.log(`  ${present(process.env[key]) ? "✓" : "✗"} ${key}`);
  }

  let info;
  try {
    info = describeTekkoStaticProxy();
  } catch (err) {
    console.log("\n  proxy URL invalid:", safeErr(err));
    process.exitCode = 1;
    return;
  }

  console.log("\nResolved proxy (no secrets):");
  console.log(`  configured=${info.configured}`);
  console.log(`  required=${info.required} (true in production unless TEKKO_STATIC_PROXY_REQUIRED=false)`);
  console.log(`  source=${info.source ?? "(none)"}`);
  console.log(
    `  endpoint=${info.configured ? `${info.protocol}://${info.hostname}:${info.port}` : "(none)"}`
  );
  console.log(`  hasUser=${info.hasUser}`);

  if (!info.configured) {
    console.log(
      "\nNot connected: no TEKKO_STATIC_PROXY_URL / QUOTAGUARDSTATIC_URL (or *_ENC) in this process."
    );
    if (info.required) {
      console.log("Production fail-closed: POST /v1/pyusd/payment-intents → 503 payment_unavailable.");
    } else {
      console.log("Locally optional: Tekko calls go direct (Render production still requires the proxy).");
    }
    process.exitCode = 1;
    return;
  }

  resetTekkoStaticProxyForTests();
  const dispatcher = getTekkoStaticProxyDispatcher();
  if (!dispatcher) {
    console.log("\nDispatcher missing despite configured URL.");
    process.exitCode = 1;
    return;
  }

  console.log("\nCONNECT via proxy → https://api.ipify.org (egress IP):");
  try {
    const viaProxy = await fetchVia("https://api.ipify.org", dispatcher);
    console.log(`  viaProxy status=${viaProxy.status} ip=${viaProxy.body}`);
  } catch (err) {
    console.log("  viaProxy FAILED:", safeErr(err));
    process.exitCode = 1;
  }

  console.log("Direct (no proxy) → https://api.ipify.org:");
  try {
    const direct = await fetchVia("https://api.ipify.org", undefined);
    console.log(`  direct status=${direct.status} ip=${direct.body}`);
  } catch (err) {
    console.log("  direct FAILED:", safeErr(err));
  }

  const tekkoCfg = getTekkoLiveConfig();
  console.log(`\nTekko live credentials loaded=${Boolean(tekkoCfg)}`);
  if (!tekkoCfg) {
    console.log("  Skipping signed GET /ping (set TEKKO_LIVE_KEY_ID + private key).");
    return;
  }

  console.log("Signed Tekko GET /ping (uses the same proxy dispatcher as production):");
  try {
    const ping = await tekkoGet("/ping", { label: "tekko proxy-check ping" });
    const env =
      ping.json && typeof ping.json === "object" && "environment" in ping.json
        ? String((ping.json as { environment?: unknown }).environment)
        : "";
    console.log(`  status=${ping.status}${env ? ` environment=${env}` : ""}`);
    if (ping.status >= 400) process.exitCode = 1;
  } catch (err) {
    console.log("  ping FAILED:", safeErr(err));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(safeErr(err));
  process.exit(1);
});
