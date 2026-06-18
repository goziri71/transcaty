import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { merchantUsers } from "../db/schema/index.js";
import { queueTransactionalEmail } from "./transactional-email-queue.js";
import type { WebhookEvent } from "./merchant-webhook.js";

async function merchantUserEmails(merchantId: string): Promise<string[]> {
  const rows = await db
    .select({ email: merchantUsers.email })
    .from(merchantUsers)
    .where(eq(merchantUsers.merchantId, merchantId));
  return [...new Set(rows.map((r) => r.email.trim().toLowerCase()).filter(Boolean))];
}

/** Light payment emails to portal users (alongside webhooks). Best-effort, non-blocking. */
export async function notifyMerchantUsersOfPaymentEvent(
  merchantId: string,
  event: WebhookEvent
): Promise<void> {
  const emails = await merchantUserEmails(merchantId);
  if (emails.length === 0) return;

  const isPayin = event.type.startsWith("payin.");
  const isSuccess = event.type.endsWith(".completed");
  const label = isPayin ? "Pay-in" : "Payout";
  const statusWord = isSuccess ? "completed" : "failed";

  for (const to of emails) {
    await queueTransactionalEmail({
      kind: "merchant_payment_event",
      to,
      eventLabel: label,
      statusWord,
      transactionId: event.transactionId,
      amount: event.amount,
      paidAmount: "paidAmount" in event ? event.paidAmount : undefined,
      platformOrderId: event.platformOrderId,
    });
  }
}
