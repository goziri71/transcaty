/**
 * Tylt CPG crypto payout (§6): createPayoutRequest + webhook (`isDebited`, `isFinal`, insufficient balance).
 */
import { eq, and } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions, wallets, ledgerEntries } from "../../../src/db/schema/index.js";
import { audit } from "../../../src/lib/audit.js";
import { previewTransactionFee, payoutTotalWalletDebit, ensurePayoutFeeCollected } from "../../../src/lib/billing/index.js";
import {
  buildTransactionFeeBreakdown,
  feeBreakdownToWebhookFields,
} from "../../../src/lib/billing/transaction-fee-breakdown.js";
import { resolveFxSpread } from "../../../src/lib/fx/rate-resolver.js";
import { applySpreadToCryptoAmount } from "../../../src/lib/fx/spread.js";
import { addAmount, assertPositive, cmpAmount, subAmount } from "../../../src/lib/money.js";
import type { WebhookEvent } from "../../../src/lib/merchant-webhook.js";
import { PayoutCreationError } from "../../domestic/bangladesh/payout.js";
import { parseTransactionMetadata, getOrCreateMerchantWallet } from "./crossramp-payin.js";
import { tyltSignedGetJson, tyltSignedPostJson } from "./client.js";
import type { TyltMerchantEnvironment } from "./config.js";

const RAIL = "tylt";
export const TYLT_PRODUCT_CPG_PAYOUT = "cpg_payout";

function readMeta(tx: { metadata: string | null }): Record<string, unknown> {
  return parseTransactionMetadata(tx);
}

export function isTyltCpgPayoutMetadata(meta: Record<string, unknown>): boolean {
  return meta.rail === RAIL && meta.tyltProduct === TYLT_PRODUCT_CPG_PAYOUT;
}

function pickString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

export function extractCpgPayOutWebhookFields(parsed: unknown): {
  merchantOrderId?: string;
  wireType?: string;
  statusRaw: string;
  isFinal: boolean;
  isDebited: boolean;
  insufficientBalance: boolean;
  settledAmountDebited?: string;
  settledAmountSent?: string;
} {
  const root = parsed as Record<string, unknown>;
  const data = (root.data ?? root.record ?? root.payload ?? root.transaction ?? root) as Record<string, unknown>;

  const merchantOrderId = pickString(root.merchantOrderId, data.merchantOrderId, data.orderId);
  const wireType = pickString(root.type, data.type);

  const statusRaw =
    pickString(data.status, root.status, data.payoutStatus) ?? "";

  const isFinal = Boolean(data.isFinal ?? root.isFinal);
  const isDebited = Boolean(data.isDebited ?? root.isDebited);
  const insufficientBalance = Boolean(data.insufficientBalance ?? root.insufficientBalance);

  const settledAmountDebited = pickString(data.settledAmountDebited, root.settledAmountDebited);
  const settledAmountSent = pickString(data.settledAmountSent, root.settledAmountSent);

  return {
    merchantOrderId,
    wireType,
    statusRaw,
    isFinal,
    isDebited,
    insufficientBalance,
    settledAmountDebited,
    settledAmountSent,
  };
}

function isPayOutEnvelope(fields: ReturnType<typeof extractCpgPayOutWebhookFields>): boolean {
  const t = (fields.wireType ?? "").toLowerCase();
  if (t.includes("pay-in") || t.includes("payin")) return false;
  return true;
}

function isTerminalProgressOnly(statusNorm: string): boolean {
  return statusNorm === "pending" || statusNorm === "processing";
}

function shouldCompleteCpgPayout(f: ReturnType<typeof extractCpgPayOutWebhookFields>): boolean {
  if (f.insufficientBalance) return false;
  const st = f.statusRaw.trim().toLowerCase();
  if (st === "completed") return true;
  if (f.isFinal && f.isDebited) return true;
  return false;
}

function shouldFailCpgPayout(f: ReturnType<typeof extractCpgPayOutWebhookFields>): boolean {
  if (f.insufficientBalance && f.isFinal) return true;
  const st = f.statusRaw.trim().toLowerCase();
  if (st === "failed" || st === "cancelled" || st === "expired" || st === "rejected") return true;
  return false;
}

type CpgPayoutTerminalDecision = "success" | "failed" | "non_terminal" | "unknown";

function classifyCpgPayoutDecision(f: ReturnType<typeof extractCpgPayOutWebhookFields>): CpgPayoutTerminalDecision {
  const statusNorm = f.statusRaw.trim().toLowerCase();
  if (isTerminalProgressOnly(statusNorm)) return "non_terminal";
  if (shouldFailCpgPayout(f)) return "failed";
  if (shouldCompleteCpgPayout(f)) return "success";
  return "unknown";
}

