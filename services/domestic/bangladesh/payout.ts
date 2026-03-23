/**
 * Bangladesh payout flow: account inquiry, create payout, handle Payok callback.
 */
import { eq, and } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions, wallets, ledgerEntries } from "../../../src/db/schema/index.js";
import { payokPayoutAccountInquiry, payokPayoutCreate } from "./provider/client.js";
import { audit } from "../../../src/lib/audit.js";
import { tryApplyTransactionFee } from "../../../src/lib/billing/index.js";
import type { PayokEnvironment } from "./provider/config.js";

export class PayoutCreationError extends Error {
  transactionId: string;
  platformOrderId: string | null;

  constructor(message: string, transactionId: string, platformOrderId?: string | null) {
    super(message);
    this.name = "PayoutCreationError";
    this.transactionId = transactionId;
    this.platformOrderId = platformOrderId ?? null;
  }
}

export async function createPayoutOrder(params: {
  merchantId: string;
  environment: PayokEnvironment;
  amount: string;
  baseUrl: string;
  benificiaryAccountInfo: {
    number: string;
    orgId: string;
    orgCode: string;
    orgName: string;
    holderName: string;
  };
  cardHolderInfo: { firstName: string; lastName: string; email: string; phone: string };
}) {
  const [wallet] = await db
    .select()
    .from(wallets)
    .where(
      and(
        eq(wallets.merchantId, params.merchantId),
        eq(wallets.type, "merchant"),
        eq(wallets.status, "active")
      )
    )
    .limit(1);

  if (!wallet) throw new Error("Merchant wallet not found");
  if (Number(wallet.balance) < Number(params.amount)) {
    throw new Error("Insufficient balance");
  }

  const [tx] = await db
    .insert(transactions)
    .values({
      merchantId: params.merchantId,
      type: "payout",
      status: "pending",
      amount: params.amount,
      currency: "BDT",
      metadata: JSON.stringify({ benificiaryAccountInfo: params.benificiaryAccountInfo, environment: params.environment }),
    })
    .returning();

  if (!tx) throw new Error("Failed to create transaction");

  const { status: inquiryStatus, body: inquiryBody } = await payokPayoutAccountInquiry({
    environment: params.environment,
    merchantOrderId: tx.id,
    amount: params.amount,
    benificiaryAccountInfo: params.benificiaryAccountInfo,
  });

  const inquiry = inquiryBody as { code?: string; inquiryToken?: string; message?: string };
  if (inquiryStatus !== 200 || inquiry.code === "FAIL" || !inquiry.inquiryToken) {
    const prevMetadata = tx.metadata ? (JSON.parse(tx.metadata) as Record<string, unknown>) : {};
    await db
      .update(transactions)
      .set({
        status: "failed",
        metadata: JSON.stringify({
          ...prevMetadata,
          failedStage: "account_inquiry",
          failureReason: inquiry.message ?? JSON.stringify(inquiry),
        }),
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, tx.id));
    throw new PayoutCreationError(
      `Payok account inquiry failed: ${inquiry.message ?? JSON.stringify(inquiry)}`,
      tx.id
    );
  }

  const notificationUrl = `${params.baseUrl.replace(/\/$/, "")}/webhooks/payok/payout`;

  const { status: createStatus, body: createBody } = await payokPayoutCreate({
    environment: params.environment,
    merchantOrderId: tx.id,
    amount: params.amount,
    inquiryToken: inquiry.inquiryToken,
    notificationUrl,
    benificiaryAccountInfo: params.benificiaryAccountInfo,
    cardHolderInfo: params.cardHolderInfo,
  });

  const create = createBody as { code?: string; status?: string; platformOrderId?: string };
  if (createStatus !== 200 || create.code === "FAIL") {
    const prevMetadata = tx.metadata ? (JSON.parse(tx.metadata) as Record<string, unknown>) : {};
    await db
      .update(transactions)
      .set({
        status: "failed",
        externalId: create.platformOrderId,
        metadata: JSON.stringify({
          ...prevMetadata,
          failedStage: "create_payout",
          failureReason: JSON.stringify(create),
        }),
        updatedAt: new Date(),
      })
      .where(eq(transactions.id, tx.id));
    throw new PayoutCreationError(
      `Payok create payout failed: ${JSON.stringify(create)}`,
      tx.id,
      create.platformOrderId
    );
  }

  await db
    .update(transactions)
    .set({ externalId: create.platformOrderId, updatedAt: new Date() })
    .where(eq(transactions.id, tx.id));

  await db.insert(ledgerEntries).values({
    walletId: wallet.id,
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

  audit({ action: "payout.created", resource: tx.id, meta: { platformOrderId: create.platformOrderId } });

  return {
    transactionId: tx.id,
    status: create.status,
    platformOrderId: create.platformOrderId,
  };
}

export async function handlePayoutCallback(body: {
  code?: string;
  status?: string;
  merchantOrderId?: string;
  platformOrderId?: string;
  amount?: string;
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
        eq(transactions.type, "payout")
      )
    )
    .limit(1);

  if (!tx) {
    throw new Error(`Transaction not found: ${merchantOrderId}`);
  }

  if (tx.status !== "pending") {
    return null;
  }

  const isSuccess = body.code === "SUCCESS" && body.status === "SUCCESS";
  const platformOrderId = body.platformOrderId ?? tx.externalId ?? null;

  await db
    .update(transactions)
    .set({
      status: isSuccess ? "success" : "failed",
      externalId: body.platformOrderId ?? tx.externalId,
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, tx.id));

  if (isSuccess) {
    await tryApplyTransactionFee({
      merchantId: tx.merchantId,
      transactionId: tx.id,
      amount: String(tx.amount),
      feeType: "payout",
    });
    audit({
      action: "payout.completed",
      resource: tx.id,
      meta: { platformOrderId: body.platformOrderId },
    });
  } else {
    const [wallet] = await db
      .select()
      .from(wallets)
      .where(
        and(
          eq(wallets.merchantId, tx.merchantId),
          eq(wallets.type, "merchant")
        )
      )
    .limit(1);

    if (wallet) {
      await db.insert(ledgerEntries).values({
        walletId: wallet.id,
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

    audit({ action: "payout.failed", resource: tx.id, meta: { reason: body.code } });
  }

  return {
    merchantId: tx.merchantId,
    event: isSuccess
      ? { type: "payout.completed" as const, transactionId: tx.id, status: "success", amount: String(tx.amount), platformOrderId }
      : { type: "payout.failed" as const, transactionId: tx.id, status: "failed", amount: String(tx.amount), platformOrderId },
  };
}
