/**
 * Tekko inbound webhooks: HMAC-SHA256(timestamp + "." + rawBody, whsec).
 * PYUSD: credit USDC only when settlement is complete.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions } from "../../../src/db/schema/index.js";
import type { WebhookEvent } from "../../../src/lib/merchant-webhook.js";
import { getTekkoLiveConfig } from "./config.js";
import {
  TEKKO_PYUSD_PROVIDER,
  isSettlementComplete,
  isTerminalFailure,
  settleTekkoPyusdTransaction,
} from "./pyusd-payin.js";

const MAX_SKEW_MS = 5 * 60 * 1000;

export function verifyTekkoWebhookSignature(params: {
  secret: string;
  timestamp: string;
  signature: string;
  rawBody: string;
}): boolean {
  if (!params.secret || !params.timestamp || !params.signature) return false;
  const ts = Number(params.timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() - ts) > MAX_SKEW_MS) return false;

  const signed = `${params.timestamp}.${params.rawBody}`;
  const expected = createHmac("sha256", params.secret).update(signed, "utf8").digest("hex");
  try {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(params.signature.trim(), "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function readTekkoWebhookHeaders(headers: Record<string, string | string[] | undefined>): {
  timestamp: string | null;
  signature: string | null;
  event: string | null;
} {
  const pick = (name: string): string | null => {
    const v = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : null;
    return typeof v === "string" ? v : null;
  };
  return {
    timestamp: pick("x-tekko-timestamp"),
    signature: pick("x-tekko-signature"),
    event: pick("x-tekko-event"),
  };
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mergeMeta(raw: string | null, patch: Record<string, unknown>): string {
  return JSON.stringify({ ...parseMeta(raw), ...patch });
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function strField(obj: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

async function findPyusdTx(params: {
  paymentIntentId?: string | null;
  merchantReference?: string | null;
  transactyTransactionId?: string | null;
}): Promise<(typeof transactions.$inferSelect) | null> {
  if (params.transactyTransactionId) {
    const [tx] = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.id, params.transactyTransactionId),
          eq(transactions.provider, TEKKO_PYUSD_PROVIDER)
        )
      )
      .limit(1);
    if (tx) return tx;
  }
  if (params.paymentIntentId) {
    const [tx] = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.externalId, params.paymentIntentId),
          eq(transactions.provider, TEKKO_PYUSD_PROVIDER)
        )
      )
      .limit(1);
    if (tx) return tx;
  }
  return null;
}

/**
 * Apply a verified Tekko webhook body. Returns merchant outbound event when state changes.
 */
export async function applyTekkoWebhookPayload(
  parsed: unknown,
  eventTypeHint?: string | null
): Promise<{ merchantId: string; event: WebhookEvent } | null> {
  const root = asRecord(parsed);
  if (!root) return null;

  const eventType =
    (typeof root.type === "string" ? root.type : null) ??
    (eventTypeHint?.trim() || null);
  const data = asRecord(root.data) ?? root;

  const paymentIntentId = strField(
    data,
    "paymentIntentId",
    "payment_intent_id",
    "intentId"
  );
  const merchantReference = strField(data, "merchantReference", "merchant_reference");
  const transactyTransactionId = strField(
    data,
    "transactyTransactionId",
    "transactionId"
  );
  const paymentStatus = strField(data, "paymentStatus", "status", "payment_status");
  const settlementStatus = strField(data, "settlementStatus", "settlement_status");
  const netAmount = strField(
    data,
    "netAmount",
    "netCollectedAmount",
    "net_collected_amount",
    "amount"
  );

  const tx = await findPyusdTx({
    paymentIntentId,
    merchantReference,
    transactyTransactionId,
  });

  // master_wallet.credited without a linked intent — ignore for phase 1 ledger
  // (we settle from customer.wallet.credited when settlementStatus=settled, or poll).
  if (!tx) {
    return null;
  }

  if (eventType === "customer.wallet.credited" || eventType === "master_wallet.credited") {
    const pay = paymentStatus ?? "paid";
    const settle = settlementStatus ?? (eventType === "master_wallet.credited" ? "settled" : null);

    await db
      .update(transactions)
      .set({
        metadata: mergeMeta(tx.metadata, {
          paymentStatus: pay,
          ...(settle != null ? { settlementStatus: settle } : {}),
          lastWebhookEvent: eventType,
          lastWebhookAt: new Date().toISOString(),
          ...(netAmount != null ? { webhookNetAmount: netAmount } : {}),
          ...(paymentIntentId
            ? { paymentIntentId: paymentIntentId }
            : {}),
        }),
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, tx.id));

    if (isSettlementComplete(pay, settle ?? undefined)) {
      const amount = netAmount ?? String(tx.amount);
      return settleTekkoPyusdTransaction({
        transactionId: tx.id,
        netUsdcAmount: amount,
        paymentStatus: pay,
        settlementStatus: settle ?? "settled",
        source: "webhook",
      });
    }

    // Paid but not settled yet — no USDC credit.
    return null;
  }

  if (paymentStatus && isTerminalFailure(paymentStatus) && tx.status === "pending") {
    const [failed] = await db
      .update(transactions)
      .set({
        status: "failed",
        metadata: mergeMeta(tx.metadata, {
          paymentStatus,
          settlementStatus,
          failedAt: new Date().toISOString(),
          lastWebhookEvent: eventType,
        }),
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.id, tx.id), eq(transactions.status, "pending")))
      .returning();
    if (!failed) return null;
    return {
      merchantId: tx.merchantId,
      event: {
        type: "payin.failed",
        transactionId: tx.id,
        status: "failed",
        amount: String(tx.amount),
        platformOrderId: tx.externalId ?? null,
      },
    };
  }

  return null;
}

/** True when webhook secret is configured (required in production for Tekko routes). */
export function tekkoWebhookSecretConfigured(): boolean {
  return !!getTekkoLiveConfig()?.webhookSecret?.trim();
}
