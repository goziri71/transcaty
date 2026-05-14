/**
 * Pull-based reconciliation for CrossRamp hosted widget when webhooks are delayed or missed.
 */
import { eq } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions } from "../../../src/db/schema/index.js";
import type { WebhookEvent } from "../../../src/lib/merchant-webhook.js";
import { tyltSignedGetJson } from "./client.js";
import type { TyltMerchantEnvironment } from "./config.js";
import {
  applyTyltCrossRampWebhookPayload,
  buildSyntheticCrossRampWebhookPayload,
  parseCrossRampEventId,
  parseCrossRampMerchantOrderId,
  parseTransactionMetadata,
  isTyltCrossRampPayinMetadata,
} from "./crossramp-payin.js";

export async function crossRampGetInstanceDetails(params: {
  environment: TyltMerchantEnvironment;
  merchantOrderId?: string;
  instanceId?: string;
}): Promise<{ status: number; json: unknown }> {
  const qp: Record<string, unknown> = {};
  if (params.merchantOrderId) qp.merchantOrderId = params.merchantOrderId;
  if (params.instanceId) qp.instanceId = params.instanceId;
  return tyltSignedGetJson({
    environment: params.environment,
    path: "/p2pRampsMerchant/getInstanceDetails",
    queryParams: qp,
    credentialRole: "payin",
  });
}

export async function crossRampGetPayinTransactionInformation(params: {
  environment: TyltMerchantEnvironment;
  orderId: string;
}): Promise<{ status: number; json: unknown }> {
  return tyltSignedGetJson({
    environment: params.environment,
    path: "/transactions/merchant/getPayinTransactionInformation",
    queryParams: { orderId: params.orderId },
    credentialRole: "payin",
  });
}

function extractPaidAmountLoose(data: Record<string, unknown>, txObj: Record<string, unknown>): string | undefined {
  const candidates = [
    txObj.settledAmountCredited,
    txObj.settledAmountReceived,
    txObj.paidAmount,
    data.settledAmountCredited,
    data.amount,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() && Number.isFinite(parseFloat(c))) return c.trim();
    if (typeof c === "number" && Number.isFinite(c)) return String(c);
  }
  return undefined;
}

/**
 * Maps pull API JSON (variable shapes) to a webhook-compatible payload for shared finalization logic.
 */
export function normalizeCrossRampRemoteToSyntheticWebhook(
  json: unknown,
  fallbackMerchantOrderId: string
): unknown | null {
  const orderFromWebhook = parseCrossRampMerchantOrderId(json);
  const eventFromWebhook = parseCrossRampEventId(json);
  if (
    eventFromWebhook != null &&
    orderFromWebhook != null &&
    orderFromWebhook === fallbackMerchantOrderId
  ) {
    return json;
  }

  const root = json as Record<string, unknown>;
  const data = (root.data ?? root.result ?? root.payload ?? root) as Record<string, unknown>;

  const nestedEvent =
    ((data.trade as Record<string, unknown> | undefined)?.event as Record<string, unknown> | undefined) ??
    (data.event as Record<string, unknown> | undefined);
  let eventId: number | undefined;
  const rawEv = nestedEvent?.id ?? data.eventId ?? data.event_id ?? root.eventId;
  if (typeof rawEv === "number" && Number.isFinite(rawEv)) eventId = rawEv;
  else if (typeof rawEv === "string" && /^\d+$/.test(rawEv.trim())) eventId = parseInt(rawEv.trim(), 10);

  const txObj = (data.transaction ?? data.tx ?? data.order ?? {}) as Record<string, unknown>;
  const merchantOrderId = String(
    txObj.merchantOrderId ?? data.merchantOrderId ?? data.orderId ?? fallbackMerchantOrderId
  ).trim();

  const statusStr = String(txObj.status ?? data.status ?? data.instanceStatus ?? "").trim();
  const lower = statusStr.toLowerCase();

  if (eventId != null && eventId >= 4 && eventId <= 9) {
    return buildSyntheticCrossRampWebhookPayload({
      merchantOrderId,
      eventId,
      terminalStatus: statusStr || undefined,
      paidAmount: extractPaidAmountLoose(data, txObj),
    });
  }

  if (!statusStr && eventId == null) {
    return null;
  }

  if (
    /pending|processing|waiting|initiated|created/.test(lower) &&
    !/(complete|fail|expir|disput|success|settled)/.test(lower)
  ) {
    return null;
  }

  let inferred: number | undefined;
  if (/(complete|success|settled|paid|credited)/.test(lower)) inferred = 6;
  else if (/disput/.test(lower)) inferred = 5;
  else if (/expir/.test(lower)) inferred = 9;
  else if (/fail|cancel|reject/.test(lower)) inferred = 9;

  if (inferred == null) {
    return null;
  }

  return buildSyntheticCrossRampWebhookPayload({
    merchantOrderId,
    eventId: inferred,
    terminalStatus:
      statusStr || (inferred === 6 ? "Completed" : inferred === 5 ? "Disputed" : "Expired"),
    paidAmount: extractPaidAmountLoose(data, txObj),
  });
}

