/**
 * Emit webhooks to merchants when pay-in/payout events complete.
 * Payload is signed with HMAC-SHA256. Header: X-Transacty-Webhook-Signature.
 */
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { merchants } from "../db/schema/index.js";
import { decrypt } from "./encryption.js";

export type WebhookEvent =
  | { type: "payin.completed"; transactionId: string; status: string; amount: string; paidAmount: string; platformOrderId: string | null }
  | { type: "payin.failed"; transactionId: string; status: string; amount: string; platformOrderId: string | null }
  | { type: "payout.completed"; transactionId: string; status: string; amount: string; platformOrderId: string | null }
  | { type: "payout.failed"; transactionId: string; status: string; amount: string; platformOrderId: string | null };

const JOB_NAME = "merchant-webhook";

export function getMerchantWebhookJobName(): string {
  return JOB_NAME;
}

export async function queueMerchantWebhook(merchantId: string, event: WebhookEvent): Promise<void> {
  const { queue } = await import("./queue.js");
  await queue.send(JOB_NAME, { merchantId, event }, { retryLimit: 5, retryDelay: 60 });
}

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

export async function sendMerchantWebhook(merchantId: string, event: WebhookEvent): Promise<void> {
  const [merchant] = await db
    .select({ webhookUrl: merchants.webhookUrl, webhookSecretEnc: merchants.webhookSecretEnc })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);

  if (!merchant?.webhookUrl?.trim()) return;

  const masterKey = process.env.ENCRYPTION_MASTER_KEY;
  let secret: string;
  try {
    if (!masterKey || !merchant.webhookSecretEnc) return;
    secret = decrypt(merchant.webhookSecretEnc.trim(), masterKey.trim());
  } catch {
    return;
  }

  const payload = JSON.stringify({
    event: event.type,
    transactionId: event.transactionId,
    status: event.status,
    amount: event.amount,
    ...("paidAmount" in event && { paidAmount: event.paidAmount }),
    ...("platformOrderId" in event && { platformOrderId: event.platformOrderId }),
    timestamp: new Date().toISOString(),
  });

  const signature = signPayload(payload, secret);

  const res = await fetch(merchant.webhookUrl.trim(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Transacty-Webhook-Signature": signature,
      "X-Transacty-Event": event.type,
    },
    body: payload,
  });

  if (!res.ok) {
    throw new Error(`Webhook delivery failed: ${res.status} ${await res.text()}`);
  }
}
