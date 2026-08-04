/**
 * Tekko PYUSD one-time checkout → settle USDC on merchant wallet.
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
import { getOrCreateMerchantWallet } from "../tylt/crossramp-payin.js";
import { getTekkoLiveConfig } from "./config.js";
import { tekkoGet, tekkoPost } from "./client.js";
import { ensureTekkoCustomerForMerchant } from "./customers.js";

export const TEKKO_PYUSD_PROVIDER = "tekko-pyusd-payin";
export const TEKKO_SETTLEMENT_CURRENCY = "USDC";
export const TEKKO_COLLECT_CURRENCY = "PYUSD";
export const TEKKO_NETWORK = "ethereum";

export type TekkoMerchantEnvironment = "test" | "live";

type PaymentIntentShape = {
  paymentIntentId?: string;
  merchantReference?: string;
  customerId?: number;
  currency?: string;
  network?: string;
  expectedAmount?: string;
  receivedAmount?: string;
  grossCollectedAmount?: string;
  collectionFeeAmount?: string;
  netCollectedAmount?: string;
  status?: string;
  settlementStatus?: string;
  depositAddress?: string;
  expiresAt?: string | null;
  confirmedAt?: string | null;
  addressDeactivated?: boolean;
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

function extractPaymentIntent(json: unknown): PaymentIntentShape | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  const data = root.data;
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (d.paymentIntent && typeof d.paymentIntent === "object") {
      return d.paymentIntent as PaymentIntentShape;
    }
    if (typeof d.paymentIntentId === "string") return d as PaymentIntentShape;
  }
  if (typeof root.paymentIntentId === "string") return root as PaymentIntentShape;
  return null;
}

function pickTekkoMessage(json: unknown, fallback: string): string {
  if (json && typeof json === "object") {
    const m = (json as { message?: unknown }).message;
    if (typeof m === "string" && m.trim()) return m.trim();
  }
  return fallback;
}

export function assertTekkoLiveEnvironment(environment: TekkoMerchantEnvironment): void {
  if (environment !== "live") {
    throw new UpstreamProviderClientError(
      "Tekko PYUSD is live-only (no sandbox credentials)",
      "PYUSD checkout is only available in the live environment",
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

export async function createTekkoPyusdPaymentIntent(params: {
  merchantId: string;
  environment: TekkoMerchantEnvironment;
  amount: string;
  merchantReference: string;
  expiresInMinutes?: number;
  metadata?: Record<string, unknown>;
  baseUrl: string;
}): Promise<{
  transactionId: string;
  paymentIntentId: string;
  status: string;
  settlementStatus: string | null;
  amount: string;
  currency: string;
  network: string;
  depositAddress: string;
  expiresAt: string | null;
  environment: TekkoMerchantEnvironment;
}> {
  assertTekkoLiveEnvironment(params.environment);

  const expiresInMinutes =
    typeof params.expiresInMinutes === "number" &&
    Number.isFinite(params.expiresInMinutes) &&
    params.expiresInMinutes >= 5 &&
    params.expiresInMinutes <= 1440
      ? Math.floor(params.expiresInMinutes)
      : 30;

  const tekkoCustomerId = await ensureTekkoCustomerForMerchant({
    merchantId: params.merchantId,
  });

  const [tx] = await db
    .insert(transactions)
    .values({
      merchantId: params.merchantId,
      environment: params.environment,
      type: "payin",
      status: "pending",
      amount: params.amount,
      currency: TEKKO_COLLECT_CURRENCY,
      provider: TEKKO_PYUSD_PROVIDER,
      metadata: JSON.stringify({
        rail: "tekko",
        tekkoProduct: "pyusd_payin",
        environment: params.environment,
        tekkoCustomerId,
        merchantReference: params.merchantReference,
        network: TEKKO_NETWORK,
        settlementCurrency: TEKKO_SETTLEMENT_CURRENCY,
        merchantMetadata: params.metadata ?? null,
      }),
    })
    .returning();

  if (!tx) throw new Error("Failed to create transaction");

  const idempotencyKey = `tekko-pyusd-${tx.id}`.slice(0, 255);
  const res = await tekkoPost(
    `/customers/${tekkoCustomerId}/pyusd/payment-intents`,
    {
      amount: params.amount,
      merchantReference: params.merchantReference,
      expiresInMinutes,
      metadata: {
        ...(params.metadata ?? {}),
        transactyTransactionId: tx.id,
        transactyMerchantId: params.merchantId,
      },
    },
    idempotencyKey,
    { label: "tekko pyusd create intent" }
  );

  const intent = extractPaymentIntent(res.json);
  if (res.status >= 400 || !intent?.paymentIntentId || !intent.depositAddress) {
    await db
      .update(transactions)
      .set({ status: "failed", updatedAt: new Date() })
      .where(eq(transactions.id, tx.id));
    const detail = pickTekkoMessage(res.json, `Tekko create payment intent failed (${res.status})`);
    if (res.status >= 400 && res.status < 500) {
      throw new UpstreamProviderClientError(detail, detail, res.status, tx.id, null);
    }
    throw new Error(detail);
  }

  await db
    .update(transactions)
    .set({
      externalId: intent.paymentIntentId,
      metadata: mergeMeta(tx.metadata, {
        paymentIntentId: intent.paymentIntentId,
        depositAddress: intent.depositAddress,
        expiresAt: intent.expiresAt ?? null,
        paymentStatus: intent.status ?? "awaiting_payment",
        settlementStatus: intent.settlementStatus ?? "awaiting_payment",
        expectedAmount: intent.expectedAmount ?? params.amount,
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
      provider: TEKKO_PYUSD_PROVIDER,
      paymentIntentId: intent.paymentIntentId,
      amount: params.amount,
      currency: TEKKO_COLLECT_CURRENCY,
    },
  });

  return {
    transactionId: tx.id,
    paymentIntentId: intent.paymentIntentId,
    status: intent.status ?? "awaiting_payment",
    settlementStatus: intent.settlementStatus ?? "awaiting_payment",
    amount: intent.expectedAmount ?? params.amount,
    currency: TEKKO_COLLECT_CURRENCY,
    network: intent.network ?? TEKKO_NETWORK,
    depositAddress: intent.depositAddress,
    expiresAt: intent.expiresAt ?? null,
    environment: params.environment,
  };
}

export async function getTekkoPyusdPaymentIntentStatus(params: {
  merchantId: string;
  transactionId: string;
}): Promise<{
  transactionId: string;
  paymentIntentId: string | null;
  status: string;
  settlementStatus: string | null;
  amount: string;
  paidAmount: string | null;
  currency: string;
  network: string;
  depositAddress: string | null;
  expiresAt: string | null;
  environment: string;
  settled: boolean;
} | null> {
  const [tx] = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.id, params.transactionId),
        eq(transactions.merchantId, params.merchantId),
        eq(transactions.provider, TEKKO_PYUSD_PROVIDER)
      )
    )
    .limit(1);

  if (!tx) {
    return null;
  }

  const meta = parseMeta(tx.metadata);
  const tekkoCustomerId = Number(meta.tekkoCustomerId);
  const paymentIntentId =
    (typeof meta.paymentIntentId === "string" ? meta.paymentIntentId : null) ??
    tx.externalId;

  let paymentStatus =
    typeof meta.paymentStatus === "string" ? meta.paymentStatus : tx.status;
  let settlementStatus =
    typeof meta.settlementStatus === "string" ? meta.settlementStatus : null;
  let depositAddress =
    typeof meta.depositAddress === "string" ? meta.depositAddress : null;
  let expiresAt = typeof meta.expiresAt === "string" ? meta.expiresAt : null;
  let netCollected =
    typeof meta.netCollectedAmount === "string" ? meta.netCollectedAmount : null;

  if (
    tx.environment === "live" &&
    tx.status === "pending" &&
    Number.isFinite(tekkoCustomerId) &&
    paymentIntentId
  ) {
    try {
      const res = await tekkoGet(
        `/customers/${tekkoCustomerId}/pyusd/payment-intents/${paymentIntentId}`,
        { label: "tekko pyusd get intent" }
      );
      const intent = extractPaymentIntent(res.json);
      if (intent) {
        paymentStatus = intent.status ?? paymentStatus;
        settlementStatus = intent.settlementStatus ?? settlementStatus;
        depositAddress = intent.depositAddress ?? depositAddress;
        expiresAt = intent.expiresAt ?? expiresAt;
        if (intent.netCollectedAmount) netCollected = intent.netCollectedAmount;

        await db
          .update(transactions)
          .set({
            metadata: mergeMeta(tx.metadata, {
              paymentStatus,
              settlementStatus,
              depositAddress,
              expiresAt,
              receivedAmount: intent.receivedAmount ?? null,
              grossCollectedAmount: intent.grossCollectedAmount ?? null,
              collectionFeeAmount: intent.collectionFeeAmount ?? null,
              netCollectedAmount: intent.netCollectedAmount ?? null,
              lastPolledAt: new Date().toISOString(),
            }),
            updatedAt: new Date(),
          })
          .where(eq(transactions.id, tx.id));

        // Fail-safe settle from poll when webhook missed.
        if (isSettlementComplete(paymentStatus, settlementStatus) && tx.status === "pending") {
          await settleTekkoPyusdTransaction({
            transactionId: tx.id,
            netUsdcAmount: intent.netCollectedAmount ?? String(tx.amount),
            paymentStatus,
            settlementStatus: settlementStatus ?? "settled",
            source: "poll",
          });
          const [refreshed] = await db
            .select()
            .from(transactions)
            .where(eq(transactions.id, tx.id))
            .limit(1);
          if (refreshed) {
            return presentStatus(refreshed, {
              paymentStatus,
              settlementStatus: settlementStatus ?? "settled",
              depositAddress,
              expiresAt,
            });
          }
        }

        if (isTerminalFailure(paymentStatus) && tx.status === "pending") {
          await markTekkoPyusdFailed(tx.id, paymentStatus);
        }
      }
    } catch {
      // Status read is best-effort; return DB snapshot.
    }
  }

  const [latest] = await db.select().from(transactions).where(eq(transactions.id, tx.id)).limit(1);
  return presentStatus(latest ?? tx, {
    paymentStatus,
    settlementStatus,
    depositAddress,
    expiresAt,
    netCollected,
  });
}

function presentStatus(
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
    paymentStatus: string;
    settlementStatus: string | null;
    depositAddress: string | null;
    expiresAt: string | null;
    netCollected?: string | null;
  }
) {
  const meta = parseMeta(tx.metadata);
  return {
    transactionId: tx.id,
    paymentIntentId:
      (typeof meta.paymentIntentId === "string" ? meta.paymentIntentId : null) ?? tx.externalId,
    status: extra.paymentStatus,
    settlementStatus: extra.settlementStatus,
    amount: String(tx.amount),
    paidAmount: tx.paidAmount ? String(tx.paidAmount) : extra.netCollected ?? null,
    currency: tx.currency,
    network: TEKKO_NETWORK,
    depositAddress: extra.depositAddress,
    expiresAt: extra.expiresAt,
    environment: tx.environment,
    settled: tx.status === "success",
  };
}

export function isSettlementComplete(
  paymentStatus: string | null | undefined,
  settlementStatus: string | null | undefined
): boolean {
  const settle = (settlementStatus ?? "").trim().toLowerCase();
  if (settle === "settled") return true;
  // Updated Tekko docs: customer.wallet.credited may fire after settlement with settled status.
  const pay = (paymentStatus ?? "").trim().toLowerCase();
  return (pay === "paid" || pay === "late_paid") && settle === "settled";
}

export function isTerminalFailure(paymentStatus: string | null | undefined): boolean {
  const s = (paymentStatus ?? "").trim().toLowerCase();
  return (
    s === "expired" ||
    s === "expired_underpaid" ||
    s === "address_failed" ||
    s === "failed"
  );
}

async function markTekkoPyusdFailed(transactionId: string, paymentStatus: string): Promise<void> {
  const [row] = await db.select().from(transactions).where(eq(transactions.id, transactionId)).limit(1);
  if (!row || row.status !== "pending") return;

  const [failed] = await db
    .update(transactions)
    .set({
      status: "failed",
      metadata: mergeMeta(row.metadata, {
        paymentStatus,
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
    meta: { provider: TEKKO_PYUSD_PROVIDER, paymentStatus },
  });
}

/**
 * Credit merchant USDC once. Safe under concurrent webhooks/polls via status guard + ledger check.
 */
