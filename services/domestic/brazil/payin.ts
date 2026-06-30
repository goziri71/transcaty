/**
 * Brazil pay-in flow (PIX): create order, handle PayOK callback, credit wallet.
 */
import { eq, and } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions, wallets, ledgerEntries } from "../../../src/db/schema/index.js";
// Shared PayOK transport — same merchant account for all countries.
import { payokPayinCreateOrder } from "../bangladesh/provider/client.js";
import { audit } from "../../../src/lib/audit.js";
import { tryApplyTransactionFee } from "../../../src/lib/billing/index.js";
import {
  buildTransactionFeeBreakdown,
  feeBreakdownToWebhookFields,
  formatTransactionFeeBreakdown,
} from "../../../src/lib/billing/transaction-fee-breakdown.js";
import { addAmount } from "../../../src/lib/money.js";
import type { PayokEnvironment } from "../bangladesh/provider/config.js";
import { assertPayinAllowed } from "../../../src/lib/fraud-policy.js";

export async function createPayinOrder(params: {
  merchantId: string;
  environment: PayokEnvironment;
  amount: string;
  paymentMethodCode: string;
  baseUrl: string;
  /** Where PayOK redirects the customer after payment; merchant-facing only (forwarded to PayOK). */
  merchantReturnUrl: string;
  customer: { name: string; email: string; phone: string; deviceId: string };
  goodsInfo: { name: string; id?: string; price?: string };
  /** When set, audit log includes portal user (dashboard-initiated pay-in). */
  portalActor?: { merchantUserId: string; email: string };
}) {
  await assertPayinAllowed({
    merchantId: params.merchantId,
    environment: params.environment,
    customerPhone: params.customer.phone,
    customerEmail: params.customer.email,
  });

  const [tx] = await db
    .insert(transactions)
    .values({
      merchantId: params.merchantId,
      environment: params.environment,
      type: "payin",
      status: "pending",
      amount: params.amount,
      currency: "BRL",
      provider: "payok-br-payin",
      metadata: JSON.stringify({
        paymentMethodCode: params.paymentMethodCode,
        environment: params.environment,
        merchantReturnUrl: params.merchantReturnUrl,
      }),
    })
    .returning();

  if (!tx) throw new Error("Failed to create transaction");

  const notificationUrl = `${params.baseUrl.replace(/\/$/, "")}/webhooks/payok/payin`;
  const returnUrl = params.merchantReturnUrl;

  const { status, body } = await payokPayinCreateOrder({
    environment: params.environment,
    merchantOrderId: tx.id,
    amount: params.amount,
    paymentMethodCode: params.paymentMethodCode,
    notificationUrl,
    returnUrl,
    customer: params.customer,
    goodsInfo: params.goodsInfo,
    countryCode: "BR",
    currency: "BRL",
    language: "EN",
  });

  const res = body as { code?: string; paymentInfo?: { content?: string; type?: string }; platformOrderId?: string };
  if (status !== 200 || res.code === "FAIL") {
    await db.update(transactions).set({ status: "failed" }).where(eq(transactions.id, tx.id));
    throw new Error(`Payok create order failed: ${JSON.stringify(res)}`);
  }

  await db
    .update(transactions)
    .set({ externalId: res.platformOrderId, updatedAt: new Date() })
    .where(eq(transactions.id, tx.id));

  audit({
    action: "payment.created",
    resource: tx.id,
    merchantId: params.merchantId,
    merchantUserId: params.portalActor?.merchantUserId,
    actorEmail: params.portalActor?.email,
    meta: {
      platformOrderId: res.platformOrderId,
      source: params.portalActor ? "portal" : "api",
    },
  });

  return {
    transactionId: tx.id,
    paymentInfo: res.paymentInfo,
    platformOrderId: res.platformOrderId,
  };
}

