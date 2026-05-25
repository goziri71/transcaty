/**
 * Tylt CPG crypto pay-in (§5): createPayinRequest + webhook mapping (`isFinal`, `isCredited`, statuses).
 */
import { eq, and } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions, wallets, ledgerEntries } from "../../../src/db/schema/index.js";
import { audit } from "../../../src/lib/audit.js";
import { tryApplyTransactionFee } from "../../../src/lib/billing/index.js";
import { addAmount, normalizeMoneyAmountToTwoDecimals } from "../../../src/lib/money.js";
import type { WebhookEvent } from "../../../src/lib/merchant-webhook.js";
import { getOrCreateMerchantWallet, parseTransactionMetadata } from "./crossramp-payin.js";
import { tyltSignedGetJson, tyltSignedPostJson } from "./client.js";
import type { TyltMerchantEnvironment } from "./config.js";

const RAIL = "tylt";
export const TYLT_PRODUCT_CPG_PAYIN = "cpg_payin";

function readMeta(tx: { metadata: string | null }): Record<string, unknown> {
  return parseTransactionMetadata(tx);
}

export function isTyltCpgPayinMetadata(meta: Record<string, unknown>): boolean {
  return meta.rail === RAIL && meta.tyltProduct === TYLT_PRODUCT_CPG_PAYIN;
}

/** Normalize typo variants from docs. */
function pickString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

export function extractCpgPayInWebhookFields(parsed: unknown): {
  merchantOrderId?: string;
  wireType?: string;
  statusRaw: string;
  isFinal: boolean;
  isCredited: boolean;
  settledAmountCredited?: string;
  settledAmountReceived?: string;
  baseAmountReceived?: string;
} {
  const root = parsed as Record<string, unknown>;
  const data = (root.data ?? root.record ?? root.payload ?? root.transaction ?? root) as Record<string, unknown>;

  const merchantOrderId = pickString(root.merchantOrderId, data.merchantOrderId, data.orderId);
  const wireType = pickString(root.type, data.type);

  const statusRaw =
    pickString(data.status, root.status, data.paymentStatus) ??
    "";

  const isFinal = Boolean(data.isFinal ?? root.isFinal);
  const isCredited = Boolean(data.isCredited ?? root.isCredited);

  const settledAmountCredited = pickString(data.settledAmountCredited, root.settledAmountCredited);
  const settledAmountReceived = pickString(data.settledAmountReceived, root.settledAmountReceived);
  const baseAmountReceived = pickString(
    data.baseAmountReceived,
    data.baseAmountRecieved,
    root.baseAmountReceived,
    root.baseAmountRecieved
  );

  return {
    merchantOrderId,
    wireType,
    statusRaw,
    isFinal,
    isCredited,
    settledAmountCredited,
    settledAmountReceived,
    baseAmountReceived,
  };
}

function pickCreditAmount(fields: ReturnType<typeof extractCpgPayInWebhookFields>, fallback: string): string {
  const candidates = [fields.settledAmountCredited, fields.settledAmountReceived, fields.baseAmountReceived];
  for (const c of candidates) {
    if (c && Number.isFinite(parseFloat(c))) return normalizeMoneyAmountToTwoDecimals(c);
  }
  return normalizeMoneyAmountToTwoDecimals(fallback);
}

function isPayInEnvelope(fields: ReturnType<typeof extractCpgPayInWebhookFields>): boolean {
  const t = (fields.wireType ?? "").toLowerCase();
  if (t.includes("pay-out") || t.includes("payout")) return false;
  return true;
}

function isTerminalProgressOnly(statusNorm: string): boolean {
  return (
    statusNorm === "pending" || statusNorm === "under payment" || statusNorm === "under_payment" || statusNorm === "over payment" || statusNorm === "over_payment"
  );
}

function shouldCreditCpg(fields: ReturnType<typeof extractCpgPayInWebhookFields>): boolean {
  const st = fields.statusRaw.trim().toLowerCase();
  if (st === "completed") return true;
  if (fields.isFinal && fields.isCredited) return true;
  return false;
}

function shouldFailCpg(fields: ReturnType<typeof extractCpgPayInWebhookFields>): boolean {
  const st = fields.statusRaw.trim().toLowerCase();
  return st === "expired";
}

type CpgTerminalDecision = "success" | "failed" | "non_terminal" | "unknown";

