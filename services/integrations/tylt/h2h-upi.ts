/**
 * Tylt H2H UPI pay-in (§4.2): API-led flow; credits use same signed webhook + ledger path as CrossRamp UPI.
 */
import { eq } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions } from "../../../src/db/schema/index.js";
import { audit } from "../../../src/lib/audit.js";
import { tyltSignedGetJson, tyltSignedPostJson } from "./client.js";
import type { TyltMerchantEnvironment } from "./config.js";
import { sortKeysRecursive } from "./sign.js";
import { TYLT_PRODUCT_H2H_UPI } from "./crossramp-payin.js";

const RAIL = "tylt";

export function isTyltH2hPayinMetadata(meta: Record<string, unknown>): boolean {
  return meta.rail === RAIL && meta.tyltProduct === TYLT_PRODUCT_H2H_UPI;
}

function extractH2hCreateResponse(json: unknown): {
  instanceId: string;
  paymentDetails: Record<string, unknown>;
} {
  const root = json as Record<string, unknown>;
  const data = (root.data ?? root.result ?? root) as Record<string, unknown>;
  const instanceId = String(data.instanceId ?? data.instance_id ?? "").trim();
  return { instanceId, paymentDetails: data };
}

function h2hCreateFailureHint(status: number, json: unknown): string {
  const parts: string[] = [`upstream_http=${status}`];
  const root = json as Record<string, unknown> | null;
  if (!root || typeof root !== "object") {
    return parts.join("; ");
  }

  // Non-JSON error body from Tylt (client.ts stores as { raw: string })
  if (typeof root.raw === "string" && root.raw.trim()) {
    const safe = root.raw.trim().replace(/\s+/g, " ").slice(0, 280);
    parts.push(`upstream_body=${safe}`);
    return parts.join("; ");
  }

  const data = (root.data ?? root.result ?? root) as Record<string, unknown>;
  const candidates: unknown[] = [
    root.message,
    root.error,
    root.errorMessage,
    root.statusMessage,
    root.msg,
    root.description,
    data?.message,
    data?.error,
    data?.errorMessage,
    data?.msg,
  ];

  const errors = root.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const joined = errors
      .slice(0, 5)
      .map((e) => {
        if (typeof e === "string") return e;
        if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
          return (e as { message: string }).message;
        }
        try {
          return JSON.stringify(e);
        } catch {
          return String(e);
        }
      })
      .filter(Boolean)
      .join("; ");
    if (joined) candidates.push(joined);
  }

  if (root.success === false && typeof root.message === "string") {
    candidates.unshift(root.message);
  }

  const msg = candidates.find((v) => typeof v === "string" && String(v).trim()) as string | undefined;
  if (msg?.trim()) {
    const safe = msg.trim().slice(0, 240).replace(/\s+/g, " ");
    parts.push(`upstream_message=${safe}`);
  } else {
    // Last resort: compact top-level string fields only (no full payload)
    const keys = Object.keys(root).filter((k) => {
      const v = root[k];
      return typeof v === "string" && v.length > 0 && v.length < 500 && !k.toLowerCase().includes("token");
    });
    if (keys.length) {
      const snippet = keys
        .slice(0, 4)
        .map((k) => `${k}=${String(root[k]).slice(0, 80)}`)
        .join("; ");
      parts.push(`upstream_fields=${snippet}`);
    }
  }
  return parts.join("; ");
}

