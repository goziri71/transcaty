/**
 * TL Pay EU Open Banking payout (USDC → EUR).
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions, wallets, ledgerEntries } from "../../../src/db/schema/index.js";
import { previewTransactionFee, payoutTotalWalletDebit, ensurePayoutFeeCollected } from "../../../src/lib/billing/index.js";
import {
  buildTransactionFeeBreakdown,
  feeBreakdownToWebhookFields,
} from "../../../src/lib/billing/transaction-fee-breakdown.js";
import { audit } from "../../../src/lib/audit.js";
import { addAmount, assertPositive, cmpAmount, normalizeMoneyAmountToTwoDecimals, subAmount } from "../../../src/lib/money.js";
import type { WebhookEvent } from "../../../src/lib/merchant-webhook.js";
import { PayoutCreationError } from "../../domestic/bangladesh/payout.js";
import { applySpreadToCryptoAmount, applySpreadToRate } from "../../../src/lib/fx/spread.js";
import { resolveFxSpread } from "../../../src/lib/fx/rate-resolver.js";
import { UpstreamProviderClientError } from "../../../src/lib/merchant-facing-errors.js";
import { tyltSignedPostJson } from "./client.js";
import { pickTyltJsonPrimaryMessage } from "./h2h-upi.js";
import type { TyltMerchantEnvironment } from "./config.js";
import {
  classifyEurPayoutDecision,
  extractEurCreateInstanceResponse,
  extractEurInstanceDetailsView,
  extractEurOpenBankingData,
  fetchEurInstanceDetails,
  parseEurEventId,
  parseEurIsBuying,
  parseEurMerchantOrderId,
  TYLT_PRODUCT_EUR_PAYOUT,
} from "./eur-open-banking.js";
import { resolveTyltEurMerchantDetails, type TyltEurMerchantDetails } from "./eur-merchant-details.js";
import { mergeTransactionMetadata, parseTransactionMetadata } from "./crossramp-payin.js";

const RAIL = "tylt";
const SETTLEMENT_CURRENCY = "USDC";

export { TYLT_PRODUCT_EUR_PAYOUT };

export function isTyltEurPayoutMetadata(meta: Record<string, unknown>): boolean {
  return meta.rail === RAIL && meta.tyltProduct === TYLT_PRODUCT_EUR_PAYOUT;
}

function mergeMeta(existing: string | null, patch: Record<string, unknown>): string {
  return mergeTransactionMetadata(existing, patch);
}

async function refundEurPayoutDebit(params: {
  id: string;
  merchantId: string;
  environment: TyltMerchantEnvironment;
  debitAmount: string;
}) {
  await db.transaction(async (txDb) => {
    const [updated] = await txDb
      .update(transactions)
      .set({ status: "failed", updatedAt: new Date() })
      .where(and(eq(transactions.id, params.id), eq(transactions.status, "pending")))
      .returning();

    if (!updated) return;

    const [wallet] = await txDb
      .select()
      .from(wallets)
      .where(
        and(
          eq(wallets.merchantId, params.merchantId),
          eq(wallets.environment, params.environment),
          eq(wallets.type, "merchant"),
          eq(wallets.currency, SETTLEMENT_CURRENCY),
          eq(wallets.status, "active")
        )
      )
      .for("update")
      .limit(1);

    if (!wallet) return;

    await txDb.insert(ledgerEntries).values({
      walletId: wallet.id,
      environment: params.environment,
      amount: params.debitAmount,
      direction: "credit",
      type: "payout_refund",
      referenceId: params.id,
    });

    await txDb
      .update(wallets)
      .set({
        balance: addAmount(wallet.balance, params.debitAmount),
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, wallet.id));
  });
}

export async function createTyltEurPayoutInstance(params: {
  merchantId: string;
  environment: TyltMerchantEnvironment;
  baseUrl: string;
  amount: string;
  currencySymbol: "EUR";
  returnUrl: string;
  userDetails: Record<string, unknown>;
  payeeDetails: Record<string, unknown>;
  autoMerchantApproval?: 0 | 1;
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
  const callBackUrl = `${params.baseUrl.replace(/\/$/, "")}/webhooks/tylt/eur-payout/${params.environment}`;
  const merchantDetails =
    params.merchantDetails ??
    (await resolveTyltEurMerchantDetails({
      merchantId: params.merchantId,
      merchantUrl: params.merchantUrl,
    }));

  assertPositive(params.amount);

  const metadata = {
    rail: RAIL,
    tyltProduct: TYLT_PRODUCT_EUR_PAYOUT,
    fiatCurrency: params.currencySymbol,
    fiatAmount: params.amount,
    merchantReturnUrl: params.returnUrl,
    autoMerchantApproval: params.autoMerchantApproval ?? 1,
  };

  const [tx] = await db
    .insert(transactions)
    .values({
      merchantId: params.merchantId,
      environment: params.environment,
      type: "payout",
      status: "pending",
      amount: params.amount,
      currency: SETTLEMENT_CURRENCY,
      provider: "tylt-eur-payout",
      metadata: JSON.stringify({ ...metadata, debitAmount: null }),
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
    payeeDetails: params.payeeDetails,
    autoMerchantApproval: params.autoMerchantApproval ?? 1,
    cryptoUi: params.cryptoUi ?? 1,
  };

  const { status, json } = await tyltSignedPostJson<Record<string, unknown>>({
    environment: params.environment,
    path: "/v2/prime-fiat/instance/payout",
    body,
    idempotencyKey: tx.id,
    credentialProfile: "eur_payout",
  });

  const parsed = extractEurCreateInstanceResponse(json);

  if (status >= 400 || !parsed.instanceId || !parsed.checkoutUrl) {
    await db.update(transactions).set({ status: "failed", updatedAt: new Date() }).where(eq(transactions.id, tx.id));
    const merchantMsg =
      pickTyltJsonPrimaryMessage(json) ??
      "Payment partner could not create this payout. Check amount, payee IBAN, and merchant details.";
    throw new UpstreamProviderClientError(
      `tylt_eur_payout_create http=${status}`,
      merchantMsg,
      status >= 400 ? status : 502,
      tx.id,
      null
    );
  }

  const debitAmountRaw = normalizeMoneyAmountToTwoDecimals(
    parsed.cryptoAmount && Number.isFinite(parseFloat(parsed.cryptoAmount)) ? parsed.cryptoAmount : params.amount
  );

  const fxSpread = await resolveFxSpread({
    merchantId: params.merchantId,
    environment: params.environment,
    product: "eur_payout",
    settledCurrency: SETTLEMENT_CURRENCY,
  });
  if (fxSpread?.disabled) {
    await db.update(transactions).set({ status: "failed", updatedAt: new Date() }).where(eq(transactions.id, tx.id));
    throw new PayoutCreationError("EUR crypto send-out is disabled for this merchant", tx.id, null, "disabled");
  }
  const spreadParts = applySpreadToCryptoAmount(debitAmountRaw, fxSpread?.spreadBps ?? 0);
  const debitAmount = spreadParts.totalDebit;
  const payoutFeePreview = await previewTransactionFee({
    merchantId: params.merchantId,
    environment: params.environment,
    currency: SETTLEMENT_CURRENCY,
    provider: "tylt-eur-payout",
    amount: debitAmount,
    feeType: "payout",
  });
  const totalWalletDebit = payoutTotalWalletDebit(debitAmount, payoutFeePreview);
  const merchantRate =
    parsed.rate != null && Number.isFinite(parsed.rate)
      ? applySpreadToRate(parsed.rate, fxSpread?.spreadBps ?? 0)
      : parsed.rate;

  try {
    await db.transaction(async (txDb) => {
      const [wallet] = await txDb
        .select()
        .from(wallets)
        .where(
          and(
            eq(wallets.merchantId, params.merchantId),
            eq(wallets.environment, params.environment),
            eq(wallets.type, "merchant"),
            eq(wallets.currency, SETTLEMENT_CURRENCY),
            eq(wallets.status, "active")
          )
        )
        .for("update")
        .limit(1);

      if (!wallet) {
        throw new PayoutCreationError("Merchant USDC wallet not found", tx.id, null, "wallet_not_found");
      }
      if (cmpAmount(wallet.balance, totalWalletDebit) < 0) {
        throw new PayoutCreationError("Insufficient USDC balance", tx.id, null, "insufficient_balance");
      }

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
    });
  } catch (err) {
    await db.update(transactions).set({ status: "failed", updatedAt: new Date() }).where(eq(transactions.id, tx.id));
    throw err;
  }

  await db
    .update(transactions)
    .set({
      externalId: parsed.instanceId,
      amount: debitAmount,
      metadata: mergeMeta(tx.metadata, {
        checkoutUrl: parsed.checkoutUrl,
        debitAmount,
        payoutSendAmount: debitAmountRaw,
        fxSpreadBps: fxSpread?.spreadBps ?? 0,
        fxSpreadAmount: spreadParts.spreadAmount,
        fxRateProfileId: fxSpread?.rateProfileId ?? null,
        quoteCryptoAmount: parsed.cryptoAmount,
        quoteRate: parsed.rate,
        merchantRate,
        fiatAmount: params.amount,
      }),
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, tx.id));

  audit({
    action: "payout.created",
    resource: tx.id,
    merchantId: params.merchantId,
    meta: { instanceId: parsed.instanceId, product: TYLT_PRODUCT_EUR_PAYOUT, debitAmount },
  });

  return {
    transactionId: tx.id,
    amount: params.amount,
    fiatCurrency: params.currencySymbol,
    settlementCurrency: SETTLEMENT_CURRENCY,
    instanceId: parsed.instanceId,
    checkoutUrl: parsed.checkoutUrl,
    cryptoAmount: parsed.cryptoAmount,
    rate: merchantRate,
  };
}

export async function approveTyltEurPayout(params: {
  environment: TyltMerchantEnvironment;
  transactionId: string;
  merchantId: string;
}): Promise<{ status: number; json: unknown }> {
  const [tx] = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.id, params.transactionId),
        eq(transactions.merchantId, params.merchantId),
        eq(transactions.environment, params.environment),
        eq(transactions.type, "payout")
      )
    )
    .limit(1);

  if (!tx) throw new Error("Payout not found");

  const meta = parseTransactionMetadata(tx);
  if (!isTyltEurPayoutMetadata(meta)) throw new Error("Not an EU Open Banking payout");

  return tyltSignedPostJson({
    environment: params.environment,
    path: "/v2/prime-fiat/instance/payout/approve",
    body: { merchantOrderId: tx.id },
    idempotencyKey: `approve:${tx.id}`,
    credentialProfile: "eur_payout",
  });
}

export async function getMerchantEurPayoutStatus(params: {
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

  if (!tx || tx.type !== "payout") return null;

  const meta = parseTransactionMetadata(tx);
  if (!isTyltEurPayoutMetadata(meta)) return null;

  const live = await fetchEurInstanceDetails({
    environment: params.environment,
    merchantOrderId: tx.id,
  });

  const liveData = live.status < 500 ? extractEurInstanceDetailsView(live.json) : null;
  const eventId = liveData != null ? parseEurEventId({ data: liveData }) : null;

  return {
    transactionId: tx.id,
    status: tx.status,
    amount: String(meta.fiatAmount ?? tx.amount),
    fiatCurrency: String(meta.fiatCurrency ?? "EUR"),
    settlementCurrency: tx.currency,
    debitAmount: typeof meta.debitAmount === "string" ? meta.debitAmount : String(tx.amount),
    instanceId: tx.externalId ?? null,
    checkoutUrl: typeof meta.checkoutUrl === "string" ? meta.checkoutUrl : null,
    eventId: eventId ?? null,
    upstream: liveData,
    detailsSource: liveData ? ("live" as const) : ("local" as const),
  };
}

export async function applyTyltEurPayoutWebhookPayload(
  parsed: unknown
): Promise<{ merchantId: string; event: WebhookEvent } | null> {
  const isBuying = parseEurIsBuying(parsed);
  if (isBuying === 1) return null;

  const eventId = parseEurEventId(parsed);
  const merchantOrderId = parseEurMerchantOrderId(parsed);
  if (!merchantOrderId) return null;

  const [tx] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, merchantOrderId), eq(transactions.type, "payout")))
    .limit(1);

  if (!tx) return null;

  const meta = parseTransactionMetadata(tx);
  if (!isTyltEurPayoutMetadata(meta)) return null;

  const decision = classifyEurPayoutDecision(eventId);
  const debitAmount = String(meta.debitAmount ?? tx.amount);

  if (decision === "non_terminal" || decision === "unknown") {
    if (eventId != null) {
      const data = extractEurOpenBankingData(parsed);
      await db
        .update(transactions)
        .set({
          metadata: mergeMeta(tx.metadata, {
            lastEventId: eventId,
            payoutSnapshot: data ? { updatedAt: new Date().toISOString(), data } : undefined,
          }),
          updatedAt: new Date(),
        })
        .where(eq(transactions.id, tx.id));
    }
    return null;
  }

  if (tx.status !== "pending") return null;

  if (decision === "failed") {
    await refundEurPayoutDebit({
      id: tx.id,
      merchantId: tx.merchantId,
      environment: tx.environment as TyltMerchantEnvironment,
      debitAmount,
    });

    audit({
      action: "payout.failed",
      resource: tx.id,
      merchantId: tx.merchantId,
      meta: { reason: "eur_payout_terminal", eventId, product: TYLT_PRODUCT_EUR_PAYOUT },
    });

    return {
      merchantId: tx.merchantId,
      event: {
        type: "payout.failed",
        transactionId: tx.id,
        status: "failed",
        amount: String(meta.fiatAmount ?? tx.amount),
        platformOrderId: tx.externalId ?? null,
      },
    };
  }

  const transitioned = await db.transaction(async (txDb) => {
    const [updated] = await txDb
      .update(transactions)
      .set({
        status: "success",
        metadata: mergeMeta(tx.metadata, { lastEventId: eventId ?? 5 }),
        updatedAt: new Date(),
      })
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
        amount: String(meta.debitAmount ?? tx.amount),
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
    meta: { product: TYLT_PRODUCT_EUR_PAYOUT, eventId, debitAmount },
  });

  const payoutAmount = String(meta.fiatAmount ?? tx.amount);
  const feeBaseAmount = String(meta.debitAmount ?? tx.amount);
  const breakdown = await buildTransactionFeeBreakdown({
    merchantId: tx.merchantId,
    environment: tx.environment,
    transactionId: tx.id,
    type: "payout",
    status: "success",
    amount: feeBaseAmount,
    currency: tx.currency,
    provider: tx.provider,
  });

  return {
    merchantId: tx.merchantId,
    event: {
      type: "payout.completed",
      transactionId: tx.id,
      status: "success",
      amount: payoutAmount,
      platformOrderId: tx.externalId ?? null,
      ...feeBreakdownToWebhookFields(breakdown),
    },
  };
}
