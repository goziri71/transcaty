/**
 * Bangladesh payout flow: account inquiry, create payout, handle Payok callback.
 *
 * Concurrency model:
 * - On creation we lock the merchant wallet, debit upfront, and only THEN call Payok.
 *   If Payok rejects, we refund in a follow-up transaction.
 * - The webhook callback transitions the row from pending->success or pending->failed
 *   atomically and conditionally, so duplicate callbacks become no-ops.
 * - On webhook failure we refund (credit payout_refund) — this balances the upfront
 *   debit posted at creation time.
 */
import { eq, and } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions, wallets, ledgerEntries } from "../../../src/db/schema/index.js";
import { payokPayoutAccountInquiry, payokPayoutCreate } from "./provider/client.js";
import { audit } from "../../../src/lib/audit.js";
import { previewTransactionFee, payoutTotalWalletDebit, ensurePayoutFeeCollected } from "../../../src/lib/billing/index.js";
import {
  buildTransactionFeeBreakdown,
  feeBreakdownToWebhookFields,
  formatTransactionFeeBreakdown,
} from "../../../src/lib/billing/transaction-fee-breakdown.js";
import { addAmount, assertPositive, cmpAmount, subAmount } from "../../../src/lib/money.js";
import type { PayokEnvironment } from "./provider/config.js";
import { assertPayoutAllowed } from "../../../src/lib/fraud-policy.js";
import { assertBangladeshPaymentsEnabled } from "../../../src/lib/bangladesh-rail-pause.js";

export class PayoutCreationError extends Error {
  transactionId: string;
  platformOrderId: string | null;
  /** Merchant API `code` when set (e.g. insufficient_balance for EU USDC). */
  merchantCode?: string;
  /** Upstream provider detail for ops (not shown to merchants). */
  upstreamDetail?: string;

  constructor(
    message: string,
    transactionId: string,
    platformOrderId?: string | null,
    merchantCode?: string,
    upstreamDetail?: string
  ) {
    super(message);
    this.name = "PayoutCreationError";
    this.transactionId = transactionId;
    this.platformOrderId = platformOrderId ?? null;
    this.merchantCode = merchantCode;
    this.upstreamDetail = upstreamDetail;
  }
}

