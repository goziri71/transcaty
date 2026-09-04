#!/usr/bin/env npx tsx
/**
 * Live PYUSD smoke: Tekko ping, customer, create, get, reconcile, webhook HMAC.
 * Never prints secrets, full deposit addresses, or API keys.
 *
 *   npx tsx scripts/tekko-pyusd-smoke.ts
 */
import "dotenv/config";
import { createHmac } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { closeDb, db } from "../src/db/index.js";
import { merchants, merchantMarkets } from "../src/db/schema/index.js";
import { getMerchantProviderExternalId, TEKKO_PROVIDER } from "../src/lib/merchant-provider-links.js";
import {
  assertTekkoLiveEnvironment,
  createTekkoPyusdPaymentIntent,
  getTekkoPyusdPaymentIntentStatus,
  reconcileTekkoPyusdPayinByTransactionId,
  tekkoGet,
  tekkoWebhookSecretConfigured,
  verifyTekkoWebhookSignature,
  getTekkoLiveConfig,
} from "../services/integrations/tekko/index.js";
import { describeTekkoStaticProxy } from "../services/integrations/tekko/static-proxy.js";

const MERCHANT_ID =
  process.env.PYUSD_SMOKE_MERCHANT_ID?.trim() || "85305e39-5cd5-4e81-b5ea-58ba10c0f110";

function maskAddr(addr: string | null | undefined): string {
  if (!addr) return "(none)";
  if (addr.length <= 10) return `${addr.slice(0, 4)}…`;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fail(step: string, err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`FAIL ${step}: ${msg.slice(0, 400)}`);
  process.exitCode = 1;
  throw err instanceof Error ? err : new Error(msg);
}

async function probeHttp(name: string, url: string, init?: RequestInit): Promise<void> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const body = (await res.text()).slice(0, 160).replace(/\s+/g, " ");
  console.log(`  ${name} → HTTP ${res.status} ${body}`);
}