function classifyCpgPayinDecision(fields: ReturnType<typeof extractCpgPayInWebhookFields>): CpgTerminalDecision {
  const statusNorm = fields.statusRaw.trim().toLowerCase();
  if (isTerminalProgressOnly(statusNorm)) return "non_terminal";
  if (shouldFailCpg(fields)) return "failed";
  if (shouldCreditCpg(fields)) return "success";
  return "unknown";
}

function mergeMeta(
  existing: string | null,
  patch: Record<string, unknown>
): string {
  const prev = parseTransactionMetadata({ metadata: existing });
  return JSON.stringify({ ...prev, ...patch });
}

async function markPayinReviewRequired(params: {
  transactionId: string;
  existingMetadata: string | null;
  reason: string;
  callbackDecision: CpgTerminalDecision;
  callbackStatusRaw: string;
  remoteDecision: CpgTerminalDecision;
  remoteSource: string;
}) {
  await db
    .update(transactions)
    .set({
      metadata: mergeMeta(params.existingMetadata, {
        reviewRequired: true,
        reviewReason: params.reason,
        callbackDecision: params.callbackDecision,
        callbackStatusRaw: params.callbackStatusRaw,
        remoteDecision: params.remoteDecision,
        remoteSource: params.remoteSource,
        reviewMarkedAt: new Date().toISOString(),
      }),
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, params.transactionId));
}

async function fetchRemoteCpgPayinDecision(params: {
  environment: TyltMerchantEnvironment;
  orderIds: string[];
}): Promise<{ decision: CpgTerminalDecision; source: string }> {
  const uniqueOrderIds = [...new Set(params.orderIds.map((v) => v.trim()).filter(Boolean))];
  if (uniqueOrderIds.length === 0) {
    return { decision: "unknown", source: "no_order_id" };
  }

  for (const orderId of uniqueOrderIds) {
    const { status, json } = await cpgGetPayinTransactionInformation({ environment: params.environment, orderId });
    if (status >= 500) continue;
    if (status >= 400) return { decision: "unknown", source: `getPayinTransactionInformation:${orderId}:http_${status}` };
    const remoteFields = extractCpgPayInWebhookFields(json);
    const decision = classifyCpgPayinDecision(remoteFields);
    return { decision, source: `getPayinTransactionInformation:${orderId}` };
  }

  return { decision: "unknown", source: "getPayinTransactionInformation:upstream_5xx" };
}

export async function createTyltCpgPayinRequest(params: {
  merchantId: string;
  environment: TyltMerchantEnvironment;
  baseUrl: string;
  baseAmount: string;
  baseCurrency: string;
  settledCurrency: string;
  networkSymbol: string;
  payeeDetails: Record<string, unknown>;
  settleUnderpayment?: number;
}): Promise<{
  transactionId: string;
  platformOrderId: string | null;
  amount: string;
  currency: string;
}> {
  const callBackUrl = `${params.baseUrl.replace(/\/$/, "")}/webhooks/tylt/cpg-payin/${params.environment}`;

  const metadata = {
    rail: RAIL,
    tyltProduct: TYLT_PRODUCT_CPG_PAYIN,
    baseCurrency: params.baseCurrency,
    settledCurrency: params.settledCurrency,
    networkSymbol: params.networkSymbol,
  };

  const [tx] = await db
    .insert(transactions)
    .values({
      merchantId: params.merchantId,
      environment: params.environment,
      type: "payin",
      status: "pending",
      amount: params.baseAmount,
      currency: params.settledCurrency,
      provider: "tylt-cpg-payin",
      metadata: JSON.stringify(metadata),
    })
    .returning();

  if (!tx) throw new Error("Failed to create transaction");

  const body: Record<string, unknown> = {
    merchantOrderId: tx.id,
    callBackUrl,
    baseAmount: params.baseAmount,
    baseCurrency: params.baseCurrency,
    settledCurrency: params.settledCurrency,
    networkSymbol: params.networkSymbol,
    payeeDetails: params.payeeDetails,
    settleUnderpayment: params.settleUnderpayment ?? 0,
  };

  const { status, json } = await tyltSignedPostJson<Record<string, unknown>>({
    environment: params.environment,
    path: "/transactions/merchant/createPayinRequest",
    body,
    idempotencyKey: tx.id,
    credentialRole: "payin",
  });

  const platformOrderId = extractCpgCreatePlatformOrderId(json);

  if (status >= 400 || !platformOrderId) {
    await db.update(transactions).set({ status: "failed", updatedAt: new Date() }).where(eq(transactions.id, tx.id));
    throw new Error("Tylt CPG create pay-in failed");
  }

  await db
    .update(transactions)
    .set({ externalId: platformOrderId, updatedAt: new Date() })
    .where(eq(transactions.id, tx.id));

  audit({
    action: "payment.created",
    resource: tx.id,
    merchantId: params.merchantId,
    meta: { platformOrderId, rail: RAIL, product: TYLT_PRODUCT_CPG_PAYIN },
  });

  return {
    transactionId: tx.id,
    platformOrderId,
    amount: params.baseAmount,
    currency: params.settledCurrency,
  };
}

