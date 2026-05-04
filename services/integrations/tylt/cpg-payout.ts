/**
 * Tylt CPG crypto payout (§6): createPayoutRequest + webhook (`isDebited`, `isFinal`, insufficient balance).
 */
import { eq, and } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions, wallets, ledgerEntries } from "../../../src/db/schema/index.js";
import { audit } from "../../../src/lib/audit.js";
import { tryApplyTransactionFee } from "../../../src/lib/billing/index.js";
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

  const wallet = await getMerchantWalletStrict({
    merchantId: params.merchantId,
    environment: params.environment,
    currency: params.settledCurrency,
  });
  if (!wallet) {
    throw new Error("Merchant wallet not found");
  }
  if (Number(wallet.balance) < Number(params.amount)) {
    throw new Error("Insufficient balance");
  }

  const metadata = {
    rail: RAIL,
    tyltProduct: TYLT_PRODUCT_CPG_PAYOUT,
    settledCurrency: params.settledCurrency,
    networkSymbol: params.networkSymbol,
  };

  const [tx] = await db
    .insert(transactions)
    .values({
      merchantId: params.merchantId,
      environment: params.environment,
      type: "payout",
      status: "pending",
      amount: params.amount,
      currency: params.settledCurrency,
      metadata: JSON.stringify(metadata),
    })
    .returning();

  if (!tx) throw new Error("Failed to create transaction");

  const body: Record<string, unknown> = {
    merchantOrderId: tx.id,
    callBackUrl,
    settledAmount: params.amount,
    settledCurrency: params.settledCurrency,
    networkSymbol: params.networkSymbol,
    destinationDetails: params.destinationDetails,
  };

  const { status, json } = await tyltSignedPostJson<Record<string, unknown>>({
    environment: params.environment,
    path: "/transactions/merchant/createPayoutRequest",
    body,
  });

  const platformOrderId = extractCpgPayoutPlatformOrderId(json);

  if (status >= 400 || !platformOrderId) {
    const prev = tx.metadata ? (JSON.parse(tx.metadata) as Record<string, unknown>) : {};
    await db
      .update(transactions)
      .set({
        status: "failed",
        metadata: JSON.stringify({
          ...prev,
          failedStage: "create_payout_request",
          failureReason: JSON.stringify(json),
        }),
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, tx.id));
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

  await db.insert(ledgerEntries).values({
    walletId: wallet.id,
    environment: params.environment,
    amount: params.amount,
    direction: "debit",
    type: "payout",
    referenceId: tx.id,
  });

  await db
    .update(wallets)
    .set({
      balance: String(Number(wallet.balance) - Number(params.amount)),
      updatedAt: new Date(),
    })
    .where(eq(wallets.id, wallet.id));

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
  });
}

async function refundPayoutDebit(tx: {
  id: string;
  merchantId: string;
  environment: TyltMerchantEnvironment;
  amount: string;
  currency: string;
}): Promise<void> {
  const wallet =
    (await getMerchantWalletStrict({
      merchantId: tx.merchantId,
      environment: tx.environment as TyltMerchantEnvironment,
      currency: tx.currency,
    })) ??
    (await getOrCreateMerchantWallet({
      merchantId: tx.merchantId,
      environment: tx.environment as TyltMerchantEnvironment,
      currency: tx.currency,
    }));

  await db.insert(ledgerEntries).values({
    walletId: wallet.id,
    environment: tx.environment,
    amount: String(tx.amount),
    direction: "credit",
    type: "payout_refund",
    referenceId: tx.id,
  });

  await db
    .update(wallets)
    .set({
      balance: String(Number(wallet.balance) + Number(tx.amount)),
      updatedAt: new Date(),
    })
    .where(eq(wallets.id, wallet.id));
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

  const statusNorm = fields.statusRaw.trim().toLowerCase();

  if (isTerminalProgressOnly(statusNorm)) {
    return null;
  }

  if (shouldFailCpgPayout(fields)) {
    const [failed] = await db
      .update(transactions)
      .set({ status: "failed", updatedAt: new Date() })
      .where(and(eq(transactions.id, tx.id), eq(transactions.status, "pending")))
      .returning({ id: transactions.id });

    if (!failed) return null;

    await refundPayoutDebit({
      id: tx.id,
      merchantId: tx.merchantId,
      environment: tx.environment as TyltMerchantEnvironment,
      amount: String(tx.amount),
      currency: tx.currency,
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

  if (!shouldCompleteCpgPayout(fields)) {
    return null;
  }

  const [updated] = await db
    .update(transactions)
    .set({ status: "success", updatedAt: new Date() })
    .where(and(eq(transactions.id, tx.id), eq(transactions.status, "pending")))
    .returning();

  if (!updated) return null;

  await tryApplyTransactionFee({
    merchantId: tx.merchantId,
    transactionId: tx.id,
    environment: tx.environment,
    amount: String(tx.amount),
    feeType: "payout",
  });

  audit({
    action: "payout.completed",
    resource: tx.id,
    merchantId: tx.merchantId,
    meta: { platformOrderId: tx.externalId, product: TYLT_PRODUCT_CPG_PAYOUT, cpgStatus: fields.statusRaw },
  });

  return {
    merchantId: tx.merchantId,
    event: {
      type: "payout.completed",
      transactionId: tx.id,
      status: "success",
      amount: String(tx.amount),
      platformOrderId: tx.externalId ?? null,
    },
  };
}
