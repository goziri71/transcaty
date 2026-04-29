/**
 * Tylt CrossRamp UPI pay-in: create hosted instance, finalize on signed webhook only.
 */
import { eq, and } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions, wallets, ledgerEntries } from "../../../src/db/schema/index.js";
import { audit } from "../../../src/lib/audit.js";
import { tryApplyTransactionFee } from "../../../src/lib/billing/index.js";
import type { WebhookEvent } from "../../../src/lib/merchant-webhook.js";
import { tyltSignedPostJson } from "./client.js";
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
  if (eventId <= 3 || eventId === 7 || eventId === 8 || eventId > 9) {
    return null;
  }

  const [tx] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, merchantOrderId), eq(transactions.type, "payin")))
    .limit(1);

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

    const [updated] = await db
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

    const wallet = await getOrCreateMerchantWallet({
      merchantId: tx.merchantId,
      environment: tx.environment,
      currency: tx.currency,
    });

    if (wallet) {
      await db.insert(ledgerEntries).values({
        walletId: wallet.id,
        environment: tx.environment,
        amount: String(paidAmount),
        direction: "credit",
        type: "payin",
        referenceId: tx.id,
      });

      await db
        .update(wallets)
        .set({
          balance: String(Number(wallet.balance) + Number(paidAmount)),
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, wallet.id));

      await tryApplyTransactionFee({
        merchantId: tx.merchantId,
        transactionId: tx.id,
        environment: tx.environment,
        amount: String(paidAmount),
        feeType: "payin",
      });
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
