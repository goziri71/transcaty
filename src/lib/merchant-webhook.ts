/**
 * Emit webhooks to merchants when pay-in/payout events complete.
 * Payload is signed with HMAC-SHA256. Header: X-Transacty-Webhook-Signature.
 * Deliveries are logged for dashboard delivery log / replay / last error.
 */
import { createHmac } from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { merchants, merchantWebhookDeliveries } from "../db/schema/index.js";
import { decrypt } from "./encryption.js";
import type { transactionFeesSchema } from "./billing/transaction-fee-breakdown.js";
import type { z } from "zod";

type WebhookFees = z.infer<typeof transactionFeesSchema>;

export type WebhookFeeFields = {
  currency?: string;
  fees?: WebhookFees;
  netAmount?: string;
  totalWalletDebit?: string;
};

export type WebhookEvent =
  | ({
      type: "payin.completed";
      transactionId: string;
      status: string;
      amount: string;
      paidAmount: string;
      platformOrderId: string | null;
    } & WebhookFeeFields)
  | ({
      type: "payin.failed";
      transactionId: string;
      status: string;
      amount: string;
      platformOrderId: string | null;
    } & WebhookFeeFields)
  | ({
      type: "payout.completed";
      transactionId: string;
      status: string;
      amount: string;
      platformOrderId: string | null;
    } & WebhookFeeFields)
  | ({
      type: "payout.failed";
      transactionId: string;
      status: string;
      amount: string;
      platformOrderId: string | null;
    } & WebhookFeeFields)
  | {
      type: "webhook.test";
      transactionId: string;
      status: string;
      amount: string;
      platformOrderId: string | null;
    };

const JOB_NAME = "merchant-webhook";
const RESPONSE_BODY_MAX = 2000;

export function getMerchantWebhookJobName(): string {
  return JOB_NAME;
}

export async function queueMerchantWebhook(merchantId: string, event: WebhookEvent): Promise<void> {
  const { queue } = await import("./queue.js");
  await queue.send(JOB_NAME, { merchantId, event }, { retryLimit: 5, retryDelay: 60 });
  if (event.type !== "webhook.test") {
    const { notifyMerchantUsersOfPaymentEvent } = await import("./merchant-payment-email.js");
    void notifyMerchantUsersOfPaymentEvent(merchantId, event as Exclude<WebhookEvent, { type: "webhook.test" }>).catch(
      () => {}
    );
  }
}

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

function buildPayloadString(event: WebhookEvent): string {
  return JSON.stringify({
    event: event.type,
    transactionId: event.transactionId,
    status: event.status,
    amount: event.amount,
    ...("paidAmount" in event && { paidAmount: event.paidAmount }),
    ...("platformOrderId" in event && { platformOrderId: event.platformOrderId }),
    ...("currency" in event && event.currency ? { currency: event.currency } : {}),
    ...("fees" in event && event.fees ? { fees: event.fees } : {}),
    ...("netAmount" in event && event.netAmount != null ? { netAmount: event.netAmount } : {}),
    ...("totalWalletDebit" in event && event.totalWalletDebit != null
      ? { totalWalletDebit: event.totalWalletDebit }
      : {}),
    timestamp: new Date().toISOString(),
  });
}

async function resolveMerchantWebhookAuth(merchantId: string): Promise<{
  url: string;
  secret: string;
} | null> {
  const [merchant] = await db
    .select({ webhookUrl: merchants.webhookUrl, webhookSecretEnc: merchants.webhookSecretEnc })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);

  if (!merchant?.webhookUrl?.trim()) return null;

  const masterKey = process.env.ENCRYPTION_MASTER_KEY;
  if (!masterKey || !merchant.webhookSecretEnc) return null;
  try {
    const secret = decrypt(merchant.webhookSecretEnc.trim(), masterKey.trim());
    return { url: merchant.webhookUrl.trim(), secret };
  } catch {
    return null;
  }
}

async function postSignedWebhook(params: {
  url: string;
  secret: string;
  payload: string;
  eventType: string;
}): Promise<{ ok: boolean; httpStatus: number; responseBody: string }> {
  const signature = signPayload(params.payload, params.secret);
  const res = await fetch(params.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Transacty-Webhook-Signature": signature,
      "X-Transacty-Event": params.eventType,
    },
    body: params.payload,
  });
  const responseBody = (await res.text()).slice(0, RESPONSE_BODY_MAX);
  return { ok: res.ok, httpStatus: res.status, responseBody };
}