function extractCpgCreatePlatformOrderId(json: unknown): string | null {
  const root = json as Record<string, unknown>;
  const data = (root.data ?? root.result ?? root) as Record<string, unknown>;
  const id = pickString(
    data.platformOrderId,
    data.orderId,
    data.id,
    root.platformOrderId,
    root.orderId
  );
  return id ?? null;
}

export async function cpgGetPayinTransactionInformation(params: {
  environment: TyltMerchantEnvironment;
  orderId: string;
}) {
  return tyltSignedGetJson({
    environment: params.environment,
    path: "/transactions/merchant/getPayinTransactionInformation",
    queryParams: { orderId: params.orderId },
    credentialRole: "payin",
  });
}

export async function cpgGetPayinTransactionHistory(params: {
  environment: TyltMerchantEnvironment;
  rows: number;
  page: number;
}) {
  return tyltSignedGetJson({
    environment: params.environment,
    path: "/transactions/merchant/getPayinTransactionHistory",
    queryParams: { rows: params.rows, page: params.page },
    credentialRole: "payin",
  });
}

/**
 * Signed CPG pay-in webhook: credit only when Completed or isFinal+isCredited; Expired → failed;
 * Pending / Under / Over → no local change (reconcile separately).
 */
export async function applyTyltCpgPayinWebhookPayload(
  parsed: unknown
): Promise<{ merchantId: string; event: WebhookEvent } | null> {
  const fields = extractCpgPayInWebhookFields(parsed);

  if (!fields.merchantOrderId) {
    return null;
  }

  if (!isPayInEnvelope(fields)) {
    return null;
  }

  const [tx] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, fields.merchantOrderId), eq(transactions.type, "payin")))
    .limit(1);

  if (!tx) return null;

  const meta = readMeta(tx);
  if (!isTyltCpgPayinMetadata(meta)) {
    return null;
  }

  if (tx.status !== "pending") {
    return null;
  }

  const callbackDecision = classifyCpgPayinDecision(fields);
  if (callbackDecision === "non_terminal") {
    return null;
  }

  if (callbackDecision === "unknown") {
    return null;
  }

  const remote = await fetchRemoteCpgPayinDecision({
    environment: tx.environment as TyltMerchantEnvironment,
    orderIds: [tx.externalId ?? "", tx.id],
  });
  if (remote.decision !== callbackDecision) {
    await markPayinReviewRequired({
      transactionId: tx.id,
      existingMetadata: tx.metadata,
      reason: "tylt_callback_remote_mismatch",
      callbackDecision,
      callbackStatusRaw: fields.statusRaw,
      remoteDecision: remote.decision,
      remoteSource: remote.source,
    });
    audit({
      action: "provider.transaction.reconciled",
      resource: tx.id,
      merchantId: tx.merchantId,
      meta: {
        product: TYLT_PRODUCT_CPG_PAYIN,
        reason: "callback_remote_mismatch",
        callbackDecision,
        callbackStatusRaw: fields.statusRaw,
        remoteDecision: remote.decision,
        remoteSource: remote.source,
      },
    });
    return null;
  }

  if (callbackDecision === "failed") {
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
      meta: { reason: "cpg_payin_expired", product: TYLT_PRODUCT_CPG_PAYIN },
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

  const paidAmount = pickCreditAmount(fields, String(tx.amount));

  // Resolve the wallet outside the transaction so that on first payin we don't
  // hold a row lock during a potential INSERT in getOrCreateMerchantWallet.
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

    if (!updated) return null;

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

  if (!result) return null;

  audit({
    action: "payment.completed",
    resource: tx.id,
    merchantId: tx.merchantId,
    meta: {
      paidAmount,
      platformOrderId: tx.externalId,
      product: TYLT_PRODUCT_CPG_PAYIN,
      cpgStatus: fields.statusRaw,
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
