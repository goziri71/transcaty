/**
 * Tylt CrossRamp UPI pay-in: create hosted instance, finalize on signed webhook only.
 */
import { and, eq, or, sql } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions, wallets, ledgerEntries } from "../../../src/db/schema/index.js";
import { audit } from "../../../src/lib/audit.js";
import { tryApplyTransactionFee } from "../../../src/lib/billing/index.js";
import { addAmount } from "../../../src/lib/money.js";
import type { WebhookEvent } from "../../../src/lib/merchant-webhook.js";
import { tyltSignedGetJson, tyltSignedPostJson } from "./client.js";
import type { TyltMerchantEnvironment } from "./config.js";

const RAIL = "tylt";
/** Hosted CrossRamp widget pay-in (§4.1). */
export const TYLT_PRODUCT_CROSSRAMP = "crossramp_upi";
/** Host-to-host UPI pay-in (§4.2). */
export const TYLT_PRODUCT_H2H_UPI = "h2h_upi";

const TYLT_UPI_PAYIN_PRODUCTS = new Set<string>([TYLT_PRODUCT_CROSSRAMP, TYLT_PRODUCT_H2H_UPI]);

export function isTyltUpiPayinMetadata(meta: Record<string, unknown>): boolean {
  return meta.rail === RAIL && TYLT_UPI_PAYIN_PRODUCTS.has(String(meta.tyltProduct));
}

const SUCCESS_EVENT_IDS = new Set([4, 6]);
const FAILURE_EVENT_IDS = new Set([5, 9]);
type CrossRampTerminalDecision = "success" | "failed" | "non_terminal" | "unknown";

type CreateInstanceBody = {
  merchantOrderId: string;
  callBackUrl: string;
  redirectUrl: string;
  amount: string;
  currencySymbol: "USDT" | "INR";
  isUTRNeeded: 1;
  isKYCNeeded: 0 | 1;
  userEmail?: string;
};

export async function createTyltCrossRampPayinOrder(params: {
  merchantId: string;
  environment: TyltMerchantEnvironment;
  baseUrl: string;
  amount: string;
  currencySymbol: "USDT" | "INR";
  /** Customer redirect after flow (Tylt redirectUrl). */
  returnUrl: string;
  userEmail?: string;
  /** When true, sends isKYCNeeded 0 (requires Tylt admin approval per docs). */
  kycBypass: boolean;
}) {
  const callBackUrl = `${params.baseUrl.replace(/\/$/, "")}/webhooks/tylt/crossramp/${params.environment}`;

  const metadata = {
    rail: RAIL,
    tyltProduct: TYLT_PRODUCT_CROSSRAMP,
    merchantReturnUrl: params.returnUrl,
    currencySymbol: params.currencySymbol,
  };

  const settlementCurrency: "USDT" | "INR" =
    params.currencySymbol === "INR" ? "INR" : "USDT";

  const [tx] = await db
    .insert(transactions)
    .values({
      merchantId: params.merchantId,
      environment: params.environment,
      type: "payin",
      status: "pending",
      amount: params.amount,
      currency: settlementCurrency,
      provider: "tylt-crossramp",
      metadata: JSON.stringify(metadata),
    })
    .returning();

  if (!tx) throw new Error("Failed to create transaction");

  const body: CreateInstanceBody = {
    merchantOrderId: tx.id,
    callBackUrl,
    redirectUrl: params.returnUrl,
    amount: params.amount,
    currencySymbol: params.currencySymbol,
    isUTRNeeded: 1,
    isKYCNeeded: params.kycBypass ? 0 : 1,
  };
  if (params.userEmail?.trim()) {
    body.userEmail = params.userEmail.trim();
  }

  const { status, json } = await tyltSignedPostJson<Record<string, unknown>>({
    environment: params.environment,
    path: "/p2pRampsMerchant/createInstance",
    body: body as unknown as Record<string, unknown>,
    idempotencyKey: tx.id,
    credentialRole: "payin",
  });

  const { instanceId, rampUrl } = extractCreateInstanceResponse(json);

  if (status >= 400 || !instanceId || !rampUrl) {
    await db.update(transactions).set({ status: "failed", updatedAt: new Date() }).where(eq(transactions.id, tx.id));
    throw new Error("Tylt create instance failed");
  }

  await db
    .update(transactions)
    .set({ externalId: instanceId, updatedAt: new Date() })
    .where(eq(transactions.id, tx.id));

  audit({
    action: "payment.created",
    resource: tx.id,
    merchantId: params.merchantId,
    meta: { instanceId, rail: RAIL, product: TYLT_PRODUCT_CROSSRAMP },
  });

  return {
    transactionId: tx.id,
    instanceId,
    rampUrl,
    amount: params.amount,
    currency: settlementCurrency,
  };
}