async function main(): Promise<void> {
  const results: string[] = [];
  const pass = (name: string, extra = "") => {
    results.push(`PASS ${name}${extra ? ` ${extra}` : ""}`);
    console.log(`PASS ${name}${extra ? ` ${extra}` : ""}`);
  };

  console.log("PYUSD / Tekko API smoke\n");
  console.log(`  NODE_ENV=${process.env.NODE_ENV ?? "(unset)"}`);
  console.log(`  merchant=${MERCHANT_ID}`);

  const proxy = describeTekkoStaticProxy();
  console.log(`  proxy configured=${proxy.configured} required=${proxy.required} source=${proxy.source ?? "(none)"}`);

  const cfg = getTekkoLiveConfig();
  if (!cfg) fail("tekko config", new Error("getTekkoLiveConfig returned null (keys / webhook secret missing)"));
  pass("tekko live config", `base=${cfg.baseUrl} keyId=${cfg.keyId.slice(0, 8)}… webhookSecret=${tekkoWebhookSecretConfigured()}`);

  try {
    assertTekkoLiveEnvironment("test");
    fail("test env gate", new Error("expected test environment to throw"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/live/i.test(msg) && !/unavailable/i.test(msg) && !/test/i.test(msg)) {
      fail("test env gate", err);
    }
    pass("test environment rejected", msg.slice(0, 80));
  }

  try {
    const ping = await tekkoGet("/ping", { label: "smoke ping" });
    if (ping.status !== 200) fail("tekko ping", new Error(`HTTP ${ping.status}`));
    pass("tekko GET /ping", `HTTP ${ping.status}`);
  } catch (err) {
    fail("tekko ping", err);
  }

  const [merchant] = await db
    .select({
      id: merchants.id,
      name: merchants.name,
      status: merchants.status,
      kycStatus: merchants.kycStatus,
    })
    .from(merchants)
    .where(eq(merchants.id, MERCHANT_ID))
    .limit(1);
  if (!merchant) fail("merchant lookup", new Error("merchant not found"));
  const tekkoCustomer = await getMerchantProviderExternalId(MERCHANT_ID, TEKKO_PROVIDER);
  pass(
    "merchant",
    `status=${merchant.status} kyc=${merchant.kycStatus} tekkoCustomer=${tekkoCustomer ?? "(will create)"}`
  );

  const [market] = await db
    .select({
      entitlementStatus: merchantMarkets.entitlementStatus,
      kybStatus: merchantMarkets.kybStatus,
    })
    .from(merchantMarkets)
    .where(and(eq(merchantMarkets.merchantId, MERCHANT_ID), eq(merchantMarkets.market, "pyusd")))
    .limit(1);
  if (market?.entitlementStatus !== "approved") {
    fail(
      "pyusd market",
      new Error(`expected entitlement approved, got ${market?.entitlementStatus ?? "missing"}`)
    );
  }
  pass("pyusd market approved", `kyb=${market.kybStatus}`);

  const webhookSecret = cfg.webhookSecret;
  if (!webhookSecret) {
    fail("webhook hmac", new Error("TEKKO_WEBHOOK_SECRET is not configured"));
  }
  const ts = String(Date.now());
  const rawBody = "{\"type\":\"smoke.signature_only\",\"data\":{}}";
  const sig = createHmac("sha256", webhookSecret).update(`${ts}.${rawBody}`, "utf8").digest("hex");
  const ok = verifyTekkoWebhookSignature({
    secret: webhookSecret,
    timestamp: ts,
    signature: sig,
    rawBody,
  });
  if (!ok) fail("webhook hmac", new Error("verifyTekkoWebhookSignature returned false"));
  pass("webhook HMAC verify (local round-trip)");

  const apiBase = process.env.APP_BASE_URL?.replace(/\/$/, "") || "https://api.transacty.ai";
  console.log(`\nHTTP probes (${apiBase}) — expect 401 without auth:\n`);
  try {
    await probeHttp(
      "POST /v1/pyusd/payment-intents (no HMAC)",
      `${apiBase}/v1/pyusd/payment-intents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: "1.00", merchantReference: "smoke" }),
      }
    );
    await probeHttp(
      "GET /v1/pyusd/payment-intents/:id (no HMAC)",
      `${apiBase}/v1/pyusd/payment-intents/00000000-0000-4000-8000-000000000000`
    );
    await probeHttp(
      "POST /portal/me/pyusd/payment-intents (no JWT)",
      `${apiBase}/portal/me/pyusd/payment-intents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environment: "live", amount: "1.00", merchantReference: "smoke" }),
      }
    );
    await probeHttp(
      "GET /portal/me/pyusd/payment-intents/:id (no JWT)",
      `${apiBase}/portal/me/pyusd/payment-intents/00000000-0000-4000-8000-000000000000`
    );
    await probeHttp("POST /webhooks/tekko/live (no sig)", `${apiBase}/webhooks/tekko/live`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await probeHttp(
      "POST /provider/tekko/pyusd/reconcile (no auth)",
      `${apiBase}/provider/tekko/pyusd/reconcile`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transactionId: "00000000-0000-4000-8000-000000000000" }),
      }
    );
    pass("production HTTP auth gates reachable");
  } catch (err) {
    fail("production HTTP probes", err);
  }

  console.log("\nLive Tekko create → get → reconcile (1.00 PYUSD, no on-chain payment):\n");
  const ref = `pyusd-smoke-${Date.now()}`;
  const created = await createTekkoPyusdPaymentIntent({
    merchantId: MERCHANT_ID,
    environment: "live",
    amount: "1.00",
    merchantReference: ref,
    expiresInMinutes: 15,
    metadata: { smoke: true },
    baseUrl: apiBase,
  }).catch((err) => fail("create payment intent", err));

  pass(
    "createTekkoPyusdPaymentIntent",
    `tx=${created.transactionId} intent=${created.paymentIntentId} status=${created.status} addr=${maskAddr(created.depositAddress)}`
  );

  const status = await getTekkoPyusdPaymentIntentStatus({
    merchantId: MERCHANT_ID,
    transactionId: created.transactionId,
  }).catch((err) => fail("get payment intent", err));
  if (!status) fail("get payment intent", new Error("not found"));
  pass(
    "getTekkoPyusdPaymentIntentStatus",
    `status=${status.status} settlement=${status.settlementStatus} settled=${status.settled}`
  );

  const recon = await reconcileTekkoPyusdPayinByTransactionId(created.transactionId).catch((err) =>
    fail("reconcile", err)
  );
  pass("reconcileTekkoPyusdPayinByTransactionId", JSON.stringify(recon));

  console.log("\nDone. No PYUSD-USDC was credited (intent is unpaid / not settled).");
  console.log(results.join("\n"));
}

main()
  .catch(() => {
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
