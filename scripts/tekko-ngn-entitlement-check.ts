/**
 * Probe Tekko NGN permanent VA + payout entitlement (read-mostly).
 * Never prints secrets, private keys, or proxy credentials.
 *
 *   npx tsx scripts/tekko-ngn-entitlement-check.ts
 *   npm run tekko:ngn-entitlement-check
 *
 * Optional (GET master VA — does not create temp collections):
 *   TEKKO_NGN_ENTITLEMENT_PROBE_VA=1 npx tsx scripts/tekko-ngn-entitlement-check.ts
 */
import "dotenv/config";
import { getTekkoLiveConfig } from "../services/integrations/tekko/config.js";
import { tekkoGet } from "../services/integrations/tekko/client.js";
import { describeTekkoStaticProxy } from "../services/integrations/tekko/static-proxy.js";

function present(v: string | undefined | null): boolean {
  return Boolean(v?.trim());
}

function extractCode(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  const err = root.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  if (typeof root.code === "string") return root.code;
  return null;
}

function hasNgnCorridor(json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  const root = json as Record<string, unknown>;
  const data = root.data ?? root;
  const blob = JSON.stringify(data).toUpperCase();
  return blob.includes("NGN") || blob.includes('"NG"');
}

async function main() {
  const cfg = getTekkoLiveConfig();
  const proxy = describeTekkoStaticProxy();
  console.log("[tekko-ngn-entitlement] creds=%s proxy=%s nodeEnv=%s", Boolean(cfg), proxy.configured, process.env.NODE_ENV ?? "");

  if (!cfg) {
    console.error("[tekko-ngn-entitlement] FAIL: Tekko credentials missing (TEKKO_LIVE_KEY_ID + private key)");
    process.exitCode = 1;
    return;
  }

  try {
    const ping = await tekkoGet("/ping", { label: "tekko ngn entitlement ping" });
    console.log("[tekko-ngn-entitlement] ping status=%s", ping.status);
    if (ping.status >= 400) {
      console.error("[tekko-ngn-entitlement] FAIL: ping rejected — fix PYUSD-path Tekko auth/proxy first");
      process.exitCode = 1;
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[tekko-ngn-entitlement] FAIL: ping error: %s", msg.slice(0, 300));
    process.exitCode = 1;
    return;
  }

  try {
    const supported = await tekkoGet("/collections/supported", {
      label: "tekko ngn entitlement collections/supported",
    });
    const code = extractCode(supported.json);
    console.log(
      "[tekko-ngn-entitlement] collections/supported status=%s code=%s ngnHint=%s",
      supported.status,
      code ?? "none",
      hasNgnCorridor(supported.json)
    );

    if (supported.status === 403 && (code === "SERVICE_NOT_ENTITLED" || code === "PRODUCT_RAIL_DISABLED")) {
      console.error(
        "[tekko-ngn-entitlement] FAIL: not entitled — ask Tekko to enable ngn_collections on this partner"
      );
      process.exitCode = 1;
      return;
    }
    if (supported.status >= 400) {
      console.error("[tekko-ngn-entitlement] FAIL: collections/supported HTTP %s", supported.status);
      process.exitCode = 1;
      return;
    }
    if (!hasNgnCorridor(supported.json)) {
      console.warn(
        "[tekko-ngn-entitlement] WARN: supported payload has no obvious NGN/NG corridor — confirm with Tekko"
      );
    } else {
      console.log("[tekko-ngn-entitlement] OK: collections/supported reachable with NGN/NG hint");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[tekko-ngn-entitlement] FAIL: collections/supported error: %s", msg.slice(0, 300));
    process.exitCode = 1;
    return;
  }

  if (process.env.TEKKO_NGN_ENTITLEMENT_PROBE_VA === "1" || process.env.TEKKO_NGN_ENTITLEMENT_PROBE_VA === "true") {
    try {
      const va = await tekkoGet("/master-wallet/ng/virtual-account", {
        label: "tekko ngn entitlement master va get",
      });
      const code = extractCode(va.json);
      console.log(
        "[tekko-ngn-entitlement] master VA GET status=%s code=%s (platform treasury VA; merchant product uses customer VA)",
        va.status,
        code ?? "none"
      );
      if (va.status === 403 && (code === "SERVICE_NOT_ENTITLED" || code === "PRODUCT_RAIL_DISABLED")) {
        console.error("[tekko-ngn-entitlement] FAIL: VA not entitled (ngn_collections)");
        process.exitCode = 1;
        return;
      }
      if (va.status >= 400 && va.status !== 404) {
        console.error("[tekko-ngn-entitlement] FAIL: master VA GET HTTP %s", va.status);
        process.exitCode = 1;
        return;
      }
      console.log("[tekko-ngn-entitlement] OK: master VA endpoint reachable (404 means not provisioned yet)");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[tekko-ngn-entitlement] FAIL: master VA GET error: %s", msg.slice(0, 300));
      process.exitCode = 1;
      return;
    }
  } else {
    console.log(
      "[tekko-ngn-entitlement] skip VA probe (set TEKKO_NGN_ENTITLEMENT_PROBE_VA=1 to GET master VA)"
    );
  }

  try {
    const banks = await tekkoGet("/banks", { label: "tekko ngn entitlement banks" });
    const code = extractCode(banks.json);
    console.log(
      "[tekko-ngn-entitlement] banks status=%s code=%s (ngn_payouts proxy for bank list)",
      banks.status,
      code ?? "none"
    );
    if (banks.status === 403 && (code === "SERVICE_NOT_ENTITLED" || code === "PRODUCT_RAIL_DISABLED")) {
      console.warn("[tekko-ngn-entitlement] WARN: ngn_payouts may be disabled (GET /banks returned 403)");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[tekko-ngn-entitlement] WARN: banks probe failed: %s", msg.slice(0, 200));
  }

  console.log(
    "[tekko-ngn-entitlement] done. Record result in docs/TEKKO_NGN_OPS_ENTITLEMENT.md (ngn_collections + ngn_payouts)."
  );
  console.log(
    "[tekko-ngn-entitlement] NOTE: merchant product uses per-customer permanent VA; confirm customer→master liquidity before go-live payouts."
  );
  if (!present(process.env.TEKKO_WEBHOOK_SECRET) && !present(process.env.TEKKO_WEBHOOK_SECRET_ENC)) {
    console.warn("[tekko-ngn-entitlement] WARN: TEKKO_WEBHOOK_SECRET unset — VA credit webhooks will fail closed");
  }
}

main().catch((err) => {
  console.error("[tekko-ngn-entitlement] unexpected:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