function extractCreateInstanceResponse(json: unknown): { instanceId: string; rampUrl: string } {
  const root = json as Record<string, unknown>;
  const data = (root.data ?? root.result ?? root) as Record<string, unknown>;
  const instanceId = String(data.instanceId ?? data.instance_id ?? "").trim();
  const rampUrl = String(
    data.url ?? data.redirectUrl ?? data.widgetUrl ?? data.rampUrl ?? data.paymentUrl ?? ""
  ).trim();
  return { instanceId, rampUrl };
}

function readMetadata(tx: { metadata: string | null }): Record<string, unknown> {
  if (!tx.metadata) return {};
  try {
    return JSON.parse(tx.metadata) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function parseTransactionMetadata(tx: { metadata: string | null }): Record<string, unknown> {
  return readMetadata(tx);
}

/**
 * `merchantOrderId` sent to TL Pay on create: stored as `metadata.tyltMerchantOrderId` (H2H);
 * hosted CrossRamp uses `transactions.id` only.
 */
export function resolveTyltPayinMerchantOrderIdForRemote(meta: Record<string, unknown>, txId: string): string {
  const raw = meta.tyltMerchantOrderId;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return txId;
}

export async function selectPayinTxByMerchantOrderRef(orderRef: string) {
  const [row] = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.type, "payin"),
        or(eq(transactions.id, orderRef), sql`(metadata::jsonb->>'tyltMerchantOrderId') = ${orderRef}`)
      )
    )
    .limit(1);
  return row ?? null;
}

export function isTyltCrossRampPayinMetadata(meta: Record<string, unknown>): boolean {
  return meta.rail === RAIL && meta.tyltProduct === TYLT_PRODUCT_CROSSRAMP;
}

/** Minimal webhook-shaped payload for reconcile when pull APIs do not match callback envelope. */
export function buildSyntheticCrossRampWebhookPayload(params: {
  merchantOrderId: string;
  eventId: number;
  terminalStatus?: string;
  transactionType?: string;
  paidAmount?: string;
}): unknown {
  const transaction: Record<string, unknown> = {
    merchantOrderId: params.merchantOrderId,
    status: params.terminalStatus ?? "Completed",
  };
  if (params.paidAmount?.trim()) {
    transaction.settledAmountCredited = params.paidAmount.trim();
  }
  return {
    data: {
      trade: { event: { id: params.eventId } },
      accounts: { transactionType: params.transactionType ?? "pay-in" },
      transaction,
    },
  };
}

