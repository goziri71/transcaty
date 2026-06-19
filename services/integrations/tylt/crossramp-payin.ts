/**
 * Tylt CrossRamp UPI pay-in: create hosted instance, finalize on signed webhook only.
 */
import { and, eq, or, sql } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions, wallets, ledgerEntries } from "../../../src/db/schema/index.js";
import { audit } from "../../../src/lib/audit.js";
import { tryApplyTransactionFee } from "../../../src/lib/billing/index.js";
import { addAmount, normalizeMoneyAmountToTwoDecimals, subAmount } from "../../../src/lib/money.js";
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
/** Terminal failure (expired). Event 5 = disputed — non-terminal per integration spec. */
const FAILURE_EVENT_IDS = new Set([9]);
const DISPUTE_EVENT_IDS = new Set([5]);
type CrossRampTerminalDecision = "success" | "failed" | "non_terminal" | "unknown";

export { SUCCESS_EVENT_IDS, FAILURE_EVENT_IDS, DISPUTE_EVENT_IDS };
export function classifyCrossRampDecision(
  eventId: number | undefined,
  terminalStatus?: string
): CrossRampTerminalDecision {
  return classifyCrossRampDecisionImpl(eventId, terminalStatus);
}

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
    credentialProfile: "india_payin",
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

/** TL Pay manual ops completion (`manualSettlement: 1` in webhook `data`). */
export function parseManualSettlement(payload: unknown): boolean {
  const root = payload as Record<string, unknown> | null;
  if (!root || typeof root !== "object") return false;
  const data = (root.data ?? root) as Record<string, unknown>;
  const v = data.manualSettlement ?? data.manual_settlement;
  return v === 1 || v === true || v === "1";
}

/** Success terminal callback after TL Pay manual handling — may recover a prior `failed` row. */
export function isTyltManualSettlementSuccessWebhook(parsed: unknown): boolean {
  const eventId = parseCrossRampEventId(parsed);
  if (eventId == null || !SUCCESS_EVENT_IDS.has(eventId)) return false;
  return parseManualSettlement(parsed);
}

/** India UPI merchant ledger always settles USDT (payer may pay INR fiat). */
export function parseUpiPayinSettlementCurrency(_payload: unknown): "USDT" {
  return "USDT";
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

function pickFiniteAmountCandidate(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() && Number.isFinite(parseFloat(c))) return c.trim();
    if (typeof c === "number" && Number.isFinite(c)) return String(c);
  }
  return null;
}

