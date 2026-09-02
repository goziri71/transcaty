/**
 * Tekko inbound webhooks: HMAC-SHA256(timestamp + "." + rawBody, whsec).
 * Routes NGN permanent VA credits / legacy collections vs PYUSD payment intents.
 * PYUSD: credit PYUSD-USDC only when settlement is complete.
 * NGN VA: credit NGN on customer.wallet.credited with endUserId → merchant mapping.
 * Legacy temp collect: still settle matching tekko-ngn-collect rows until drained.
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
import {
  TEKKO_NGN_PROVIDER,
  isNgnCollectionCredited,
  isNgnCollectionTerminalFailure,
  settleTekkoNgnCollection,
} from "./ngn-collect.js";
import {
  findMerchantIdByTekkoCustomerId,
  findMerchantIdByTekkoNgnVaAccountNumber,
  settleTekkoNgnVaCredit,
} from "./ngn-va.js";
import {
  TEKKO_NGN_PAYOUT_PROVIDER,
  findTekkoNgnPayoutByReference,
  finalizeTekkoNgnPayoutSuccess,
  finalizeTekkoNgnPayoutFailure,
  isNgnWithdrawalSuccess,
  isNgnWithdrawalFailure,
} from "./ngn-payout.js";

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

function resolveWebhookEventType(
  root: Record<string, unknown>,
  eventTypeHint?: string | null
): string | null {
  return (
    strField(root, "type", "event", "eventType", "event_type", "name") ??
    (eventTypeHint?.trim() || null)
  );
}

/** Nested-safe currency for Tekko wallet / VA payloads. */
function resolveWebhookCurrency(data: Record<string, unknown>): string {
  const direct = strField(data, "currency", "asset", "assetCode", "asset_code");
  if (direct) return direct.toUpperCase();
  const wallet = asRecord(data.wallet);
  const fromWallet = strField(wallet, "currency", "asset", "assetCode");
  if (fromWallet) return fromWallet.toUpperCase();
  const va = asRecord(wallet?.virtualAccount) ?? asRecord(data.virtualAccount);
  const fromVa = strField(va, "currency");
  return (fromVa ?? "").toUpperCase();
}

function resolveWebhookAmount(data: Record<string, unknown>): string | null {
  return strField(
    data,
    "netAmount",
    "netCollectedAmount",
    "net_collected_amount",
    "creditedAmount",
    "creditAmount",
    "amount",
    "value",
    "ledgerAmount"
  );
}

function resolveVaAccountNumber(data: Record<string, unknown>): string | null {
  const direct = strField(
    data,
    "accountNumber",
    "account_number",
    "virtualAccountNumber",
    "virtual_account_number",
    "destinationAccountNumber",
    "destination_account_number"
  );
  if (direct) return direct;
  const wallet = asRecord(data.wallet);
  const va =
    asRecord(wallet?.virtualAccount) ??
    asRecord(data.virtualAccount) ??
    asRecord(data.virtual_account);
  return strField(va, "accountNumber", "account_number");
}

function isNgnVaCreditEvent(eventType: string | null): boolean {
  if (!eventType) return false;
  const t = eventType.trim().toLowerCase();
  return (
    t === "customer.wallet.credited" ||
    t === "master_wallet.credited" ||
    t === "customer.deposit.credited" ||
    t.endsWith("wallet.credited") ||
    t.includes("wallet.credited")
  );
}

async function findNgnPayoutTx(params: {
  transactyTransactionId?: string | null;
}): Promise<(typeof transactions.$inferSelect) | null> {
  if (!params.transactyTransactionId) return null;
  const [tx] = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.id, params.transactyTransactionId),
        eq(transactions.provider, TEKKO_NGN_PAYOUT_PROVIDER)
      )
    )
    .limit(1);
  return tx ?? null;
}

async function findNgnTx(params: {
  reference?: string | null;
  transactyTransactionId?: string | null;
}): Promise<(typeof transactions.$inferSelect) | null> {
  if (params.transactyTransactionId) {
    const [tx] = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.id, params.transactyTransactionId),
          eq(transactions.provider, TEKKO_NGN_PROVIDER)
        )
      )
      .limit(1);
    if (tx) return tx;
  }
  if (params.reference) {
    const [tx] = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.externalId, params.reference),
          eq(transactions.provider, TEKKO_NGN_PROVIDER)
        )
      )
      .limit(1);
    if (tx) return tx;
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

