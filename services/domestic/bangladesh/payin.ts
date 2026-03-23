/**
 * Bangladesh pay-in flow: create order, handle Payok callback, credit wallet.
 */
import { eq, and } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions, wallets, ledgerEntries } from "../../../src/db/schema/index.js";
import { payokPayinCreateOrder } from "./provider/client.js";
import { audit } from "../../../src/lib/audit.js";
import { tryApplyTransactionFee } from "../../../src/lib/billing/index.js";
import type { PayokEnvironment } from "./provider/config.js";

export async function createPayinOrder(params: {
  merchantId: string;
  environment: PayokEnvironment;
  amount: string;
  paymentMethodCode: string;
  baseUrl: string;
  customer: { name: string; email: string; phone: string; deviceId: string };
  goodsInfo: { name: string; id?: string; price?: string };
}) {
  const [tx] = await db
    .insert(transactions)
    .values({
      merchantId: params.merchantId,
      type: "payin",
      status: "pending",
      amount: params.amount,
      currency: "BDT",
      metadata: JSON.stringify({ paymentMethodCode: params.paymentMethodCode, environment: params.environment }),
    })
    .returning();

  if (!tx) throw new Error("Failed to create transaction");

  const notificationUrl = `${params.baseUrl.replace(/\/$/, "")}/webhooks/payok/payin`;
  const returnUrl = params.baseUrl;

  const { status, body } = await payokPayinCreateOrder({
    environment: params.environment,
    merchantOrderId: tx.id,
    amount: params.amount,
    paymentMethodCode: params.paymentMethodCode,
    notificationUrl,
    returnUrl,
    customer: params.customer,
    goodsInfo: params.goodsInfo,
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

  audit({ action: "payment.created", resource: tx.id, meta: { platformOrderId: res.platformOrderId } });

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

  const paidAmount = body.paidAmount ?? body.amount ?? tx.amount;
  const isSuccess = body.code === "SUCCESS" && body.status === "SUCCESS";
  const platformOrderId = body.platformOrderId ?? tx.externalId ?? null;

  await db
    .update(transactions)
    .set({
      status: isSuccess ? "success" : "failed",
      paidAmount: String(paidAmount),
      externalId: body.platformOrderId ?? tx.externalId,
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, tx.id));

  if (isSuccess) {
    const [wallet] = await db
      .select()
      .from(wallets)
      .where(
        and(
          eq(wallets.merchantId, tx.merchantId),
          eq(wallets.type, "merchant"),
          eq(wallets.status, "active")
        )
      )
      .limit(1);

    if (wallet) {
      await db.insert(ledgerEntries).values({
        walletId: wallet.id,
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
        amount: String(paidAmount),
        feeType: "payin",
      });
    }

    audit({
      action: "payment.completed",
      resource: tx.id,
      meta: { paidAmount, platformOrderId: body.platformOrderId },
    });
  } else {
    audit({ action: "payment.failed", resource: tx.id, meta: { reason: body.code } });
  }

  return {
    merchantId: tx.merchantId,
    event: isSuccess
      ? { type: "payin.completed" as const, transactionId: tx.id, status: "success", amount: String(tx.amount), paidAmount: String(paidAmount), platformOrderId }
      : { type: "payin.failed" as const, transactionId: tx.id, status: "failed", amount: String(tx.amount), platformOrderId },
  };
}
