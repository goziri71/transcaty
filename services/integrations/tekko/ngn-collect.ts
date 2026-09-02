/**
 * Legacy Tekko NGN exact-amount temporary bank collect (drain-only).
 * Merchant product is permanent VA in `ngn-va.ts`. Keep settle/reconcile for pending historical rows.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions, ledgerEntries, wallets } from "../../../src/db/schema/index.js";
import { audit } from "../../../src/lib/audit.js";
import { addAmount } from "../../../src/lib/money.js";
import { UpstreamProviderClientError } from "../../../src/lib/merchant-facing-errors.js";
import { tryApplyTransactionFee } from "../../../src/lib/billing/index.js";
import {
  buildTransactionFeeBreakdown,
  feeBreakdownToWebhookFields,
} from "../../../src/lib/billing/transaction-fee-breakdown.js";
import type { WebhookEvent } from "../../../src/lib/merchant-webhook.js";
import {
  NGN_SETTLEMENT_CURRENCY,
  NGN_SETTLEMENT_DISPLAY_NAME,
} from "../../../src/lib/ngn-settlement.js";
import { PLATFORM_MERCHANT_ID } from "../../../src/lib/billing/platform-wallet.js";
import { getOrCreateMerchantWallet } from "../tylt/crossramp-payin.js";
import { getTekkoLiveConfig } from "./config.js";
import { tekkoGet, tekkoPost } from "./client.js";

export const TEKKO_NGN_PROVIDER = "tekko-ngn-collect";
export const TEKKO_NGN_SETTLEMENT_CURRENCY = NGN_SETTLEMENT_CURRENCY;
export const TEKKO_NGN_SETTLEMENT_DISPLAY_NAME = NGN_SETTLEMENT_DISPLAY_NAME;
export const TEKKO_NGN_COLLECT_CURRENCY = "NGN" as const;

export type TekkoMerchantEnvironment = "test" | "live";

export type TekkoNgnPaymentInstructions = {
  accountNumber: string | null;
  bankName: string | null;
  accountName: string | null;
  expiryDate: string | null;
};

type CollectionShape = {
  reference?: string;
  status?: string;
  currency?: string;
  amount?: string | number;
  creditedAt?: string | null;
  description?: string | null;
  provider?: unknown;
};

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

function pickTekkoMessage(json: unknown, fallback: string): string {
  if (json && typeof json === "object") {
    const m = (json as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m.trim();
    const err = (json as { error?: unknown }).error;
    if (typeof err === "string" && err.trim()) return err.trim();
  }
  return fallback;
}

function extractCollection(json: unknown): CollectionShape | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  const data = asRecord(root.data) ?? root;
  if (typeof data.reference === "string" || typeof data.status === "string") {
    return data as CollectionShape;
  }
  return null;
}

/** Tekko docs: NGN bank details live under `data.provider` / `data.provider.data`. */
export function extractNgnPaymentInstructions(provider: unknown): TekkoNgnPaymentInstructions {
  const root = asRecord(provider);
  const nested = asRecord(root?.data) ?? root;
  return {
    accountNumber: strField(nested, "accountNumber", "account_number"),
    bankName: strField(nested, "bankName", "bank_name"),
    accountName: strField(nested, "accountName", "account_name"),
    expiryDate: strField(nested, "expiryDate", "expiry_date", "expiresAt", "expires_at"),
  };
}

export function assertTekkoNgnLiveEnvironment(environment: TekkoMerchantEnvironment): void {
  if (environment !== "live") {
    throw new UpstreamProviderClientError(
      "Tekko NGN is live-only (no sandbox credentials)",
      "NGN collection is only available in the live environment",
      503
    );
  }
  if (!getTekkoLiveConfig()) {
    throw new UpstreamProviderClientError(
      "Tekko credentials not configured",
      "Payment rail temporarily unavailable",
      503
    );
  }
}

export function isNgnCollectionCredited(status: string | null | undefined): boolean {
  return (status ?? "").trim().toLowerCase() === "credited";
}

export function isNgnCollectionTerminalFailure(status: string | null | undefined): boolean {
  const s = (status ?? "").trim().toLowerCase();
  return s === "failed" || s === "expired";
}