export function parseCrossRampEventId(payload: unknown): number | undefined {
  const data = (payload as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
  const trade = data?.trade as Record<string, unknown> | undefined;
  const event = trade?.event as Record<string, unknown> | undefined;
  const id = event?.id;
  if (typeof id === "number" && Number.isFinite(id)) return id;
  if (typeof id === "string" && /^\d+$/.test(id.trim())) return parseInt(id.trim(), 10);
  return undefined;
}

export function parseCrossRampMerchantOrderId(payload: unknown): string | undefined {
  const data = (payload as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
  const transaction = data?.transaction as Record<string, unknown> | undefined;
  const id = transaction?.merchantOrderId;
  if (typeof id === "string" && id.trim()) return id.trim();
  return undefined;
}

export function parseTransactionType(payload: unknown): string | undefined {
  const data = (payload as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
  const accounts = data?.accounts as Record<string, unknown> | undefined;
  const t = accounts?.transactionType ?? accounts?.transaction_type;
  return typeof t === "string" ? t : undefined;
}

export function parseTerminalStatus(payload: unknown): string | undefined {
  const data = (payload as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
  const transaction = data?.transaction as Record<string, unknown> | undefined;
  const s = transaction?.status;
  return typeof s === "string" ? s : undefined;
}

export function parseCreditAmount(payload: unknown, fallbackAmount: string): string {
  const data = (payload as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
  const transaction = data?.transaction as Record<string, unknown> | undefined;
  if (!transaction) return fallbackAmount;
  const candidates = [
    transaction.settledAmountCredited,
    transaction.settledAmountReceived,
    transaction.paidAmount,
    transaction.amount,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() && Number.isFinite(parseFloat(c))) return c.trim();
    if (typeof c === "number" && Number.isFinite(c)) return String(c);
  }
  return fallbackAmount;
}

function mergeMeta(existing: string | null, patch: Record<string, unknown>): string {
  const prev = existing ? (readMetadata({ metadata: existing }) as Record<string, unknown>) : {};
  return JSON.stringify({ ...prev, ...patch });
}

function inferCrossRampEventIdFromAnyShape(payload: unknown): number | undefined {
  const direct = parseCrossRampEventId(payload);
  if (direct != null) return direct;
  const root = payload as Record<string, unknown>;
  const data = (root.data ?? root.result ?? root.payload ?? root) as Record<string, unknown>;
  const txObj = (data.transaction ?? data.tx ?? data.order ?? {}) as Record<string, unknown>;
  const nestedEvent =
    ((data.trade as Record<string, unknown> | undefined)?.event as Record<string, unknown> | undefined) ??
    (data.event as Record<string, unknown> | undefined);
  const rawEv = nestedEvent?.id ?? data.eventId ?? data.event_id ?? root.eventId;
  if (typeof rawEv === "number" && Number.isFinite(rawEv)) return rawEv;
  if (typeof rawEv === "string" && /^\d+$/.test(rawEv.trim())) return parseInt(rawEv.trim(), 10);
  const status = String(txObj.status ?? data.status ?? data.instanceStatus ?? "").trim().toLowerCase();
  if (!status) return undefined;
  if (/(complete|success|settled|paid|credited)/.test(status)) return 6;
  if (/disput/.test(status)) return 5;
  if (/expir|fail|cancel|reject/.test(status)) return 9;
  if (/pending|processing|waiting|initiated|created/.test(status)) return 0;
  return undefined;
}

function inferCrossRampStatusFromAnyShape(payload: unknown): string | undefined {
  const direct = parseTerminalStatus(payload);
  if (direct?.trim()) return direct.trim();
  const root = payload as Record<string, unknown>;
  const data = (root.data ?? root.result ?? root.payload ?? root) as Record<string, unknown>;
  const txObj = (data.transaction ?? data.tx ?? data.order ?? {}) as Record<string, unknown>;
  const s = String(txObj.status ?? data.status ?? data.instanceStatus ?? "").trim();
  return s || undefined;
}

function classifyCrossRampDecision(eventId: number | undefined, terminalStatus?: string): CrossRampTerminalDecision {
  if (eventId == null) return "unknown";
  if (eventId <= 3 || eventId === 7 || eventId === 8 || eventId > 9) return "non_terminal";
  if (SUCCESS_EVENT_IDS.has(eventId)) {
    if (terminalStatus && !/^completed$/i.test(terminalStatus.trim())) return "failed";
    return "success";
  }
  if (FAILURE_EVENT_IDS.has(eventId)) return "failed";
  return "unknown";
}

async function fetchRemoteCrossRampDecision(params: {
  environment: TyltMerchantEnvironment;
  merchantOrderId: string;
  instanceId?: string | null;
}): Promise<{ decision: CrossRampTerminalDecision; source: string }> {
  const call1 = await tyltSignedGetJson({
    environment: params.environment,
    path: "/p2pRampsMerchant/getInstanceDetails",
    queryParams: { merchantOrderId: params.merchantOrderId },
    credentialRole: "payin",
  });
  if (call1.status < 500) {
    const decision = classifyCrossRampDecision(
      inferCrossRampEventIdFromAnyShape(call1.json),
      inferCrossRampStatusFromAnyShape(call1.json)
    );
    return { decision, source: "getInstanceDetails:merchantOrderId" };
  }
  if (params.instanceId?.trim()) {
    const call2 = await tyltSignedGetJson({
      environment: params.environment,
      path: "/p2pRampsMerchant/getInstanceDetails",
      queryParams: { instanceId: params.instanceId.trim() },
      credentialRole: "payin",
    });
    if (call2.status < 500) {
      const decision = classifyCrossRampDecision(
        inferCrossRampEventIdFromAnyShape(call2.json),
        inferCrossRampStatusFromAnyShape(call2.json)
      );
      return { decision, source: "getInstanceDetails:instanceId" };
    }
  }
  const call3 = await tyltSignedGetJson({
    environment: params.environment,
    path: "/transactions/merchant/getPayinTransactionInformation",
    queryParams: { orderId: params.merchantOrderId },
    credentialRole: "payin",
  });
  if (call3.status < 500) {
    const decision = classifyCrossRampDecision(
      inferCrossRampEventIdFromAnyShape(call3.json),
      inferCrossRampStatusFromAnyShape(call3.json)
    );
    return { decision, source: "getPayinTransactionInformation" };
  }
  return { decision: "unknown", source: "upstream_5xx" };
}

export async function getOrCreateMerchantWallet(params: {
  merchantId: string;
  environment: TyltMerchantEnvironment;
  currency: string;
}) {
  const [existing] = await db
    .select()
    .from(wallets)
    .where(
      and(
        eq(wallets.merchantId, params.merchantId),
        eq(wallets.environment, params.environment),
        eq(wallets.type, "merchant"),
        eq(wallets.currency, params.currency),
        eq(wallets.status, "active")
      )
    )
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(wallets)
    .values({
      merchantId: params.merchantId,
      environment: params.environment,
      type: "merchant",
      currency: params.currency,
      balance: "0",
      status: "active",
    })
    .returning();
  if (!created) throw new Error("Failed to create merchant wallet");
  return created;
}

/**
 * Apply verified Tylt UPI pay-in webhook payload (CrossRamp hosted + H2H). Caller must verify HMAC first.
 * Non-terminal events return null (no merchant webhook).
 */
export async function applyTyltCrossRampWebhookPayload(
  parsed: unknown
): Promise<{ merchantId: string; event: WebhookEvent } | null> {
  const eventId = parseCrossRampEventId(parsed);
  const merchantOrderId = parseCrossRampMerchantOrderId(parsed);

  if (eventId == null || merchantOrderId == null) {
    return null;
  }

  /** Progress-only UPI events (docs): ignore until terminal. */
  const callbackDecision = classifyCrossRampDecision(eventId);
  if (callbackDecision === "non_terminal" || callbackDecision === "unknown") {
    return null;
  }

  const tx = await selectPayinTxByMerchantOrderRef(merchantOrderId);

  if (!tx) {
    return null;
  }

  const meta = readMetadata(tx);
  if (!isTyltUpiPayinMetadata(meta)) {
    return null;
  }

  const txType = parseTransactionType(parsed);
  if (txType && txType.toLowerCase() !== "pay-in" && txType.toLowerCase() !== "payin") {
    return null;
  }

  if (tx.status !== "pending") {
    return null;
  }

  const terminalStatus = parseTerminalStatus(parsed);
  const callbackDecisionWithStatus = classifyCrossRampDecision(eventId, terminalStatus);
  const tyltMerchantOrderIdForRemote = resolveTyltPayinMerchantOrderIdForRemote(meta, tx.id);
  const remote = await fetchRemoteCrossRampDecision({
    environment: tx.environment as TyltMerchantEnvironment,
    merchantOrderId: tyltMerchantOrderIdForRemote,
    instanceId: tx.externalId,
  });
  if (remote.decision !== callbackDecisionWithStatus) {
    await db
      .update(transactions)
      .set({
        metadata: mergeMeta(tx.metadata, {
          reviewRequired: true,
          reviewReason: "tylt_callback_remote_mismatch",
          callbackDecision: callbackDecisionWithStatus,
          callbackEventId: eventId,
          callbackStatusRaw: terminalStatus ?? null,
          remoteDecision: remote.decision,
          remoteSource: remote.source,
          reviewMarkedAt: new Date().toISOString(),
        }),
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, tx.id));
    audit({
      action: "provider.transaction.reconciled",
      resource: tx.id,
      merchantId: tx.merchantId,
      meta: {
        product: meta.tyltProduct,
        reason: "callback_remote_mismatch",
        callbackDecision: callbackDecisionWithStatus,
        callbackEventId: eventId,
        callbackStatusRaw: terminalStatus ?? null,
        remoteDecision: remote.decision,
        remoteSource: remote.source,
      },
    });
    return null;
  }

  if (SUCCESS_EVENT_IDS.has(eventId)) {
    if (terminalStatus && !/^completed$/i.test(terminalStatus.trim())) {
      const [failed] = await db
        .update(transactions)
        .set({ status: "failed", updatedAt: new Date() })
        .where(and(eq(transactions.id, tx.id), eq(transactions.status, "pending")))
        .returning({ id: transactions.id });
      if (!failed) return null;
      audit({
        action: "payment.failed",
        resource: tx.id,
        merchantId: tx.merchantId,
        meta: { reason: "tylt_status_mismatch", eventId, terminalStatus },
      });
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

    const paidAmount = parseCreditAmount(parsed, String(tx.amount));

    // Resolve the wallet outside the transaction (idempotent) so we never hold
    // a row lock while the wallet may need to be created on first payin.
    const wallet = await getOrCreateMerchantWallet({
      merchantId: tx.merchantId,
      environment: tx.environment,
      currency: tx.currency,
    });

    const result = await db.transaction(async (txDb) => {
      const [updated] = await txDb
        .update(transactions)
        .set({
          status: "success",
          paidAmount,
          updatedAt: new Date(),
        })
        .where(and(eq(transactions.id, tx.id), eq(transactions.status, "pending")))
        .returning();

      if (!updated) {
        return null;
      }

      if (!wallet) {
        return { walletCredited: false as const };
      }

      const [lockedWallet] = await txDb
        .select()
        .from(wallets)
        .where(eq(wallets.id, wallet.id))
        .for("update")
        .limit(1);

      if (!lockedWallet) {
        return { walletCredited: false as const };
      }

      await txDb.insert(ledgerEntries).values({
        walletId: lockedWallet.id,
        environment: tx.environment,
        amount: String(paidAmount),
        direction: "credit",
        type: "payin",
        referenceId: tx.id,
      });

      await txDb
        .update(wallets)
        .set({
          balance: addAmount(lockedWallet.balance, String(paidAmount)),
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, lockedWallet.id));

      await tryApplyTransactionFee(
        {
          merchantId: tx.merchantId,
          transactionId: tx.id,
          environment: tx.environment,
          amount: String(paidAmount),
          feeType: "payin",
        },
        txDb
      );

      return { walletCredited: true as const };
    });

    if (!result) {
      return null;
    }

    audit({
      action: "payment.completed",
      resource: tx.id,
      merchantId: tx.merchantId,
      meta: { paidAmount, instanceId: tx.externalId, eventId, product: meta.tyltProduct },
    });

    return {
      merchantId: tx.merchantId,
      event: {
        type: "payin.completed",
        transactionId: tx.id,
        status: "success",
        amount: String(tx.amount),
        paidAmount: String(paidAmount),
        platformOrderId: tx.externalId ?? null,
      },
    };
  }

  if (FAILURE_EVENT_IDS.has(eventId)) {
    const [failed] = await db
      .update(transactions)
      .set({ status: "failed", updatedAt: new Date() })
      .where(and(eq(transactions.id, tx.id), eq(transactions.status, "pending")))
      .returning({ id: transactions.id });

    if (!failed) {
      return null;
    }

    audit({
      action: "payment.failed",
      resource: tx.id,
      merchantId: tx.merchantId,
      meta: { reason: "tylt_terminal_failure", eventId },
    });

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