export function parseCreditAmount(payload: unknown, fallbackAmount: string): string {
  const data = (payload as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
  const transaction = data?.transaction as Record<string, unknown> | undefined;
  const accounts = data?.accounts as Record<string, unknown> | undefined;

  const raw =
    pickFiniteAmountCandidate(
      accounts?.merchantAccountCredited,
      accounts?.amountPaidInCryptoCurrency,
      transaction?.settledAmountCredited,
      transaction?.settledAmountReceived,
      transaction?.paidAmount,
      transaction?.amount
    ) ?? fallbackAmount;

  return normalizeMoneyAmountToTwoDecimals(raw);
}

export function mergeTransactionMetadata(existing: string | null, patch: Record<string, unknown>): string {
  const prev = existing ? (readMetadata({ metadata: existing }) as Record<string, unknown>) : {};
  return JSON.stringify({ ...prev, ...patch });
}

function mergeMeta(existing: string | null, patch: Record<string, unknown>): string {
  return mergeTransactionMetadata(existing, patch);
}

/** TL Pay pay-in webhook/create envelope (`data` block). */
export function extractTyltPayinDataEnvelope(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const data = (root.data ?? root.result ?? root.payload ?? root) as Record<string, unknown>;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return data;
}

/** True when the object carries at least one non-empty payment field (not `{ details: null }`). */
export function hasMeaningfulPaymentInstructions(candidate: Record<string, unknown>): boolean {
  for (const value of Object.values(candidate)) {
    if (value == null) continue;
    if (typeof value === "string" && value.trim().length > 0) return true;
    if (typeof value === "number" && Number.isFinite(value)) return true;
    if (typeof value === "object" && !Array.isArray(value)) {
      if (hasMeaningfulPaymentInstructions(value as Record<string, unknown>)) return true;
    }
  }
  return false;
}

/** UPI ID / QR / bank fields for merchant checkout UI when present upstream. */
export function extractPaymentInstructionsFromTyltData(
  data: Record<string, unknown>
): Record<string, unknown> | null {
  const pm = data.paymentMethod ?? data.payment_method;
  if (pm && typeof pm === "object") {
    const details =
      (pm as Record<string, unknown>).details ??
      (pm as Record<string, unknown>).paymentDetails ??
      pm;
    if (
      details &&
      typeof details === "object" &&
      !Array.isArray(details) &&
      hasMeaningfulPaymentInstructions(details as Record<string, unknown>)
    ) {
      return details as Record<string, unknown>;
    }
  }

  const trade = data.trade as Record<string, unknown> | undefined;
  if (trade) {
    for (const key of ["paymentMethod", "paymentMethodDetails", "paymentDetails", "upiDetails"]) {
      const v = trade[key];
      if (!v || typeof v !== "object") continue;
      const inner = (v as Record<string, unknown>).details ?? v;
      if (
        inner &&
        typeof inner === "object" &&
        !Array.isArray(inner) &&
        hasMeaningfulPaymentInstructions(inner as Record<string, unknown>)
      ) {
        return inner as Record<string, unknown>;
      }
    }
  }

  return null;
}

export async function fetchTyltPayinInstanceDetails(params: {
  environment: TyltMerchantEnvironment;
  merchantOrderId: string;
  instanceId?: string | null;
}): Promise<{ status: number; json: unknown; source: string } | null> {
  const call1 = await tyltSignedGetJson({
    environment: params.environment,
    path: "/p2pRampsMerchant/getInstanceDetails",
    queryParams: { merchantOrderId: params.merchantOrderId },
    credentialProfile: "india_payin",
  });
  if (call1.status < 500) {
    return { status: call1.status, json: call1.json, source: "getInstanceDetails:merchantOrderId" };
  }
  if (params.instanceId?.trim()) {
    const call2 = await tyltSignedGetJson({
      environment: params.environment,
      path: "/p2pRampsMerchant/getInstanceDetails",
      queryParams: { instanceId: params.instanceId.trim() },
      credentialProfile: "india_payin",
    });
    if (call2.status < 500) {
      return { status: call2.status, json: call2.json, source: "getInstanceDetails:instanceId" };
    }
  }
  return null;
}

async function persistH2hPayinProgressSnapshot(
  tx: { id: string; metadata: string | null },
  parsed: unknown,
  eventId: number
): Promise<void> {
  const data = extractTyltPayinDataEnvelope(parsed);
  if (!data) return;
  await db
    .update(transactions)
    .set({
      metadata: mergeMeta(tx.metadata, {
        payinSnapshot: {
          updatedAt: new Date().toISOString(),
          tradeEventId: eventId,
          paymentDetails: data,
          source: "webhook",
        },
      }),
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, tx.id));
}

async function persistPayinDisputeSnapshot(
  tx: { id: string; metadata: string | null },
  parsed: unknown,
  eventId: number
): Promise<void> {
  const data = extractTyltPayinDataEnvelope(parsed);
  const patch: Record<string, unknown> = {
    disputeState: {
      status: "open",
      tradeEventId: eventId,
      openedAt: new Date().toISOString(),
      source: "webhook",
    },
  };
  if (data) {
    patch.payinSnapshot = {
      updatedAt: new Date().toISOString(),
      tradeEventId: eventId,
      paymentDetails: data,
      source: "webhook",
    };
  }
  await db
    .update(transactions)
    .set({
      metadata: mergeMeta(tx.metadata, patch),
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, tx.id));
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

function classifyCrossRampDecisionImpl(
  eventId: number | undefined,
  terminalStatus?: string
): CrossRampTerminalDecision {
  if (eventId == null) return "unknown";
  if (DISPUTE_EVENT_IDS.has(eventId)) return "non_terminal";
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
  const pull = await fetchTyltPayinInstanceDetails(params);
  if (pull) {
    const decision = classifyCrossRampDecisionImpl(
      inferCrossRampEventIdFromAnyShape(pull.json),
      inferCrossRampStatusFromAnyShape(pull.json)
    );
    return { decision, source: pull.source };
  }
  const call3 = await tyltSignedGetJson({
    environment: params.environment,
    path: "/transactions/merchant/getPayinTransactionInformation",
    queryParams: { orderId: params.merchantOrderId },
    credentialProfile: "india_payin",
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

async function findExistingPayinCredit(
  transactionId: string
): Promise<{ id: string; amount: string; walletId: string; currency: string } | null> {
  const [row] = await db
    .select({
      id: ledgerEntries.id,
      amount: ledgerEntries.amount,
      walletId: ledgerEntries.walletId,
      currency: wallets.currency,
    })
    .from(ledgerEntries)
    .innerJoin(wallets, eq(wallets.id, ledgerEntries.walletId))
    .where(
      and(
        eq(ledgerEntries.referenceId, transactionId),
        eq(ledgerEntries.type, "payin"),
        eq(ledgerEntries.direction, "credit")
      )
    )
    .limit(1);
  return row ?? null;
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

  const tx = await selectPayinTxByMerchantOrderRef(merchantOrderId);
  if (!tx) {
    return null;
  }

  const meta = readMetadata(tx);
  if (!isTyltUpiPayinMetadata(meta)) {
    return null;
  }

  /** Progress-only UPI events (docs): no merchant webhook, but persist snapshot for H2H polling. */
  const callbackDecision = classifyCrossRampDecisionImpl(eventId);
  if (callbackDecision === "non_terminal" || callbackDecision === "unknown") {
    if (DISPUTE_EVENT_IDS.has(eventId)) {
      await persistPayinDisputeSnapshot(tx, parsed, eventId);
      audit({
        action: "payment.disputed",
        resource: tx.id,
        merchantId: tx.merchantId,
        meta: { eventId, product: meta.tyltProduct },
      });
    } else if (String(meta.tyltProduct) === TYLT_PRODUCT_H2H_UPI) {
      await persistH2hPayinProgressSnapshot(tx, parsed, eventId);
    }
    return null;
  }

  const txType = parseTransactionType(parsed);
  if (txType && txType.toLowerCase() !== "pay-in" && txType.toLowerCase() !== "payin") {
    return null;
  }

  const settlementCurrency = "USDT" as const;

  const existingCredit =
    eventId != null && SUCCESS_EVENT_IDS.has(eventId)
      ? await findExistingPayinCredit(tx.id)
      : null;

  const isManualSuccess = parseManualSettlement(parsed) && SUCCESS_EVENT_IDS.has(eventId);
  const manualFailedRecovery = isManualSuccess && tx.status === "failed";
  const wrongWalletRecovery =
    isManualSuccess &&
    tx.status === "success" &&
    existingCredit != null &&
    existingCredit.currency.trim().toUpperCase() !== settlementCurrency.trim().toUpperCase();

  if (tx.status === "success" && !wrongWalletRecovery) {
    if (
      existingCredit &&
      existingCredit.currency.trim().toUpperCase() === settlementCurrency.trim().toUpperCase()
    ) {
      return null;
    }
    if (!isManualSuccess) {
      return null;
    }
  }

  const manualRecovery = manualFailedRecovery || wrongWalletRecovery;

  if (tx.status !== "pending" && !manualRecovery) {
    return null;
  }

  const terminalStatus = parseTerminalStatus(parsed);
  const callbackDecisionWithStatus = classifyCrossRampDecisionImpl(eventId, terminalStatus);
  const tyltMerchantOrderIdForRemote = resolveTyltPayinMerchantOrderIdForRemote(meta, tx.id);
  const remote = await fetchRemoteCrossRampDecision({
    environment: tx.environment as TyltMerchantEnvironment,
    merchantOrderId: tyltMerchantOrderIdForRemote,
    instanceId: tx.externalId,
  });
  if (remote.decision !== callbackDecisionWithStatus && !manualRecovery) {
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
      currency: settlementCurrency,
    });

    const settleFromStatus = manualFailedRecovery
      ? or(eq(transactions.status, "pending"), eq(transactions.status, "failed"))
      : wrongWalletRecovery
        ? eq(transactions.status, "success")
        : eq(transactions.status, "pending");

    const result = await db.transaction(async (txDb) => {
      const [updated] = await txDb
        .update(transactions)
        .set({
          status: "success",
          paidAmount,
          currency: settlementCurrency,
          metadata: mergeMeta(tx.metadata, {
            settlementCurrency,
            disputeState: { status: "resolved", resolvedAt: new Date().toISOString(), resolution: "success" },
            ...(manualRecovery
              ? {
                  manualSettlementRecovery: {
                    at: new Date().toISOString(),
                    eventId,
                    previousStatus: manualFailedRecovery ? "failed" : "success",
                    ...(wrongWalletRecovery
                      ? {
                          wrongWalletCorrected: true,
                          fromCurrency: existingCredit?.currency ?? null,
                          toCurrency: settlementCurrency,
                        }
                      : {}),
                  },
                }
              : {}),
          }),
          updatedAt: new Date(),
        })
        .where(and(eq(transactions.id, tx.id), settleFromStatus))
        .returning();

      if (!updated) {
        return null;
      }

      if (!wallet) {
        return { walletCredited: false as const };
      }

      const [existingCreditRow] = await txDb
        .select({
          id: ledgerEntries.id,
          amount: ledgerEntries.amount,
          walletId: ledgerEntries.walletId,
          currency: wallets.currency,
        })
        .from(ledgerEntries)
        .innerJoin(wallets, eq(wallets.id, ledgerEntries.walletId))
        .where(
          and(
            eq(ledgerEntries.referenceId, tx.id),
            eq(ledgerEntries.type, "payin"),
            eq(ledgerEntries.direction, "credit")
          )
        )
        .limit(1);

      if (
        existingCreditRow &&
        existingCreditRow.currency.trim().toUpperCase() === settlementCurrency.trim().toUpperCase()
      ) {
        return { walletCredited: false as const, alreadyCredited: true as const };
      }

      if (
        wrongWalletRecovery &&
        existingCreditRow &&
        existingCreditRow.currency.trim().toUpperCase() !== settlementCurrency.trim().toUpperCase()
      ) {
        const [wrongWallet] = await txDb
          .select()
          .from(wallets)
          .where(eq(wallets.id, existingCreditRow.walletId))
          .for("update")
          .limit(1);
        if (wrongWallet) {
          const reversalAmount = String(existingCreditRow.amount);
          await txDb.insert(ledgerEntries).values({
            walletId: wrongWallet.id,
            environment: tx.environment,
            amount: reversalAmount,
            direction: "debit",
            type: "payin",
            referenceId: tx.id,
          });
          await txDb
            .update(wallets)
            .set({
              balance: subAmount(String(wrongWallet.balance), reversalAmount),
              updatedAt: new Date(),
            })
            .where(eq(wallets.id, wrongWallet.id));
        }
      } else if (existingCreditRow) {
        return { walletCredited: false as const, alreadyCredited: true as const };
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
          currency: tx.currency,
          provider: tx.provider,
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
      meta: {
        paidAmount,
        instanceId: tx.externalId,
        eventId,
        product: meta.tyltProduct,
        ...(manualRecovery
          ? {
              manualSettlement: true,
              previousStatus: manualFailedRecovery ? "failed" : "success",
              settlementCurrency,
              ...(wrongWalletRecovery ? { wrongWalletCorrected: true } : {}),
            }
          : { settlementCurrency }),
      },
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
      .set({
        status: "failed",
        metadata: mergeMeta(tx.metadata, {
          disputeState: { status: "resolved", resolvedAt: new Date().toISOString(), resolution: "expired" },
        }),
        updatedAt: new Date(),
      })
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