async function ensureNgnWallet(params: {
  merchantId: string;
  environment: "test" | "live";
}) {
  return getOrCreateMerchantWallet({
    merchantId: params.merchantId,
    environment: params.environment,
    currency: TEKKO_NGN_SETTLEMENT_CURRENCY,
  });
}

export async function createTekkoNgnCollection(params: {
  merchantId: string;
  environment: TekkoMerchantEnvironment;
  amount: string;
  accountName: string;
  description?: string;
  merchantReference?: string;
  metadata?: Record<string, unknown>;
  baseUrl: string;
}): Promise<{
  transactionId: string;
  reference: string;
  status: string;
  amount: string;
  currency: typeof TEKKO_NGN_COLLECT_CURRENCY;
  settlementCurrency: typeof TEKKO_NGN_SETTLEMENT_CURRENCY;
  paymentInstructions: TekkoNgnPaymentInstructions;
  expiresAt: string | null;
  environment: TekkoMerchantEnvironment;
}> {
  assertTekkoNgnLiveEnvironment(params.environment);

  const accountName = params.accountName.trim();
  if (!accountName || accountName.length > 200) {
    throw new UpstreamProviderClientError(
      "accountName required",
      "accountName is required (payer / sender name)",
      400
    );
  }

  const amountNum = Number(params.amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    throw new UpstreamProviderClientError("Invalid amount", "Amount must be a positive number", 400);
  }

  const description =
    (params.description?.trim() || params.merchantReference?.trim() || "").slice(0, 255) ||
    undefined;

  const [tx] = await db
    .insert(transactions)
    .values({
      merchantId: params.merchantId,
      environment: params.environment,
      type: "payin",
      status: "pending",
      amount: params.amount,
      currency: TEKKO_NGN_COLLECT_CURRENCY,
      provider: TEKKO_NGN_PROVIDER,
      metadata: JSON.stringify({
        rail: "tekko",
        tekkoProduct: "ngn_collect",
        environment: params.environment,
        merchantReference: params.merchantReference ?? null,
        accountName,
        description: description ?? null,
        settlementCurrency: TEKKO_NGN_SETTLEMENT_CURRENCY,
        merchantMetadata: params.metadata ?? null,
      }),
    })
    .returning();

  if (!tx) throw new Error("Failed to create transaction");

  const idempotencyKey = `tekko-ngn-${tx.id}`.slice(0, 255);
  const res = await tekkoPost(
    "/master-wallet/collections/initialize",
    {
      currency: TEKKO_NGN_COLLECT_CURRENCY,
      amount: amountNum,
      ...(description ? { description } : {}),
      payload: {
        type: "BANK",
        accountName,
      },
    },
    idempotencyKey,
    { label: "tekko ngn initialize collection" }
  );

  const collection = extractCollection(res.json);
  const reference = collection?.reference?.trim() || null;
  const instructions = extractNgnPaymentInstructions(collection?.provider);
  if (res.status >= 400 || !reference || !instructions.accountNumber) {
    await db
      .update(transactions)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(transactions.id, tx.id));
    const detail = pickTekkoMessage(res.json, `Tekko NGN initialize failed (${res.status})`);
    if (res.status >= 400 && res.status < 500) {
      throw new UpstreamProviderClientError(
        detail,
        "NGN collection could not be started. Check amount and try again, or contact support.",
        res.status,
        tx.id,
        null
      );
    }
    throw new Error(detail);
  }

  const collectionStatus = collection?.status ?? "awaiting_payment";
  const expiresAt = instructions.expiryDate;

  await db
    .update(transactions)
    .set({
      externalId: reference,
      metadata: mergeMeta(tx.metadata, {
        collectionReference: reference,
        collectionStatus,
        paymentInstructions: instructions,
        expiresAt,
        webhookUrlHint: `${params.baseUrl.replace(/\/$/, "")}/webhooks/tekko/${params.environment}`,
      }),
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, tx.id));

  audit({
    action: "payment.created",
    resource: tx.id,
    merchantId: params.merchantId,
    meta: {
      provider: TEKKO_NGN_PROVIDER,
      reference,
      amount: params.amount,
      currency: TEKKO_NGN_COLLECT_CURRENCY,
    },
  });

  return {
    transactionId: tx.id,
    reference,
    status: collectionStatus,
    amount: params.amount,
    currency: TEKKO_NGN_COLLECT_CURRENCY,
    settlementCurrency: TEKKO_NGN_SETTLEMENT_CURRENCY,
    paymentInstructions: instructions,
    expiresAt,
    environment: params.environment,
  };
}

