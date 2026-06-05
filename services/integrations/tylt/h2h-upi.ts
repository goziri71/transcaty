/**
 * Tylt H2H UPI pay-in (§4.2): API-led flow; credits use same signed webhook + ledger path as CrossRamp UPI.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions } from "../../../src/db/schema/index.js";
import { audit } from "../../../src/lib/audit.js";
import { UpstreamProviderClientError } from "../../../src/lib/merchant-facing-errors.js";
import { tyltSignedGetJson, tyltSignedPostJson } from "./client.js";
import type { TyltMerchantEnvironment } from "./config.js";
import { sortKeysRecursive } from "./sign.js";
import {
  TYLT_PRODUCT_H2H_UPI,
  extractPaymentInstructionsFromTyltData,
  extractTyltPayinDataEnvelope,
  fetchTyltPayinInstanceDetails,
  mergeTransactionMetadata,
  parseCrossRampEventId,
  parseTransactionMetadata,
  resolveTyltPayinMerchantOrderIdForRemote,
} from "./crossramp-payin.js";

const RAIL = "tylt";

export function isTyltH2hPayinMetadata(meta: Record<string, unknown>): boolean {
  return meta.rail === RAIL && meta.tyltProduct === TYLT_PRODUCT_H2H_UPI;
}

/** Tylt H2H: default `isKYCNeeded=0` (per merchant agreement). Set `TYLT_H2H_REQUIRE_END_USER_KYC=true` to send `1`. */
function h2hIsKycNeededForTylt(): 0 | 1 {
  if (process.env.TYLT_H2H_REQUIRE_END_USER_KYC === "true" || process.env.TYLT_H2H_REQUIRE_END_USER_KYC === "1") {
    return 1;
  }
  return 0;
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

/** First human-readable message from TL Pay JSON bodies (4xx errors, common success wrappers). */
export function pickTyltJsonPrimaryMessage(json: unknown): string | undefined {
  const root = json as Record<string, unknown> | null;
  if (!root || typeof root !== "object") return undefined;

  if (typeof root.raw === "string" && root.raw.trim()) {
    return root.raw.trim().replace(/\s+/g, " ").slice(0, 500);
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
  if (!msg?.trim()) return undefined;
  return msg.trim().replace(/\s+/g, " ").slice(0, 500);
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

  const picked = pickTyltJsonPrimaryMessage(json);
  if (picked) {
    const safe = picked.slice(0, 240);
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
}) {
  const callBackUrl = `${params.baseUrl.replace(/\/$/, "")}/webhooks/tylt/h2h/${params.environment}`;
  /** Fresh UUID for each create so TL Pay never sees a repeated merchantOrderId across retries/tests. */
  const tyltMerchantOrderId = randomUUID();

  const email = params.userDetails.email.trim();
  if (!email) {
    throw new Error("Tylt H2H create requires a non-empty userDetails.email");
  }

  const metadata = {
    rail: RAIL,
    tyltProduct: TYLT_PRODUCT_H2H_UPI,
    merchantReturnUrl: params.returnUrl ?? "",
    currencySymbol: params.currencySymbol,
    tyltMerchantOrderId,
  };

  /** India UPI: payer fiat may be INR; merchant wallet always settles USDT. */
  const settlementCurrency = "USDT" as const;

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
    merchantOrderId: tyltMerchantOrderId,
    callBackUrl,
    userEmail: email,
    isKYCNeeded: h2hIsKycNeededForTylt(),
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
    credentialProfile: "india_payin",
  });

  const { instanceId, paymentDetails } = extractH2hCreateResponse(json);

  if (status >= 400 || !instanceId) {
    await db.update(transactions).set({ status: "failed", updatedAt: new Date() }).where(eq(transactions.id, tx.id));
    const hint = h2hCreateFailureHint(status, json);
    const internal = `Tylt H2H create instance failed (${hint})`;
    if (status >= 400 && status < 500) {
      const merchantMsg =
        pickTyltJsonPrimaryMessage(json) ?? "Payment request was declined. Check amounts, currency, and required fields.";
      throw new UpstreamProviderClientError(internal, merchantMsg, status);
    }
    throw new Error(internal);
  }

  const tradeEventId = parseCrossRampEventId(json) ?? null;
  await db
    .update(transactions)
    .set({
      externalId: instanceId,
      metadata: mergeTransactionMetadata(tx.metadata, {
        payinSnapshot: {
          updatedAt: new Date().toISOString(),
          tradeEventId,
          paymentDetails,
          source: "create",
        },
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
      updatedAt: new Date(),
    })
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
    tradeEventId,
    paymentInstructions: extractPaymentInstructionsFromTyltData(paymentDetails),
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
    credentialProfile: "india_payin",
  });
}

