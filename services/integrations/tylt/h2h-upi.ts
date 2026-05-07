/**
 * Tylt H2H UPI pay-in (§4.2): API-led flow; credits use same signed webhook + ledger path as CrossRamp UPI.
 */
import { eq } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions } from "../../../src/db/schema/index.js";
import { audit } from "../../../src/lib/audit.js";
import { tyltSignedGetJson, tyltSignedPostJson } from "./client.js";
import type { TyltMerchantEnvironment } from "./config.js";
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

export async function createTyltH2hPayinInstance(params: {
  merchantId: string;
  environment: TyltMerchantEnvironment;
  baseUrl: string;
  amount: string;
  currencySymbol: "USDT" | "INR";
  /** Optional redirect when Tylt expects redirectUrl for mobile/browser flows. */
  returnUrl?: string;
  userEmail?: string;
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
      metadata: JSON.stringify(metadata),
    })
    .returning();

  if (!tx) throw new Error("Failed to create transaction");

  const body: Record<string, unknown> = {
    merchantOrderId: tx.id,
    callBackUrl,
    amount: params.amount,
    currencySymbol: params.currencySymbol,
    isUTRNeeded: 1,
    isKYCNeeded: params.kycBypass ? 0 : 1,
  };
  if (params.returnUrl?.trim()) {
    body.redirectUrl = params.returnUrl.trim();
  }
  if (params.userEmail?.trim()) {
    body.userEmail = params.userEmail.trim();
  }

  const { status, json } = await tyltSignedPostJson<Record<string, unknown>>({
    environment: params.environment,
    path: "/h2h/in/upi/createPayinInstance",
    body,
    idempotencyKey: tx.id,
  });

  const { instanceId, paymentDetails } = extractH2hCreateResponse(json);

  if (status >= 400 || !instanceId) {
    await db.update(transactions).set({ status: "failed", updatedAt: new Date() }).where(eq(transactions.id, tx.id));
    throw new Error("Tylt H2H create instance failed");
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
  });
}

export async function tyltH2hGetPaymentMethodsP2pOnRamp(environment: TyltMerchantEnvironment) {
  return tyltSignedGetJson({
    environment,
    path: "/h2h/in/upi/getPaymentMethods_p2pOnRamp",
    queryParams: {},
  });
}

export async function tyltH2hGetCryptoCurrencyListForPrime(environment: TyltMerchantEnvironment) {
  return tyltSignedGetJson({
    environment,
    path: "/h2h/in/upi/getCryptoCurrencyListForPrime",
    queryParams: {},
  });
}