export async function handlePayinCallback(body: {
  code?: string;
  status?: string;
  merchantOrderId?: string;
  platformOrderId?: string;
  amount?: string;
  paidAmount?: string;
  paymentMethodCode?: string;
}) {
  const merchantOrderId = body.merchantOrderId;
  if (!merchantOrderId) {
    throw new Error("Missing merchantOrderId in callback");
  }

  const [tx] = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.id, merchantOrderId),
        eq(transactions.type, "payin")
      )
    )
    .limit(1);

  if (!tx) {
    throw new Error(`Transaction not found: ${merchantOrderId}`);
  }

  if (tx.status !== "pending") {
    return null;
  }

  const paidAmount = String(body.paidAmount ?? body.amount ?? tx.amount);
  const isSuccess = body.code === "SUCCESS" && body.status === "SUCCESS";
  const platformOrderId = body.platformOrderId ?? tx.externalId ?? null;

  const result = await db.transaction(async (txDb) => {
    // Conditional pending->terminal transition: only one concurrent caller can flip
    // the row, so duplicate Payok callbacks become no-ops past this gate.
    const [updatedTx] = await txDb
      .update(transactions)
      .set({
        status: isSuccess ? "success" : "failed",
        paidAmount,
        externalId: body.platformOrderId ?? tx.externalId,
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.id, tx.id), eq(transactions.status, "pending")))
      .returning({ id: transactions.id });

    if (!updatedTx) {
      return null;
    }

    if (!isSuccess) {
      return { applied: false as const };
    }

    const settlementCurrency = tx.currency.trim().toUpperCase() || "BRL";

    let [wallet] = await txDb
      .select()
      .from(wallets)
      .where(
        and(
          eq(wallets.merchantId, tx.merchantId),
          eq(wallets.environment, tx.environment),
          eq(wallets.type, "merchant"),
          eq(wallets.currency, settlementCurrency),
          eq(wallets.status, "active")
        )
      )
      .for("update")
      .limit(1);

    if (!wallet) {
      const [created] = await txDb
        .insert(wallets)
        .values({
          merchantId: tx.merchantId,
          environment: tx.environment,
          type: "merchant",
          currency: settlementCurrency,
          balance: "0",
          status: "active",
        })
        .returning();
      if (!created) {
        return { applied: true as const, walletCredited: false };
      }
      wallet = created;
    }

    await txDb.insert(ledgerEntries).values({
      walletId: wallet.id,
      environment: tx.environment,
      amount: paidAmount,
      direction: "credit",
      type: "payin",
      referenceId: tx.id,
    });

    await txDb
      .update(wallets)
      .set({
        balance: addAmount(wallet.balance, paidAmount),
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, wallet.id));

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

    return { applied: true as const, walletCredited: true };
  });

  if (!result) {
    return null;
  }

  if (isSuccess) {
    audit({
      action: "payment.completed",
      resource: tx.id,
      merchantId: tx.merchantId,
      meta: { paidAmount, platformOrderId: body.platformOrderId },
    });
  } else {
    audit({
      action: "payment.failed",
      resource: tx.id,
      merchantId: tx.merchantId,
      meta: { reason: body.code },
    });
  }

  const failedFeeFields = feeBreakdownToWebhookFields(
    formatTransactionFeeBreakdown({
      type: "payin",
      status: "failed",
      amount: String(tx.amount),
      paidAmount: null,
      currency: tx.currency,
      platformFee: "0.00",
      feeStatus: "none",
    })
  );

  if (isSuccess) {
    const breakdown = await buildTransactionFeeBreakdown({
      merchantId: tx.merchantId,
      environment: tx.environment,
      transactionId: tx.id,
      type: "payin",
      status: "success",
      amount: String(tx.amount),
      paidAmount,
      currency: tx.currency,
      provider: tx.provider,
      metadata: tx.metadata,
    });
    return {
      merchantId: tx.merchantId,
      event: {
        type: "payin.completed" as const,
        transactionId: tx.id,
        status: "success",
        amount: String(tx.amount),
        paidAmount,
        platformOrderId,
        ...feeBreakdownToWebhookFields(breakdown),
      },
    };
  }

  return {
    merchantId: tx.merchantId,
    event: {
      type: "payin.failed" as const,
      transactionId: tx.id,
      status: "failed",
      amount: String(tx.amount),
      platformOrderId,
      ...failedFeeFields,
    },
  };
}
