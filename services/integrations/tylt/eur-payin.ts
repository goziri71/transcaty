/**
 * TL Pay EU Open Banking pay-in (EUR/GBP → USDC).
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions, wallets, ledgerEntries } from "../../../src/db/schema/index.js";
import { audit } from "../../../src/lib/audit.js";
import { tryApplyTransactionFee } from "../../../src/lib/billing/index.js";
import { addAmount } from "../../../src/lib/money.js";
import type { WebhookEvent } from "../../../src/lib/merchant-webhook.js";
import { tyltSignedPostJson } from "./client.js";
import type { TyltMerchantEnvironment } from "./config.js";
import {
  classifyEurPayinDecision,
  extractEurCreateInstanceResponse,
  extractEurInstanceDetailsView,
  extractEurOpenBankingData,
  fetchEurInstanceDetails,
  parseEurCreditAmount,
  parseEurEventId,
  parseEurIsBuying,
  parseEurMerchantOrderId,
  TYLT_PRODUCT_EUR_PAYIN,
} from "./eur-open-banking.js";
import { resolveTyltEurMerchantDetails, type TyltEurMerchantDetails } from "./eur-merchant-details.js";
import {
  getOrCreateMerchantWallet,
  mergeTransactionMetadata,
  parseTransactionMetadata,
  selectPayinTxByMerchantOrderRef,
} from "./crossramp-payin.js";

const RAIL = "tylt";
const SETTLEMENT_CURRENCY = "USDC";

export { TYLT_PRODUCT_EUR_PAYIN };

export function isTyltEurPayinMetadata(meta: Record<string, unknown>): boolean {
  return meta.rail === RAIL && meta.tyltProduct === TYLT_PRODUCT_EUR_PAYIN;
}

function mergeMeta(existing: string | null, patch: Record<string, unknown>): string {
  return mergeTransactionMetadata(existing, patch);
}

export async function createTyltEurPayinInstance(params: {
  merchantId: string;
  environment: TyltMerchantEnvironment;
  baseUrl: string;
  amount: string;
  currencySymbol: "EUR" | "GBP";
  returnUrl: string;
  userDetails: Record<string, unknown>;
  merchantUrl?: string;
  merchantDetails?: TyltEurMerchantDetails;
  cryptoUi?: 0 | 1;
}): Promise<{
  transactionId: string;
  amount: string;
  fiatCurrency: string;
  settlementCurrency: string;
  instanceId: string;
  checkoutUrl: string;
  cryptoAmount: string | null;
  rate: number | null;
}> {
  const callBackUrl = `${params.baseUrl.replace(/\/$/, "")}/webhooks/tylt/eur-payin/${params.environment}`;
  const merchantDetails =
    params.merchantDetails ??
    (await resolveTyltEurMerchantDetails({
      merchantId: params.merchantId,
      merchantUrl: params.merchantUrl,
    }));

  const fiatCurrency = params.currencySymbol;
  const metadata = {
    rail: RAIL,
    tyltProduct: TYLT_PRODUCT_EUR_PAYIN,
    fiatCurrency,
    fiatAmount: params.amount,
    merchantReturnUrl: params.returnUrl,
  };

  const [tx] = await db
    .insert(transactions)
    .values({
      merchantId: params.merchantId,
      environment: params.environment,
      type: "payin",
      status: "pending",
      amount: params.amount,
      currency: SETTLEMENT_CURRENCY,
      provider: "tylt-eur-payin",
      metadata: JSON.stringify(metadata),
    })
    .returning();

  if (!tx) throw new Error("Failed to create transaction");

  const amtNum = parseFloat(params.amount);
  const body: Record<string, unknown> = {
    merchantOrderId: tx.id,
    callBackUrl,
    redirectUrl: params.returnUrl,
    amount: Number.isFinite(amtNum) ? amtNum : params.amount,
    currencySymbol: params.currencySymbol,
    merchantDetails,
    userDetails: params.userDetails,
    cryptoUi: params.cryptoUi ?? 1,
  };

  const { status, json } = await tyltSignedPostJson<Record<string, unknown>>({
    environment: params.environment,
    path: "/v2/prime-fiat/instance/payin",
    body,
    idempotencyKey: tx.id,
    credentialProfile: "eur_payin",
  });

  const parsed = extractEurCreateInstanceResponse(json);

  if (status >= 400 || !parsed.instanceId || !parsed.checkoutUrl) {
    await db.update(transactions).set({ status: "failed", updatedAt: new Date() }).where(eq(transactions.id, tx.id));
    throw new Error("Tylt EU pay-in create failed");
  }

  await db
    .update(transactions)
    .set({
      externalId: parsed.instanceId,
      metadata: mergeMeta(tx.metadata, {
        checkoutUrl: parsed.checkoutUrl,
        quoteCryptoAmount: parsed.cryptoAmount,
        quoteRate: parsed.rate,
      }),
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, tx.id));

  audit({
    action: "payment.created",
    resource: tx.id,
    merchantId: params.merchantId,
    meta: { instanceId: parsed.instanceId, rail: RAIL, product: TYLT_PRODUCT_EUR_PAYIN },
  });

  return {
    transactionId: tx.id,
    amount: params.amount,
    fiatCurrency,
    settlementCurrency: SETTLEMENT_CURRENCY,
    instanceId: parsed.instanceId,
    checkoutUrl: parsed.checkoutUrl,
    cryptoAmount: parsed.cryptoAmount,
    rate: parsed.rate,
  };
}

export async function getMerchantEurPayinStatus(params: {
  merchantId: string;
  environment: TyltMerchantEnvironment;
  transactionId: string;
}) {
  const [tx] = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.id, params.transactionId),
        eq(transactions.merchantId, params.merchantId),
        eq(transactions.environment, params.environment)
      )
    )
    .limit(1);

  if (!tx || tx.type !== "payin") return null;

  const meta = parseTransactionMetadata(tx);
  if (!isTyltEurPayinMetadata(meta)) return null;

  const live = await fetchEurInstanceDetails({
    environment: params.environment,
    merchantOrderId: tx.id,
  });

  const liveData = live.status < 500 ? extractEurInstanceDetailsView(live.json) : null;
  const eventId =
    liveData != null
      ? parseEurEventId({ data: liveData })
      : typeof meta.lastEventId === "number"
        ? meta.lastEventId
        : null;

  return {
    transactionId: tx.id,
    status: tx.status,
    amount: String(tx.amount),
    fiatCurrency: String(meta.fiatCurrency ?? "EUR"),
    settlementCurrency: tx.currency,
    instanceId: tx.externalId ?? null,
    checkoutUrl: typeof meta.checkoutUrl === "string" ? meta.checkoutUrl : null,
    eventId: eventId ?? null,
    upstream: liveData,
    detailsSource: liveData ? ("live" as const) : ("local" as const),
  };
}

export async function applyTyltEurPayinWebhookPayload(
  parsed: unknown
): Promise<{ merchantId: string; event: WebhookEvent } | null> {
  const isBuying = parseEurIsBuying(parsed);
  if (isBuying === 0) return null;

  const eventId = parseEurEventId(parsed);
  const merchantOrderId = parseEurMerchantOrderId(parsed);
  if (merchantOrderId == null) return null;

  const tx = await selectPayinTxByMerchantOrderRef(merchantOrderId);
  if (!tx) return null;

  const meta = parseTransactionMetadata(tx);
  if (!isTyltEurPayinMetadata(meta)) return null;

  const decision = classifyEurPayinDecision(eventId);

  if (decision === "non_terminal" || decision === "unknown") {
    if (eventId != null) {
      const data = extractEurOpenBankingData(parsed);
      await db
        .update(transactions)
        .set({
          metadata: mergeMeta(tx.metadata, {
            lastEventId: eventId,
            payinSnapshot: data ? { updatedAt: new Date().toISOString(), data } : undefined,
          }),
          updatedAt: new Date(),
        })
        .where(eq(transactions.id, tx.id));
    }
    return null;
  }

  if (tx.status !== "pending") return null;

  if (decision === "failed") {
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
      meta: { reason: "eur_payin_terminal", eventId, product: TYLT_PRODUCT_EUR_PAYIN },
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

  const paidAmount = parseEurCreditAmount(parsed, String(meta.quoteCryptoAmount ?? tx.amount));

  const wallet = await getOrCreateMerchantWallet({
    merchantId: tx.merchantId,
    environment: tx.environment,
    currency: SETTLEMENT_CURRENCY,
  });

  const result = await db.transaction(async (txDb) => {
    const [updated] = await txDb
      .update(transactions)
      .set({
        status: "success",
        paidAmount,
        metadata: mergeMeta(tx.metadata, { lastEventId: eventId ?? 5 }),
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

    if (!lockedWallet) return { walletCredited: false as const };

    await txDb.insert(ledgerEntries).values({
      walletId: lockedWallet.id,
      environment: tx.environment,
      amount: paidAmount,
      direction: "credit",
      type: "payin",
      referenceId: tx.id,
    });

    await txDb
      .update(wallets)
      .set({
        balance: addAmount(lockedWallet.balance, paidAmount),
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
        amount: paidAmount,
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
    meta: { paidAmount, platformOrderId: tx.externalId, product: TYLT_PRODUCT_EUR_PAYIN, eventId },
  });

  return {
    merchantId: tx.merchantId,
    event: {
      type: "payin.completed",
      transactionId: tx.id,
      status: "success",
      amount: String(tx.amount),
      paidAmount,
      platformOrderId: tx.externalId ?? null,
    },
  };
}