async function applyNgnWebhook(params: {
  tx: typeof transactions.$inferSelect;
  eventType: string | null;
  collectionStatus: string | null;
  amount: string | null;
  reference: string | null;
}): Promise<{ merchantId: string; event: WebhookEvent } | null> {
  const { tx, eventType, reference } = params;
  let collectionStatus = params.collectionStatus;
  if (
    !collectionStatus &&
    (eventType === "master_wallet.credited" || eventType === "customer.wallet.credited")
  ) {
    collectionStatus = "credited";
  }

  await db
    .update(transactions)
    .set({
      metadata: mergeMeta(tx.metadata, {
        ...(collectionStatus != null ? { collectionStatus } : {}),
        lastWebhookEvent: eventType,
        lastWebhookAt: new Date().toISOString(),
        ...(params.amount != null ? { webhookAmount: params.amount } : {}),
        ...(reference ? { collectionReference: reference } : {}),
      }),
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, tx.id));

  if (isNgnCollectionCredited(collectionStatus)) {
    const amount = params.amount ?? String(tx.amount);
    return settleTekkoNgnCollection({
      transactionId: tx.id,
      creditedAmount: amount,
      collectionStatus: "credited",
      source: "webhook",
    });
  }

  if (collectionStatus && isNgnCollectionTerminalFailure(collectionStatus) && tx.status === "pending") {
    const [failed] = await db
      .update(transactions)
      .set({
        status: "failed",
        metadata: mergeMeta(tx.metadata, {
          collectionStatus,
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

/**
 * Apply a verified Tekko webhook body. Returns merchant outbound event when state changes.
 */
export async function applyTekkoWebhookPayload(
  parsed: unknown,
  eventTypeHint?: string | null
): Promise<{ merchantId: string; event: WebhookEvent } | null> {
  const root = asRecord(parsed);
  if (!root) return null;

  const eventType = resolveWebhookEventType(root, eventTypeHint);
  const data = asRecord(root.data) ?? root;
  const eventId = strField(root, "id", "eventId", "event_id");

  const currency = resolveWebhookCurrency(data);
  const reference = strField(data, "reference", "collectionReference", "collection_reference");
  const endUserId =
    strField(data, "endUserId", "end_user_id", "customerId", "customer_id") ??
    (typeof data.endUserId === "number" ? String(data.endUserId) : null);
  const vaAccountNumber = resolveVaAccountNumber(data);
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
  const netAmount = resolveWebhookAmount(data);
  const withdrawalStatus = strField(data, "status", "withdrawalStatus", "withdrawal_status");

  // NGN bank payout webhooks (Tekko master-wallet/ng/withdraw).
  if (eventType === "withdrawal.completed" || eventType === "withdrawal.failed") {
    const withdrawRef = strField(data, "reference", "withdrawalReference", "withdrawal_reference");
    let payoutTx = transactyTransactionId
      ? await findNgnPayoutTx({ transactyTransactionId })
      : null;
    if (!payoutTx && withdrawRef) {
      payoutTx = await findTekkoNgnPayoutByReference(withdrawRef);
    }
    if (payoutTx) {
      await db
        .update(transactions)
        .set({
          metadata: mergeMeta(payoutTx.metadata, {
            withdrawalStatus: withdrawalStatus ?? (eventType === "withdrawal.completed" ? "completed" : "failed"),
            lastWebhookEvent: eventType,
            lastWebhookAt: new Date().toISOString(),
          }),
          updatedAt: new Date(),
        })
        .where(eq(transactions.id, payoutTx.id));

      if (eventType === "withdrawal.completed" || isNgnWithdrawalSuccess(withdrawalStatus)) {
        return finalizeTekkoNgnPayoutSuccess({
          transactionId: payoutTx.id,
          withdrawalStatus: withdrawalStatus ?? "completed",
          source: "webhook",
        });
      }
      if (eventType === "withdrawal.failed" || isNgnWithdrawalFailure(withdrawalStatus)) {
        return finalizeTekkoNgnPayoutFailure({
          transactionId: payoutTx.id,
          withdrawalStatus: withdrawalStatus ?? "failed",
          source: "webhook",
        });
      }
    }
    if (currency === "NGN" || withdrawRef) {
      return null;
    }
  }

  // Permanent VA credit: NGN wallet credit with customer / VA identity (not a PYUSD intent).
  if (isNgnVaCreditEvent(eventType) && currency === "NGN" && !paymentIntentId) {
    let merchantId = endUserId ? await findMerchantIdByTekkoCustomerId(endUserId) : null;
    if (!merchantId && vaAccountNumber) {
      merchantId = await findMerchantIdByTekkoNgnVaAccountNumber(vaAccountNumber);
    }

    const hasVaIdentity = Boolean(endUserId || vaAccountNumber);
    if (hasVaIdentity) {
      if (!merchantId) {
        // Fail closed so Tekko retries and ops can fix tekko_customer_id / VA mapping.
        throw new Error(
          `Tekko NGN VA credit: no merchant for endUserId=${endUserId ?? "null"} account=${vaAccountNumber ?? "null"}`
        );
      }
      if (!netAmount) {
        throw new Error(
          `Tekko NGN VA credit: missing amount for merchant=${merchantId} endUserId=${endUserId ?? "null"}`
        );
      }

      const externalReference =
        reference || eventId || `ngn-va-${endUserId ?? vaAccountNumber}-${netAmount}`;
      const settled = await settleTekkoNgnVaCredit({
        merchantId,
        environment: "live",
        amount: netAmount,
        externalReference,
        endUserId,
        source: "webhook",
        eventId,
      });
      if (settled) return { merchantId: settled.merchantId, event: settled.event };
      // Already settled (idempotent) — ok.
      return null;
    }
    // master_wallet.credited with no customer/VA identity — try legacy collect below.
  }

  // Legacy temp collection match when currency/reference indicates collections rail.
  const ngnHint =
    currency === "NGN" ||
    eventType === "master_wallet.credited" ||
    (reference != null && !paymentIntentId);

  if (ngnHint) {
    const ngnTx = await findNgnTx({ reference, transactyTransactionId });
    if (ngnTx) {
      return applyNgnWebhook({
        tx: ngnTx,
        eventType,
        collectionStatus: paymentStatus,
        amount: netAmount,
        reference,
      });
    }
    // NGN credit with no matching legacy collect and no VA mapping — do not mis-route to PYUSD.
    if (!paymentIntentId && currency === "NGN") {
      return null;
    }
  }

  const tx = await findPyusdTx({
    paymentIntentId,
    merchantReference,
    transactyTransactionId,
  });

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
          ...(paymentIntentId ? { paymentIntentId } : {}),
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

    // Paid but not settled yet — no PYUSD-USDC credit.
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