function presentNgnStatus(
  tx: {
    id: string;
    status: string;
    amount: string;
    paidAmount: string | null;
    currency: string;
    environment: string;
    externalId: string | null;
    metadata: string | null;
  },
  extra: {
    collectionStatus: string;
    paymentInstructions: TekkoNgnPaymentInstructions;
    expiresAt: string | null;
  }
) {
  const meta = parseMeta(tx.metadata);
  return {
    transactionId: tx.id,
    reference:
      (typeof meta.collectionReference === "string" ? meta.collectionReference : null) ??
      tx.externalId,
    status: extra.collectionStatus,
    amount: String(tx.amount),
    paidAmount: tx.paidAmount ? String(tx.paidAmount) : null,
    currency: tx.currency,
    settlementCurrency: TEKKO_NGN_SETTLEMENT_CURRENCY,
    settlementCurrencyLabel: TEKKO_NGN_SETTLEMENT_DISPLAY_NAME,
    paymentInstructions: extra.paymentInstructions,
    expiresAt: extra.expiresAt,
    environment: tx.environment,
    settled: tx.status === "success",
  };
}

export async function getTekkoNgnCollectionStatus(params: {
  merchantId: string;
  transactionId: string;
}): Promise<ReturnType<typeof presentNgnStatus> | null> {
  const [tx] = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.id, params.transactionId),
        eq(transactions.merchantId, params.merchantId),
        eq(transactions.provider, TEKKO_NGN_PROVIDER)
      )
    )
    .limit(1);

  if (!tx) return null;

  const meta = parseMeta(tx.metadata);
  const reference =
    (typeof meta.collectionReference === "string" ? meta.collectionReference : null) ??
    tx.externalId;
  let collectionStatus =
    typeof meta.collectionStatus === "string" ? meta.collectionStatus : tx.status;
  let paymentInstructions =
    (meta.paymentInstructions as TekkoNgnPaymentInstructions | undefined) ??
    extractNgnPaymentInstructions(null);
  let expiresAt = typeof meta.expiresAt === "string" ? meta.expiresAt : paymentInstructions.expiryDate;

  if (tx.environment === "live" && tx.status === "pending" && reference) {
    try {
      const res = await tekkoGet(`/master-wallet/collections/${encodeURIComponent(reference)}/status`, {
        label: "tekko ngn collection status",
      });
      const collection = extractCollection(res.json);
      if (collection) {
        collectionStatus = collection.status ?? collectionStatus;
        const refreshed = extractNgnPaymentInstructions(collection.provider);
        if (refreshed.accountNumber) paymentInstructions = refreshed;
        if (refreshed.expiryDate) expiresAt = refreshed.expiryDate;

        await db
          .update(transactions)
          .set({
            metadata: mergeMeta(tx.metadata, {
              collectionStatus,
              paymentInstructions,
              expiresAt,
              lastPolledAt: new Date().toISOString(),
              ...(collection.creditedAt != null ? { creditedAt: collection.creditedAt } : {}),
            }),
            updatedAt: new Date(),
          })
          .where(eq(transactions.id, tx.id));

        if (isNgnCollectionCredited(collectionStatus) && tx.status === "pending") {
          const creditAmount =
            collection.amount != null ? String(collection.amount) : String(tx.amount);
          await settleTekkoNgnCollection({
            transactionId: tx.id,
            creditedAmount: creditAmount,
            collectionStatus: "credited",
            source: "poll",
          });
          const [refreshedTx] = await db
            .select()
            .from(transactions)
            .where(eq(transactions.id, tx.id))
            .limit(1);
          if (refreshedTx) {
            return presentNgnStatus(refreshedTx, {
              collectionStatus: "credited",
              paymentInstructions,
              expiresAt,
            });
          }
        }

        if (isNgnCollectionTerminalFailure(collectionStatus) && tx.status === "pending") {
          await markTekkoNgnFailed(tx.id, collectionStatus);
        }
      }
    } catch {
      // Status read is best-effort; return DB snapshot.
    }
  }

  const [latest] = await db.select().from(transactions).where(eq(transactions.id, tx.id)).limit(1);
  return presentNgnStatus(latest ?? tx, {
    collectionStatus,
    paymentInstructions,
    expiresAt,
  });
}