function mergeMeta(existing: string | null, patch: Record<string, unknown>): string {
  const prev = parseTransactionMetadata({ metadata: existing });
  return JSON.stringify({ ...prev, ...patch });
}

async function markPayoutReviewRequired(params: {
  transactionId: string;
  existingMetadata: string | null;
  reason: string;
  callbackDecision: CpgPayoutTerminalDecision;
  callbackStatusRaw: string;
  remoteDecision: CpgPayoutTerminalDecision;
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

async function fetchRemoteCpgPayoutDecision(params: {
  environment: TyltMerchantEnvironment;
  orderIds: string[];
}): Promise<{ decision: CpgPayoutTerminalDecision; source: string }> {
  const uniqueOrderIds = [...new Set(params.orderIds.map((v) => v.trim()).filter(Boolean))];
  if (uniqueOrderIds.length === 0) {
    return { decision: "unknown", source: "no_order_id" };
  }

  for (const orderId of uniqueOrderIds) {
    const { status, json } = await cpgGetPayoutTransactionInformation({ environment: params.environment, orderId });
    if (status >= 500) continue;
    if (status >= 400) return { decision: "unknown", source: `getPayoutTransactionInformation:${orderId}:http_${status}` };
    const remoteFields = extractCpgPayOutWebhookFields(json);
    const decision = classifyCpgPayoutDecision(remoteFields);
    return { decision, source: `getPayoutTransactionInformation:${orderId}` };
  }

  return { decision: "unknown", source: "getPayoutTransactionInformation:upstream_5xx" };
}

async function getMerchantWalletStrict(params: {
  merchantId: string;
  environment: TyltMerchantEnvironment;
  currency: string;
}) {
  const [w] = await db
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
  return w ?? null;
}

function extractCpgPayoutPlatformOrderId(json: unknown): string | null {
  const root = json as Record<string, unknown>;
  const data = (root.data ?? root.result ?? root) as Record<string, unknown>;
  return (
    pickString(data.platformOrderId, data.orderId, data.id, root.platformOrderId, root.orderId) ?? null
  );
}

export async function createTyltCpgPayoutRequest(params: {
  merchantId: string;
  environment: TyltMerchantEnvironment;
  baseUrl: string;
  amount: string;
  settledCurrency: string;
  networkSymbol: string;
  /** Destination / beneficiary payload required by Tylt travel-rule / chain semantics. */
  destinationDetails: Record<string, unknown>;
}): Promise<{ transactionId: string; status: string; platformOrderId: string | null }> {
  const callBackUrl = `${params.baseUrl.replace(/\/$/, "")}/webhooks/tylt/cpg-payout/${params.environment}`;

  assertPositive(params.amount);

  const fxSpread = await resolveFxSpread({
    merchantId: params.merchantId,
    environment: params.environment,
    product: "cpg_payout",
    settledCurrency: params.settledCurrency,
    networkSymbol: params.networkSymbol,
  });
  if (fxSpread?.disabled) {
    throw new Error("Crypto send-out is disabled for this merchant");
  }
  const spreadParts = applySpreadToCryptoAmount(params.amount, fxSpread?.spreadBps ?? 0);
  const debitAmount = spreadParts.totalDebit;

  const payoutFeePreview = await previewTransactionFee({
    merchantId: params.merchantId,
    environment: params.environment,
    currency: params.settledCurrency,
    provider: "tylt-cpg-payout",
    amount: debitAmount,
    feeType: "payout",
  });
  const totalWalletDebit = payoutTotalWalletDebit(debitAmount, payoutFeePreview);

  const metadata = {
    rail: RAIL,
    tyltProduct: TYLT_PRODUCT_CPG_PAYOUT,
    settledCurrency: params.settledCurrency,
    networkSymbol: params.networkSymbol,
    payoutSendAmount: params.amount,
    fxSpreadBps: fxSpread?.spreadBps ?? 0,
    fxSpreadAmount: spreadParts.spreadAmount,
    debitAmount,
    fxRateProfileId: fxSpread?.rateProfileId ?? null,
  };

  // tx1: lock the merchant wallet, validate balance, insert pending tx, debit
  // upfront. The Tylt HTTP call must happen outside this transaction so we
  // never hold a row lock across the network.
  const created = await db.transaction(async (txDb) => {
    const [walletRef] = await txDb
      .select({ id: wallets.id })
      .from(wallets)
      .where(
        and(
          eq(wallets.merchantId, params.merchantId),
          eq(wallets.environment, params.environment),
          eq(wallets.type, "merchant"),
          eq(wallets.currency, params.settledCurrency),
          eq(wallets.status, "active")
        )
      )
      .limit(1);

    if (!walletRef) {
      throw new Error("Merchant wallet not found");
    }

    const [wallet] = await txDb
      .select()
      .from(wallets)
      .where(eq(wallets.id, walletRef.id))
      .for("update")
      .limit(1);

    if (!wallet) {
      throw new Error("Merchant wallet not found");
    }
    if (cmpAmount(wallet.balance, totalWalletDebit) < 0) {
      throw new Error("Insufficient balance");
    }

    const [tx] = await txDb
      .insert(transactions)
      .values({
        merchantId: params.merchantId,
        environment: params.environment,
        type: "payout",
        status: "pending",
        amount: debitAmount,
        currency: params.settledCurrency,
        provider: "tylt-cpg-payout",
        metadata: JSON.stringify(metadata),
      })
      .returning();

    if (!tx) throw new Error("Failed to create transaction");

    await txDb.insert(ledgerEntries).values({
      walletId: wallet.id,
      environment: params.environment,
      amount: debitAmount,
      direction: "debit",
      type: "payout",
      referenceId: tx.id,
    });

    await txDb
      .update(wallets)
      .set({
        balance: subAmount(wallet.balance, debitAmount),
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, wallet.id));

    return { tx };
  });

  const tx = created.tx;

  const body: Record<string, unknown> = {
    merchantOrderId: tx.id,
    callBackUrl,
    settledAmount: params.amount,
    settledCurrency: params.settledCurrency,
    networkSymbol: params.networkSymbol,
    destinationDetails: params.destinationDetails,
  };

  let status: number;
  let json: Record<string, unknown> | undefined;
  try {
    ({ status, json } = await tyltSignedPostJson<Record<string, unknown>>({
      environment: params.environment,
      path: "/transactions/merchant/createPayoutRequest",
      body,
      idempotencyKey: tx.id,
      credentialProfile: "india_payout",
    }));
  } catch (err) {
    await refundPayoutDebit({
      id: tx.id,
      merchantId: params.merchantId,
      environment: params.environment,
      amount: debitAmount,
      currency: params.settledCurrency,
      reason: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const platformOrderId = extractCpgPayoutPlatformOrderId(json);

  if (status >= 400 || !platformOrderId) {
    await refundPayoutDebit({
      id: tx.id,
      merchantId: params.merchantId,
      environment: params.environment,
      amount: debitAmount,
      currency: params.settledCurrency,
      reason: JSON.stringify(json),
      externalId: platformOrderId ?? null,
    });
    throw new PayoutCreationError(
      "Tylt CPG create payout failed",
      tx.id,
      platformOrderId ?? undefined
    );
  }

  await db
    .update(transactions)
    .set({ externalId: platformOrderId, updatedAt: new Date() })
    .where(eq(transactions.id, tx.id));

  audit({
    action: "payout.created",
    resource: tx.id,
    merchantId: params.merchantId,
    meta: { platformOrderId, rail: RAIL, product: TYLT_PRODUCT_CPG_PAYOUT },
  });

  return {
    transactionId: tx.id,
    status: "pending",
    platformOrderId,
  };
}

export async function cpgGetPayoutTransactionInformation(params: {
  environment: TyltMerchantEnvironment;
  orderId: string;
}) {
  return tyltSignedGetJson({
    environment: params.environment,
    path: "/transactions/merchant/getPayoutTransactionInformation",
    queryParams: { orderId: params.orderId },
    credentialProfile: "india_payout",
  });
}

export async function cpgGetPayoutTransactionHistory(params: {
  environment: TyltMerchantEnvironment;
  rows: number;
  page: number;
}) {
  return tyltSignedGetJson({
    environment: params.environment,
    path: "/transactions/merchant/getPayoutTransactionHistory",
    queryParams: { rows: params.rows, page: params.page },
    credentialProfile: "india_payout",
  });
}

async function refundPayoutDebit(input: {
  id: string;
  merchantId: string;
  environment: TyltMerchantEnvironment;
  amount: string;
  currency: string;
  /** Optional failure reason recorded in transaction metadata. */
  reason?: string;
  /** Optional Tylt-side order id captured even on failure. */
  externalId?: string | null;
}): Promise<void> {
  const wallet =
    (await getMerchantWalletStrict({
      merchantId: input.merchantId,
      environment: input.environment,
      currency: input.currency,
    })) ??
    (await getOrCreateMerchantWallet({
      merchantId: input.merchantId,
      environment: input.environment,
      currency: input.currency,
    }));

  await db.transaction(async (txDb) => {
    const [pending] = await txDb
      .select({ metadata: transactions.metadata })
      .from(transactions)
      .where(and(eq(transactions.id, input.id), eq(transactions.status, "pending")))
      .limit(1);

    if (!pending) {
      return;
    }

    const prev = pending.metadata
      ? (JSON.parse(pending.metadata) as Record<string, unknown>)
      : {};

    const [updated] = await txDb
      .update(transactions)
      .set({
        status: "failed",
        externalId: input.externalId ?? undefined,
        metadata: JSON.stringify({
          ...prev,
          failedStage: "create_payout_request",
          failureReason: input.reason ?? "create_payout_request_failed",
        }),
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.id, input.id), eq(transactions.status, "pending")))
      .returning({ id: transactions.id });

    if (!updated) {
      return;
    }

    const [lockedWallet] = await txDb
      .select()
      .from(wallets)
      .where(eq(wallets.id, wallet.id))
      .for("update")
      .limit(1);

    if (!lockedWallet) {
      return;
    }

    await txDb.insert(ledgerEntries).values({
      walletId: lockedWallet.id,
      environment: input.environment,
      amount: input.amount,
      direction: "credit",
      type: "payout_refund",
      referenceId: input.id,
    });

    await txDb
      .update(wallets)
      .set({
        balance: addAmount(lockedWallet.balance, input.amount),
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, lockedWallet.id));
  });
}

/**
 * Finalize CPG payout from signed webhook (wallet debited at create; refund here on terminal failure).
 */
export async function applyTyltCpgPayoutWebhookPayload(
  parsed: unknown
): Promise<{ merchantId: string; event: WebhookEvent } | null> {
  const fields = extractCpgPayOutWebhookFields(parsed);

  if (!fields.merchantOrderId || !isPayOutEnvelope(fields)) {
    return null;
  }

  const [tx] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, fields.merchantOrderId), eq(transactions.type, "payout")))
    .limit(1);

  if (!tx) return null;

  const meta = readMeta(tx);
  if (!isTyltCpgPayoutMetadata(meta)) {
    return null;
  }

  if (tx.status !== "pending") {
    return null;
  }

  const callbackDecision = classifyCpgPayoutDecision(fields);
  if (callbackDecision === "non_terminal") {
    return null;
  }

  if (callbackDecision === "unknown") {
    return null;
  }

  const remote = await fetchRemoteCpgPayoutDecision({
    environment: tx.environment as TyltMerchantEnvironment,
    orderIds: [tx.externalId ?? "", tx.id],
  });
  if (remote.decision !== callbackDecision) {
    await markPayoutReviewRequired({
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
        product: TYLT_PRODUCT_CPG_PAYOUT,
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
    // Conditional pending->failed transition + refund all in one transaction
    // inside refundPayoutDebit. If the row is no longer pending, the call is
    // a safe no-op and we return null below.
    const [stillPending] = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(and(eq(transactions.id, tx.id), eq(transactions.status, "pending")))
      .limit(1);

    if (!stillPending) return null;

    await refundPayoutDebit({
      id: tx.id,
      merchantId: tx.merchantId,
      environment: tx.environment as TyltMerchantEnvironment,
      amount: String(tx.amount),
      currency: tx.currency,
      reason: "cpg_payout_terminal_failure",
      externalId: tx.externalId,
    });

    audit({
      action: "payout.failed",
      resource: tx.id,
      merchantId: tx.merchantId,
      meta: { reason: "cpg_payout_terminal_failure", product: TYLT_PRODUCT_CPG_PAYOUT, insufficientBalance: fields.insufficientBalance },
    });

    return {
      merchantId: tx.merchantId,
      event: {
        type: "payout.failed",
        transactionId: tx.id,
        status: "failed",
        amount: String(tx.amount),
        platformOrderId: tx.externalId ?? null,
      },
    };
  }

  const transitioned = await db.transaction(async (txDb) => {
    const [updated] = await txDb
      .update(transactions)
      .set({ status: "success", updatedAt: new Date() })
      .where(and(eq(transactions.id, tx.id), eq(transactions.status, "pending")))
      .returning({ id: transactions.id });

    if (!updated) return false;

      await ensurePayoutFeeCollected(
        {
          merchantId: tx.merchantId,
          transactionId: tx.id,
          environment: tx.environment,
          currency: tx.currency,
          provider: tx.provider,
          amount: String(tx.amount),
          feeType: "payout",
        },
        txDb
      );

    return true;
  });

  if (!transitioned) return null;

  audit({
    action: "payout.completed",
    resource: tx.id,
    merchantId: tx.merchantId,
    meta: { platformOrderId: tx.externalId, product: TYLT_PRODUCT_CPG_PAYOUT, cpgStatus: fields.statusRaw },
  });

  const breakdown = await buildTransactionFeeBreakdown({
    merchantId: tx.merchantId,
    environment: tx.environment,
    transactionId: tx.id,
    type: "payout",
    status: "success",
    amount: String(tx.amount),
    currency: tx.currency,
    provider: tx.provider,
  });

  return {
    merchantId: tx.merchantId,
    event: {
      type: "payout.completed",
      transactionId: tx.id,
      status: "success",
      amount: String(tx.amount),
      platformOrderId: tx.externalId ?? null,
      ...feeBreakdownToWebhookFields(breakdown),
    },
  };
}