export type TyltCrossRampReconcileSource =
  | "getInstanceDetails:merchantOrderId"
  | "getInstanceDetails:instanceId"
  | "getPayinTransactionInformation";

export type ReconcileCrossRampPayinResult =
  | {
      outcome: "finalized";
      transactionId: string;
      merchantWebhook: { merchantId: string; event: WebhookEvent };
      sourcesTried: TyltCrossRampReconcileSource[];
    }
  | {
      outcome: "not_terminal";
      transactionId: string;
      sourcesTried: TyltCrossRampReconcileSource[];
      detail: string;
    }
  | {
      outcome: "skipped";
      transactionId: string;
      reason: "already_terminal" | "wrong_rail";
    }
  | {
      outcome: "error";
      detail: string;
    };

/**
 * Call Tylt pull APIs and finalize a pending CrossRamp pay-in when remote state is terminal.
 * Idempotent: if already success/failed, outcome is skipped.
 */
export async function reconcileCrossRampPayinByTransactionId(
  transactionId: string
): Promise<ReconcileCrossRampPayinResult> {
  const [tx] = await db.select().from(transactions).where(eq(transactions.id, transactionId)).limit(1);
  if (!tx) {
    return { outcome: "error", detail: "transaction_not_found" };
  }
  if (tx.type !== "payin") {
    return { outcome: "error", detail: "not_payin" };
  }

  const meta = parseTransactionMetadata(tx);
  if (!isTyltCrossRampPayinMetadata(meta)) {
    return { outcome: "skipped", transactionId: tx.id, reason: "wrong_rail" };
  }

  if (tx.status !== "pending") {
    return { outcome: "skipped", transactionId: tx.id, reason: "already_terminal" };
  }

  const env = tx.environment as TyltMerchantEnvironment;
  const sourcesTried: TyltCrossRampReconcileSource[] = [];

  let synthetic: unknown | null = null;

  const r1 = await crossRampGetInstanceDetails({ environment: env, merchantOrderId: tx.id });
  sourcesTried.push("getInstanceDetails:merchantOrderId");
  if (r1.status < 500) {
    synthetic = normalizeCrossRampRemoteToSyntheticWebhook(r1.json, tx.id);
  }

  if (!synthetic && tx.externalId) {
    const r1b = await crossRampGetInstanceDetails({ environment: env, instanceId: tx.externalId });
    sourcesTried.push("getInstanceDetails:instanceId");
    if (r1b.status < 500) {
      synthetic = normalizeCrossRampRemoteToSyntheticWebhook(r1b.json, tx.id);
    }
  }

  if (!synthetic) {
    const r2 = await crossRampGetPayinTransactionInformation({ environment: env, orderId: tx.id });
    sourcesTried.push("getPayinTransactionInformation");
    if (r2.status < 500) {
      synthetic = normalizeCrossRampRemoteToSyntheticWebhook(r2.json, tx.id);
    }
  }

  if (!synthetic) {
    return {
      outcome: "not_terminal",
      transactionId: tx.id,
      sourcesTried,
      detail: "remote_state_not_terminal_or_unrecognized_shape",
    };
  }

  const webhook = await applyTyltCrossRampWebhookPayload(synthetic);
  if (!webhook) {
    return {
      outcome: "not_terminal",
      transactionId: tx.id,
      sourcesTried,
      detail: "apply_payload_returned_null",
    };
  }

  return {
    outcome: "finalized",
    transactionId: tx.id,
    merchantWebhook: webhook,
    sourcesTried,
  };
}