export async function tyltH2hGetPaymentMethodsP2pOnRamp(environment: TyltMerchantEnvironment) {
  return tyltSignedGetJson({
    environment,
    path: "/h2h/in/upi/getPaymentMethods_p2pOnRamp",
    queryParams: {},
    credentialProfile: "india_payin",
  });
}

export async function tyltH2hGetCryptoCurrencyListForPrime(environment: TyltMerchantEnvironment) {
  return tyltSignedGetJson({
    environment,
    path: "/h2h/in/upi/getCryptoCurrencyListForPrime",
    queryParams: {},
    credentialProfile: "india_payin",
  });
}

/** Merchant-quoted INR/USDT (and related) rates for pay-in vs pay-out — UI/estimates only; settlement follows the trade. */
export async function tyltH2hGetMerchantRampSpecialRates(environment: TyltMerchantEnvironment) {
  return tyltSignedGetJson({
    environment,
    path: "/h2h/in/upi/getMerchantRampSpecialRates",
    queryParams: {},
    credentialProfile: "india_payin",
  });
}

type PayinSnapshotStored = {
  updatedAt?: string;
  tradeEventId?: number | null;
  paymentDetails?: Record<string, unknown>;
  source?: string;
};

function readPayinSnapshot(meta: Record<string, unknown>): PayinSnapshotStored | null {
  const raw = meta.payinSnapshot;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as PayinSnapshotStored;
}

/**
 * Merchant-facing H2H pay-in status: merges DB snapshot (create/webhook) with live instance pull.
 */
export async function getMerchantH2hPayinStatus(params: {
  merchantId: string;
  environment: TyltMerchantEnvironment;
  transactionId: string;
}) {
  const [tx] = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.id, params.transactionId),
        eq(transactions.merchantId, params.merchantId),
        eq(transactions.environment, params.environment)
      )
    )
    .limit(1);

  if (!tx || tx.type !== "payin") {
    return null;
  }

  const meta = parseTransactionMetadata(tx);
  if (!isTyltH2hPayinMetadata(meta)) {
    return null;
  }

  const cached = readPayinSnapshot(meta);
  let paymentDetails: Record<string, unknown> = cached?.paymentDetails ?? {};
  let tradeEventId: number | null =
    typeof cached?.tradeEventId === "number" ? cached.tradeEventId : null;
  let detailsSource: "live" | "webhook" | "create" =
    cached?.source === "webhook" ? "webhook" : cached?.source === "create" ? "create" : "create";

  const remoteOrderId = resolveTyltPayinMerchantOrderIdForRemote(meta, tx.id);
  const live = await fetchTyltPayinInstanceDetails({
    environment: params.environment,
    merchantOrderId: remoteOrderId,
    instanceId: tx.externalId,
  });

  if (live && live.status < 500) {
    const liveData = extractTyltPayinDataEnvelope(live.json);
    if (liveData) {
      paymentDetails = liveData;
      detailsSource = "live";
      const liveEvent = parseCrossRampEventId(live.json);
      if (liveEvent != null) tradeEventId = liveEvent;
    }
  }

  const paymentInstructions = extractPaymentInstructionsFromTyltData(paymentDetails);
  const expiresAt =
    typeof meta.expiresAt === "string" && meta.expiresAt.trim() ? meta.expiresAt.trim() : null;

  return {
    transactionId: tx.id,
    status: tx.status,
    amount: String(tx.amount),
    currency: tx.currency,
    instanceId: tx.externalId ?? null,
    tradeEventId,
    paymentDetails,
    paymentInstructions,
    detailsSource,
    expiresAt,
  };
}