export async function createTyltH2hPayinInstance(params: {
  merchantId: string;
  environment: TyltMerchantEnvironment;
  baseUrl: string;
  amount: string;
  currencySymbol: "USDT" | "INR";
  /** Required by Tylt createPayinInstance (see upstream validation). */
  userDetails: { email: string; name?: string; phone?: string };
  /** Optional redirect when Tylt expects redirectUrl for mobile/browser flows. */
  returnUrl?: string;
  kycBypass: boolean;
}) {
  const callBackUrl = `${params.baseUrl.replace(/\/$/, "")}/webhooks/tylt/h2h/${params.environment}`;

  const metadata = {
    rail: RAIL,
    tyltProduct: TYLT_PRODUCT_H2H_UPI,
    merchantReturnUrl: params.returnUrl ?? "",
    currencySymbol: params.currencySymbol,
  };

  const settlementCurrency: "USDT" | "INR" = params.currencySymbol === "INR" ? "INR" : "USDT";

  const [tx] = await db
    .insert(transactions)
    .values({
      merchantId: params.merchantId,
      environment: params.environment,
      type: "payin",
      status: "pending",
      amount: params.amount,
      currency: settlementCurrency,
      provider: "tylt-h2h-upi",
      metadata: JSON.stringify(metadata),
    })
    .returning();

  if (!tx) throw new Error("Failed to create transaction");

  const email = params.userDetails.email.trim();
  if (!email) {
    throw new Error("Tylt H2H create requires a non-empty userDetails.email");
  }

  /** TL Pay validates these fields strictly; keep plain JSON-serializable values only. */
  const merchantOrderId = String(tx.id);
  const amountRaw = (() => {
    const n = parseFloat(params.amount);
    return Number.isFinite(n) ? n : params.amount;
  })();

  const body: Record<string, unknown> = {
    userDetails: {
      email,
      ...(params.userDetails.name?.trim() ? { name: params.userDetails.name.trim() } : {}),
      ...(params.userDetails.phone?.trim() ? { phone: params.userDetails.phone.trim() } : {}),
    },
    amount: amountRaw,
    currencySymbol: params.currencySymbol,
    merchantOrderId,
    callBackUrl,
    userEmail: email,
    isKYCNeeded: params.kycBypass ? 0 : 1,
    isUTRNeeded: 1,
  };
  if (params.returnUrl?.trim()) {
    body.redirectUrl = params.returnUrl.trim();
  }

  /** Stable key order + nested ordering (matches TL Pay signing examples using compact JSON). */
  const wireBody = sortKeysRecursive(body) as Record<string, unknown>;

  const { status, json } = await tyltSignedPostJson<Record<string, unknown>>({
    environment: params.environment,
    path: "/h2h/in/upi/createPayinInstance",
    body: wireBody,
    idempotencyKey: tx.id,
    credentialRole: "payin",
  });

  const { instanceId, paymentDetails } = extractH2hCreateResponse(json);

  if (status >= 400 || !instanceId) {
    await db.update(transactions).set({ status: "failed", updatedAt: new Date() }).where(eq(transactions.id, tx.id));
    const hint = h2hCreateFailureHint(status, json);
    throw new Error(`Tylt H2H create instance failed (${hint})`);
  }

  await db
    .update(transactions)
    .set({ externalId: instanceId, updatedAt: new Date() })
    .where(eq(transactions.id, tx.id));

  audit({
    action: "payment.created",
    resource: tx.id,
    merchantId: params.merchantId,
    meta: { instanceId, rail: RAIL, product: TYLT_PRODUCT_H2H_UPI },
  });

  return {
    transactionId: tx.id,
    instanceId,
    amount: params.amount,
    currency: settlementCurrency,
    paymentDetails,
  };
}

export async function tyltH2hBuyerConfirmsPayment(params: {
  environment: TyltMerchantEnvironment;
  instanceId: string;
  utr?: string;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  const body: Record<string, unknown> = { instanceId: params.instanceId };
  if (params.utr?.trim()) {
    body.utr = params.utr.trim();
  }
  return tyltSignedPostJson<Record<string, unknown>>({
    environment: params.environment,
    path: "/h2h/in/upi/buyerConfirmsPayment",
    body,
    credentialRole: "payin",
  });
}

export async function tyltH2hGetPaymentMethodsP2pOnRamp(environment: TyltMerchantEnvironment) {
  return tyltSignedGetJson({
    environment,
    path: "/h2h/in/upi/getPaymentMethods_p2pOnRamp",
    queryParams: {},
    credentialRole: "payin",
  });
}

export async function tyltH2hGetCryptoCurrencyListForPrime(environment: TyltMerchantEnvironment) {
  return tyltSignedGetJson({
    environment,
    path: "/h2h/in/upi/getCryptoCurrencyListForPrime",
    queryParams: {},
    credentialRole: "payin",
  });
}

/** Merchant-quoted INR/USDT (and related) rates for pay-in vs pay-out — UI/estimates only; settlement follows the trade. */
export async function tyltH2hGetMerchantRampSpecialRates(environment: TyltMerchantEnvironment) {
  return tyltSignedGetJson({
    environment,
    path: "/h2h/in/upi/getMerchantRampSpecialRates",
    queryParams: {},
    credentialRole: "payin",
  });
}