async function refundPendingPayout(params: {
  txId: string;
  merchantId: string;
  environment: PayokEnvironment;
  amount: string;
  failedStage: "account_inquiry" | "create_payout";
  failureReason: string;
  externalId?: string | null;
}): Promise<void> {
  await db.transaction(async (txDb) => {
    const [pending] = await txDb
      .select({ metadata: transactions.metadata })
      .from(transactions)
      .where(and(eq(transactions.id, params.txId), eq(transactions.status, "pending")))
      .limit(1);

    if (!pending) {
      return;
    }

    const prevMetadata = pending.metadata
      ? (JSON.parse(pending.metadata) as Record<string, unknown>)
      : {};

    const [updated] = await txDb
      .update(transactions)
      .set({
        status: "failed",
        externalId: params.externalId ?? undefined,
        metadata: JSON.stringify({
          ...prevMetadata,
          failedStage: params.failedStage,
          failureReason: params.failureReason,
        }),
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.id, params.txId), eq(transactions.status, "pending")))
      .returning({ id: transactions.id });

    if (!updated) {
      return;
    }

    const [wallet] = await txDb
      .select()
      .from(wallets)
      .where(
        and(
          eq(wallets.merchantId, params.merchantId),
          eq(wallets.environment, params.environment),
          eq(wallets.type, "merchant")
        )
      )
      .for("update")
      .limit(1);

    if (!wallet) {
      return;
    }

    await txDb.insert(ledgerEntries).values({
      walletId: wallet.id,
      environment: params.environment,
      amount: params.amount,
      direction: "credit",
      type: "payout_refund",
      referenceId: params.txId,
    });

    await txDb
      .update(wallets)
      .set({
        balance: addAmount(wallet.balance, params.amount),
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, wallet.id));
  });
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
  /** Dashboard-initiated payout (audit). */
  portalActor?: { merchantUserId: string; email: string };
}) {
  assertBangladeshPaymentsEnabled();
  assertPositive(params.amount);

  await assertPayoutAllowed({
    merchantId: params.merchantId,
    environment: params.environment,
    amount: params.amount,
    beneficiaryAccountNumber: params.benificiaryAccountInfo.number,
    payerPhone: params.cardHolderInfo.phone,
    payerEmail: params.cardHolderInfo.email,
  });

  const payoutFeePreview = await previewTransactionFee({
    merchantId: params.merchantId,
    environment: params.environment,
    currency: "BDT",
    provider: "payok-bd-payout",
    amount: params.amount,
    feeType: "payout",
  });
  const totalWalletDebit = payoutTotalWalletDebit(params.amount, payoutFeePreview);

  // tx1: lock the merchant wallet, validate balance, debit upfront.
  // The Payok HTTP call must happen OUTSIDE this transaction so we never
  // hold a row lock across the network.
  const created = await db.transaction(async (txDb) => {
    const [wallet] = await txDb
      .select()
      .from(wallets)
      .where(
        and(
          eq(wallets.merchantId, params.merchantId),
          eq(wallets.environment, params.environment),
          eq(wallets.type, "merchant"),
          eq(wallets.currency, "BDT"),
          eq(wallets.status, "active")
        )
      )
      .for("update")
      .limit(1);

    if (!wallet) {
      throw new Error("Merchant BDT wallet not found");
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
        amount: params.amount,
        currency: "BDT",
        provider: "payok-bd-payout",
        metadata: JSON.stringify({
          benificiaryAccountInfo: params.benificiaryAccountInfo,
          cardHolderInfo: params.cardHolderInfo,
          environment: params.environment,
        }),
      })
      .returning();

    if (!tx) throw new Error("Failed to create transaction");

    await txDb.insert(ledgerEntries).values({
      walletId: wallet.id,
      environment: params.environment,
      amount: params.amount,
      direction: "debit",
      type: "payout",
      referenceId: tx.id,
    });

    await txDb
      .update(wallets)
      .set({
        balance: subAmount(wallet.balance, params.amount),
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, wallet.id));

    return { tx };
  });

  const tx = created.tx;

  // Account inquiry (network call, no lock held).
  let inquiryResult: { status: number; body: unknown };
  try {
    inquiryResult = await payokPayoutAccountInquiry({
      environment: params.environment,
      merchantOrderId: tx.id,
      amount: params.amount,
      benificiaryAccountInfo: params.benificiaryAccountInfo,
    });
  } catch (err) {
    await refundPendingPayout({
      txId: tx.id,
      merchantId: params.merchantId,
      environment: params.environment,
      amount: params.amount,
      failedStage: "account_inquiry",
      failureReason: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const inquiry = inquiryResult.body as { code?: string; inquiryToken?: string; message?: string };
  if (inquiryResult.status !== 200 || inquiry.code === "FAIL" || !inquiry.inquiryToken) {
    const reason = inquiry.message ?? JSON.stringify(inquiry);
    await refundPendingPayout({
      txId: tx.id,
      merchantId: params.merchantId,
      environment: params.environment,
      amount: params.amount,
      failedStage: "account_inquiry",
      failureReason: reason,
    });
    throw new PayoutCreationError(`Payok account inquiry failed: ${reason}`, tx.id);
  }

  const notificationUrl = `${params.baseUrl.replace(/\/$/, "")}/webhooks/payok/payout`;

  // Create payout (network call, no lock held).
  let createResult: { status: number; body: unknown };
  try {
    createResult = await payokPayoutCreate({
      environment: params.environment,
      merchantOrderId: tx.id,
      amount: params.amount,
      inquiryToken: inquiry.inquiryToken,
      notificationUrl,
      benificiaryAccountInfo: params.benificiaryAccountInfo,
      cardHolderInfo: params.cardHolderInfo,
    });
  } catch (err) {
    await refundPendingPayout({
      txId: tx.id,
      merchantId: params.merchantId,
      environment: params.environment,
      amount: params.amount,
      failedStage: "create_payout",
      failureReason: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const create = createResult.body as { code?: string; status?: string; platformOrderId?: string };
  if (createResult.status !== 200 || create.code === "FAIL") {
    await refundPendingPayout({
      txId: tx.id,
      merchantId: params.merchantId,
      environment: params.environment,
      amount: params.amount,
      failedStage: "create_payout",
      failureReason: JSON.stringify(create),
      externalId: create.platformOrderId ?? null,
    });
    throw new PayoutCreationError(
      `Payok create payout failed: ${JSON.stringify(create)}`,
      tx.id,
      create.platformOrderId
    );
  }

  // Record externalId. The conditional UPDATE leaves the row alone if a webhook
  // already raced ahead and flipped the status; that's OK because the webhook
  // body carries platformOrderId too.
  if (create.platformOrderId) {
    await db
      .update(transactions)
      .set({ externalId: create.platformOrderId, updatedAt: new Date() })
      .where(eq(transactions.id, tx.id));
  }

  audit({
    action: "payout.created",
    resource: tx.id,
    merchantId: params.merchantId,
    merchantUserId: params.portalActor?.merchantUserId,
    actorEmail: params.portalActor?.email,
    meta: {
      platformOrderId: create.platformOrderId,
      source: params.portalActor ? "portal" : "api",
    },
  });

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

  const result = await db.transaction(async (txDb) => {
    // Conditional pending->terminal transition. Returns no row on a duplicate callback.
    const [updated] = await txDb
      .update(transactions)
      .set({
        status: isSuccess ? "success" : "failed",
        externalId: body.platformOrderId ?? tx.externalId,
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.id, tx.id), eq(transactions.status, "pending")))
      .returning({ id: transactions.id });

    if (!updated) {
      return null;
    }

    if (isSuccess) {
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
      return { isSuccess: true as const };
    }

    // Failure path: refund the upfront debit posted in createPayoutOrder.
    const [wallet] = await txDb
      .select()
      .from(wallets)
      .where(
        and(
          eq(wallets.merchantId, tx.merchantId),
          eq(wallets.environment, tx.environment),
          eq(wallets.type, "merchant"),
          eq(wallets.currency, "BDT")
        )
      )
      .for("update")
      .limit(1);

    if (wallet) {
      await txDb.insert(ledgerEntries).values({
        walletId: wallet.id,
        environment: tx.environment,
        amount: String(tx.amount),
        direction: "credit",
        type: "payout_refund",
        referenceId: tx.id,
      });

      await txDb
        .update(wallets)
        .set({
          balance: addAmount(wallet.balance, String(tx.amount)),
          updatedAt: new Date(),
        })
        .where(eq(wallets.id, wallet.id));
    }

    return { isSuccess: false as const };
  });

  if (!result) {
    return null;
  }

  if (result.isSuccess) {
    audit({
      action: "payout.completed",
      resource: tx.id,
      merchantId: tx.merchantId,
      meta: { platformOrderId: body.platformOrderId },
    });
  } else {
    audit({
      action: "payout.failed",
      resource: tx.id,
      merchantId: tx.merchantId,
      meta: { reason: body.code },
    });
  }

  const failedFeeFields = feeBreakdownToWebhookFields(
    formatTransactionFeeBreakdown({
      type: "payout",
      status: "failed",
      amount: String(tx.amount),
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
      type: "payout",
      status: "success",
      amount: String(tx.amount),
      currency: tx.currency,
      provider: tx.provider,
      metadata: tx.metadata,
    });
    return {
      merchantId: tx.merchantId,
      event: {
        type: "payout.completed" as const,
        transactionId: tx.id,
        status: "success",
        amount: String(tx.amount),
        platformOrderId,
        ...feeBreakdownToWebhookFields(breakdown),
      },
    };
  }

  return {
    merchantId: tx.merchantId,
    event: {
      type: "payout.failed" as const,
      transactionId: tx.id,
      status: "failed",
      amount: String(tx.amount),
      platformOrderId,
      ...failedFeeFields,
    },
  };
}