async function markTekkoNgnFailed(transactionId: string, collectionStatus: string): Promise<void> {
  const [row] = await db.select().from(transactions).where(eq(transactions.id, transactionId)).limit(1);
  if (!row || row.status !== "pending") return;

  const [failed] = await db
    .update(transactions)
    .set({
      status: "failed",
      metadata: mergeMeta(row.metadata, {
        collectionStatus,
        failedAt: new Date().toISOString(),
      }),
      updatedAt: new Date(),
    })
    .where(and(eq(transactions.id, transactionId), eq(transactions.status, "pending")))
    .returning();
  if (!failed) return;

  audit({
    action: "payment.failed",
    resource: transactionId,
    merchantId: failed.merchantId,
    meta: { provider: TEKKO_NGN_PROVIDER, collectionStatus },
  });
}

/**
 * Credit merchant NGN once. Safe under concurrent webhooks/polls via status guard + ledger check.
 */
export async function settleTekkoNgnCollection(params: {
  transactionId: string;
  creditedAmount: string;
  collectionStatus: string;
  source: "webhook" | "poll";
}): Promise<{ merchantId: string; event: WebhookEvent } | null> {
  const [tx] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, params.transactionId))
    .limit(1);
  if (!tx || tx.provider !== TEKKO_NGN_PROVIDER) return null;

  if (tx.status === "success") {
    return null;
  }

  const paidAmount = params.creditedAmount.trim();
  if (!paidAmount || !Number.isFinite(Number(paidAmount)) || Number(paidAmount) <= 0) {
    throw new Error("Invalid Tekko NGN settlement amount");
  }

  const wallet = await ensureNgnWallet({
    merchantId: tx.merchantId,
    environment: tx.environment as "test" | "live",
  });
  try {
    await getOrCreateMerchantWallet({
      merchantId: PLATFORM_MERCHANT_ID,
      environment: tx.environment as "test" | "live",
      currency: TEKKO_NGN_SETTLEMENT_CURRENCY,
    });
  } catch {
    // Fee apply skips if the platform NGN pocket is missing.
  }

  const result = await db.transaction(async (txDb) => {
    const [updated] = await txDb
      .update(transactions)
      .set({
        status: "success",
        paidAmount,
        currency: TEKKO_NGN_SETTLEMENT_CURRENCY,
        metadata: mergeMeta(tx.metadata, {
          collectionStatus: params.collectionStatus,
          creditedAmount: paidAmount,
          settledAt: new Date().toISOString(),
          settledFrom: params.source,
          settlementCurrency: TEKKO_NGN_SETTLEMENT_CURRENCY,
        }),
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.id, tx.id), eq(transactions.status, "pending")))
      .returning();

    if (!updated) return null;

    const [existingCredit] = await txDb
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.referenceId, tx.id),
          eq(ledgerEntries.type, "payin"),
          eq(ledgerEntries.direction, "credit")
        )
      )
      .limit(1);
    if (existingCredit) return { updated, skippedLedger: true as const };

    const [w] = await txDb.select().from(wallets).where(eq(wallets.id, wallet.id)).limit(1);
    if (!w) throw new Error("Wallet missing during Tekko NGN settle");

    const nextBalance = addAmount(String(w.balance), paidAmount);
    await txDb
      .update(wallets)
      .set({ balance: nextBalance, updatedAt: new Date() })
      .where(eq(wallets.id, w.id));

    await txDb.insert(ledgerEntries).values({
      walletId: w.id,
      environment: w.environment,
      direction: "credit",
      type: "payin",
      amount: paidAmount,
      referenceId: tx.id,
    });

    return { updated, skippedLedger: false as const, nextBalance };
  });

  if (!result) return null;

  await tryApplyTransactionFee({
    merchantId: tx.merchantId,
    environment: tx.environment as "test" | "live",
    transactionId: tx.id,
    feeType: "payin",
    amount: paidAmount,
    currency: TEKKO_NGN_SETTLEMENT_CURRENCY,
    provider: TEKKO_NGN_PROVIDER,
  }).catch(() => undefined);

  audit({
    action: "payment.completed",
    resource: tx.id,
    merchantId: tx.merchantId,
    meta: {
      provider: TEKKO_NGN_PROVIDER,
      paidAmount,
      currency: TEKKO_NGN_SETTLEMENT_CURRENCY,
      source: params.source,
    },
  });

  const breakdown = await buildTransactionFeeBreakdown({
    merchantId: tx.merchantId,
    environment: tx.environment as "test" | "live",
    transactionId: tx.id,
    type: "payin",
    status: "success",
    amount: paidAmount,
    currency: TEKKO_NGN_SETTLEMENT_CURRENCY,
    provider: TEKKO_NGN_PROVIDER,
  }).catch(() => null);

  return {
    merchantId: tx.merchantId,
    event: {
      type: "payin.completed",
      transactionId: tx.id,
      status: "success",
      amount: String(tx.amount),
      paidAmount,
      currency: TEKKO_NGN_SETTLEMENT_CURRENCY,
      platformOrderId: tx.externalId ?? null,
      ...feeBreakdownToWebhookFields(breakdown),
    },
  };
}