export async function settleTekkoPyusdTransaction(params: {
  transactionId: string;
  netUsdcAmount: string;
  paymentStatus: string;
  settlementStatus: string;
  source: "webhook" | "poll";
}): Promise<{ merchantId: string; event: WebhookEvent } | null> {
  const [tx] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, params.transactionId))
    .limit(1);
  if (!tx || tx.provider !== TEKKO_PYUSD_PROVIDER) return null;

  if (tx.status === "success") {
    return null;
  }

  const paidAmount = params.netUsdcAmount.trim();
  if (!paidAmount || !Number.isFinite(Number(paidAmount)) || Number(paidAmount) <= 0) {
    throw new Error("Invalid Tekko settlement amount");
  }

  const wallet = await getOrCreateMerchantWallet({
    merchantId: tx.merchantId,
    environment: tx.environment as "test" | "live",
    currency: TEKKO_SETTLEMENT_CURRENCY,
  });

  const result = await db.transaction(async (txDb) => {
    const [updated] = await txDb
      .update(transactions)
      .set({
        status: "success",
        paidAmount,
        currency: TEKKO_SETTLEMENT_CURRENCY,
        metadata: mergeMeta(tx.metadata, {
          paymentStatus: params.paymentStatus,
          settlementStatus: params.settlementStatus,
          netCollectedAmount: paidAmount,
          settledAt: new Date().toISOString(),
          settledFrom: params.source,
          settlementCurrency: TEKKO_SETTLEMENT_CURRENCY,
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
    if (!w) throw new Error("Wallet missing during Tekko settle");

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
    currency: TEKKO_SETTLEMENT_CURRENCY,
    provider: TEKKO_PYUSD_PROVIDER,
  }).catch(() => undefined);

  audit({
    action: "payment.completed",
    resource: tx.id,
    merchantId: tx.merchantId,
    meta: {
      provider: TEKKO_PYUSD_PROVIDER,
      paidAmount,
      currency: TEKKO_SETTLEMENT_CURRENCY,
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
    currency: TEKKO_SETTLEMENT_CURRENCY,
    provider: TEKKO_PYUSD_PROVIDER,
  }).catch(() => null);

  return {
    merchantId: tx.merchantId,
    event: {
      type: "payin.completed",
      transactionId: tx.id,
      status: "success",
      amount: String(tx.amount),
      paidAmount,
      currency: TEKKO_SETTLEMENT_CURRENCY,
      platformOrderId: tx.externalId ?? null,
      ...feeBreakdownToWebhookFields(breakdown),
    },
  };
}
