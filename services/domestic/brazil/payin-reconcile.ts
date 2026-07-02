/**
 * Pull Payok pay-in status for Brazil (PIX) and apply handlePayinCallback when terminal.
 */
import { eq } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions } from "../../../src/db/schema/index.js";
import { payokPayinInquiry } from "../bangladesh/provider/client.js";
import {
  getDefaultPayokEnvironment,
  type PayokEnvironment,
} from "../bangladesh/provider/config.js";
import { handlePayinCallback } from "./payin.js";
import type { ReconcilePayokPayinResult } from "../bangladesh/payin-reconcile.js";

function resolvePayokEnvironment(metadata: string | null, txEnvironment: string): PayokEnvironment {
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata) as { environment?: string };
      if (parsed.environment === "test" || parsed.environment === "live") {
        return parsed.environment;
      }
    } catch {
      // fall through
    }
  }
  if (txEnvironment === "test" || txEnvironment === "live") {
    return txEnvironment;
  }
  return getDefaultPayokEnvironment();
}

function isPayokBrazilPayin(provider: string | null): boolean {
  return provider === "payok-br-payin";
}

function isTerminalPayokOutcome(code?: string, status?: string): boolean {
  if (code === "SUCCESS" && status === "SUCCESS") return true;
  if (code === "FAIL" || status === "FAILED" || status === "FAIL") return true;
  return false;
}

export async function reconcileBrazilPayokPayinByTransactionId(
  transactionId: string
): Promise<ReconcilePayokPayinResult> {
  const [tx] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, transactionId))
    .limit(1);

  if (!tx) {
    return { outcome: "error", detail: "transaction_not_found" };
  }
  if (tx.type !== "payin") {
    return { outcome: "error", detail: "not_payin" };
  }
  if (!isPayokBrazilPayin(tx.provider)) {
    return { outcome: "skipped", transactionId: tx.id, reason: "wrong_rail" };
  }
  if (tx.status !== "pending") {
    return { outcome: "skipped", transactionId: tx.id, reason: "already_terminal" };
  }

  const payokEnvironment = resolvePayokEnvironment(tx.metadata, tx.environment);
  let inquiryStatus: number;
  let inquiryBody: unknown;
  try {
    const res = await payokPayinInquiry(tx.id, payokEnvironment);
    inquiryStatus = res.status;
    inquiryBody = res.body;
  } catch {
    return { outcome: "error", detail: "payok_inquiry_failed" };
  }

  if (inquiryStatus !== 200) {
    return { outcome: "error", detail: `payok_inquiry_http_${inquiryStatus}` };
  }

  const payload = (inquiryBody ?? {}) as Record<string, unknown>;
  const code = typeof payload.code === "string" ? payload.code : undefined;
  const payokStatus = typeof payload.status === "string" ? payload.status : undefined;

  if (!isTerminalPayokOutcome(code, payokStatus)) {
    return {
      outcome: "not_terminal",
      transactionId: tx.id,
      payokCode: code ?? null,
      payokStatus: payokStatus ?? null,
      detail: "payok_still_pending_or_unknown",
    };
  }

  const callbackCode = code === "SUCCESS" && payokStatus === "SUCCESS" ? "SUCCESS" : "FAIL";
  const callbackStatus = callbackCode;

  const merchantWebhook = await handlePayinCallback({
    code: callbackCode,
    status: callbackStatus,
    merchantOrderId: tx.id,
    platformOrderId:
      (typeof payload.platformOrderId === "string" ? payload.platformOrderId : undefined) ??
      tx.externalId ??
      undefined,
    amount: String(payload.amount ?? tx.amount),
    paidAmount: String(payload.paidAmount ?? payload.amount ?? tx.amount),
    paymentMethodCode:
      typeof payload.paymentMethodCode === "string" ? payload.paymentMethodCode : undefined,
  });

  return {
    outcome: "finalized",
    transactionId: tx.id,
    merchantWebhook,
    payokCode: code ?? null,
    payokStatus: payokStatus ?? null,
  };
}