export type TekkoNgnReconcileResult =
  | {
      outcome: "finalized";
      transactionId: string;
      collectionStatus: string | null;
      merchantWebhook: { merchantId: string; event: WebhookEvent } | null;
    }
  | {
      outcome: "not_terminal";
      transactionId: string;
      collectionStatus: string | null;
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

export async function reconcileTekkoNgnCollectByTransactionId(
  transactionId: string
): Promise<TekkoNgnReconcileResult> {
  const [tx] = await db.select().from(transactions).where(eq(transactions.id, transactionId)).limit(1);
  if (!tx) return { outcome: "error", detail: "transaction_not_found" };
  if (tx.provider !== TEKKO_NGN_PROVIDER) {
    return { outcome: "skipped", transactionId, reason: "wrong_rail" };
  }
  if (tx.type !== "payin") return { outcome: "error", detail: "not_payin" };
  if (tx.status === "success" || tx.status === "failed") {
    return { outcome: "skipped", transactionId, reason: "already_terminal" };
  }

  const status = await getTekkoNgnCollectionStatus({
    merchantId: tx.merchantId,
    transactionId: tx.id,
  });
  if (!status) return { outcome: "error", detail: "status_unavailable" };

  const [latest] = await db.select().from(transactions).where(eq(transactions.id, tx.id)).limit(1);
  if (!latest) return { outcome: "error", detail: "transaction_not_found" };

  if (latest.status === "success") {
    const breakdown = await buildTransactionFeeBreakdown({
      merchantId: latest.merchantId,
      environment: latest.environment as "test" | "live",
      transactionId: latest.id,
      type: "payin",
      status: "success",
      amount: String(latest.paidAmount ?? latest.amount),
      currency: TEKKO_NGN_SETTLEMENT_CURRENCY,
      provider: TEKKO_NGN_PROVIDER,
    }).catch(() => null);
    return {
      outcome: "finalized",
      transactionId: latest.id,
      collectionStatus: status.status,
      merchantWebhook: {
        merchantId: latest.merchantId,
        event: {
          type: "payin.completed",
          transactionId: latest.id,
          status: "success",
          amount: String(latest.amount),
          paidAmount: latest.paidAmount ? String(latest.paidAmount) : String(latest.amount),
          currency: TEKKO_NGN_SETTLEMENT_CURRENCY,
          platformOrderId: latest.externalId ?? null,
          ...feeBreakdownToWebhookFields(breakdown),
        },
      },
    };
  }

  if (latest.status === "failed") {
    return {
      outcome: "finalized",
      transactionId: latest.id,
      collectionStatus: status.status,
      merchantWebhook: {
        merchantId: latest.merchantId,
        event: {
          type: "payin.failed",
          transactionId: latest.id,
          status: "failed",
          amount: String(latest.amount),
          platformOrderId: latest.externalId ?? null,
        },
      },
    };
  }

  return {
    outcome: "not_terminal",
    transactionId: latest.id,
    collectionStatus: status.status,
    detail: `collection_status=${status.status}`,
  };
}