export async function sendMerchantWebhook(merchantId: string, event: WebhookEvent): Promise<void> {
  const auth = await resolveMerchantWebhookAuth(merchantId);
  if (!auth) return;

  const payload = buildPayloadString(event);
  const [delivery] = await db
    .insert(merchantWebhookDeliveries)
    .values({
      merchantId,
      eventType: event.type,
      transactionId: event.transactionId || null,
      payload,
      targetUrl: auth.url,
      status: "pending",
      attempt: 1,
    })
    .returning({ id: merchantWebhookDeliveries.id });

  try {
    const result = await postSignedWebhook({
      url: auth.url,
      secret: auth.secret,
      payload,
      eventType: event.type,
    });

    await db
      .update(merchantWebhookDeliveries)
      .set({
        status: result.ok ? "success" : "failed",
        httpStatus: result.httpStatus,
        responseBody: result.responseBody || null,
        error: result.ok ? null : `HTTP ${result.httpStatus}`,
        deliveredAt: result.ok ? new Date() : null,
      })
      .where(eq(merchantWebhookDeliveries.id, delivery!.id));

    if (!result.ok) {
      throw new Error(`Webhook delivery failed: ${result.httpStatus} ${result.responseBody}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(merchantWebhookDeliveries)
      .set({
        status: "failed",
        error: message.slice(0, 2000),
      })
      .where(eq(merchantWebhookDeliveries.id, delivery!.id));
    throw err;
  }
}

export async function listMerchantWebhookDeliveries(params: {
  merchantId: string;
  limit?: number;
  offset?: number;
  status?: "pending" | "success" | "failed";
}): Promise<{
  items: Array<{
    id: string;
    eventType: string;
    transactionId: string | null;
    targetUrl: string;
    status: string;
    httpStatus: number | null;
    responseBody: string | null;
    error: string | null;
    attempt: number;
    createdAt: string;
    deliveredAt: string | null;
  }>;
  total: number;
  lastError: string | null;
}> {
  const limit = params.limit ?? 20;
  const offset = params.offset ?? 0;
  const conditions = [eq(merchantWebhookDeliveries.merchantId, params.merchantId)];
  if (params.status) conditions.push(eq(merchantWebhookDeliveries.status, params.status));

  const [[totalResult], rows, [lastFailed]] = await Promise.all([
    db
      .select({ count: count() })
      .from(merchantWebhookDeliveries)
      .where(and(...conditions)),
    db
      .select({
        id: merchantWebhookDeliveries.id,
        eventType: merchantWebhookDeliveries.eventType,
        transactionId: merchantWebhookDeliveries.transactionId,
        targetUrl: merchantWebhookDeliveries.targetUrl,
        status: merchantWebhookDeliveries.status,
        httpStatus: merchantWebhookDeliveries.httpStatus,
        responseBody: merchantWebhookDeliveries.responseBody,
        error: merchantWebhookDeliveries.error,
        attempt: merchantWebhookDeliveries.attempt,
        createdAt: merchantWebhookDeliveries.createdAt,
        deliveredAt: merchantWebhookDeliveries.deliveredAt,
      })
      .from(merchantWebhookDeliveries)
      .where(and(...conditions))
      .orderBy(desc(merchantWebhookDeliveries.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ error: merchantWebhookDeliveries.error })
      .from(merchantWebhookDeliveries)
      .where(
        and(
          eq(merchantWebhookDeliveries.merchantId, params.merchantId),
          eq(merchantWebhookDeliveries.status, "failed")
        )
      )
      .orderBy(desc(merchantWebhookDeliveries.createdAt))
      .limit(1),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      transactionId: r.transactionId,
      targetUrl: r.targetUrl,
      status: r.status,
      httpStatus: r.httpStatus,
      responseBody: r.responseBody,
      error: r.error,
      attempt: r.attempt,
      createdAt: r.createdAt.toISOString(),
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
    })),
    total: Number(totalResult?.count ?? 0),
    lastError: lastFailed?.error ?? null,
  };
}

export async function replayMerchantWebhookDelivery(params: {
  merchantId: string;
  deliveryId: string;
}): Promise<{ id: string; status: string }> {
  const [existing] = await db
    .select()
    .from(merchantWebhookDeliveries)
    .where(
      and(
        eq(merchantWebhookDeliveries.id, params.deliveryId),
        eq(merchantWebhookDeliveries.merchantId, params.merchantId)
      )
    )
    .limit(1);

  if (!existing) {
    const err = new Error("Delivery not found");
    (err as Error & { statusCode?: number }).statusCode = 404;
    throw err;
  }

  const auth = await resolveMerchantWebhookAuth(params.merchantId);
  if (!auth) {
    const err = new Error("Webhook URL or secret is not configured");
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }

  const [delivery] = await db
    .insert(merchantWebhookDeliveries)
    .values({
      merchantId: params.merchantId,
      eventType: existing.eventType,
      transactionId: existing.transactionId,
      payload: existing.payload,
      targetUrl: auth.url,
      status: "pending",
      attempt: (existing.attempt ?? 1) + 1,
    })
    .returning({ id: merchantWebhookDeliveries.id });

  try {
    const result = await postSignedWebhook({
      url: auth.url,
      secret: auth.secret,
      payload: existing.payload,
      eventType: existing.eventType,
    });
    await db
      .update(merchantWebhookDeliveries)
      .set({
        status: result.ok ? "success" : "failed",
        httpStatus: result.httpStatus,
        responseBody: result.responseBody || null,
        error: result.ok ? null : `HTTP ${result.httpStatus}`,
        deliveredAt: result.ok ? new Date() : null,
      })
      .where(eq(merchantWebhookDeliveries.id, delivery!.id));
    if (!result.ok) {
      return { id: delivery!.id, status: "failed" };
    }
    return { id: delivery!.id, status: "success" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(merchantWebhookDeliveries)
      .set({ status: "failed", error: message.slice(0, 2000) })
      .where(eq(merchantWebhookDeliveries.id, delivery!.id));
    return { id: delivery!.id, status: "failed" };
  }
}

export async function sendMerchantWebhookTestPing(merchantId: string): Promise<{ id: string; status: string }> {
  const event: WebhookEvent = {
    type: "webhook.test",
    transactionId: "00000000-0000-0000-0000-000000000000",
    status: "success",
    amount: "0.00",
    platformOrderId: null,
  };
  try {
    await sendMerchantWebhook(merchantId, event);
  } catch {
    /* delivery row already records failure */
  }
  const [latest] = await db
    .select({
      id: merchantWebhookDeliveries.id,
      status: merchantWebhookDeliveries.status,
    })
    .from(merchantWebhookDeliveries)
    .where(
      and(
        eq(merchantWebhookDeliveries.merchantId, merchantId),
        eq(merchantWebhookDeliveries.eventType, "webhook.test")
      )
    )
    .orderBy(desc(merchantWebhookDeliveries.createdAt))
    .limit(1);

  if (!latest) {
    const err = new Error("Webhook URL or secret is not configured");
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }
  return { id: latest.id, status: latest.status };
}
