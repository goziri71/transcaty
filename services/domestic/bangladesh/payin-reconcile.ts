/**
 * Pull Payok pay-in status and apply handlePayinCallback when terminal.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { ledgerEntries, transactions, wallets } from "../../../src/db/schema/index.js";
import { audit } from "../../../src/lib/audit.js";
import { addAmount, subAmount } from "../../../src/lib/money.js";
import type { WebhookEvent } from "../../../src/lib/merchant-webhook.js";
import { handlePayinCallback } from "./payin.js";
import { payokPayinInquiry } from "./provider/client.js";
import { getDefaultPayokEnvironment, type PayokEnvironment } from "./provider/config.js";

export type ReconcilePayokPayinResult =
  | { outcome: "error"; detail: string }
  | { outcome: "skipped"; transactionId: string; reason: "already_terminal" | "wrong_rail" }
  | {
      outcome: "not_terminal";
      transactionId: string;
      payokCode?: string | null;
      payokStatus?: string | null;
      detail?: string;
    }
  | {
      outcome: "finalized";
      transactionId: string;
      merchantWebhook: { merchantId: string; event: WebhookEvent } | null;
      payokCode?: string | null;
      payokStatus?: string | null;
    };

function resolvePayokEnvironment(metadata: string | null, txEnvironment: string): PayokEnvironment {
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata) as { environment?: string };
      if (parsed.environment === "test" || parsed.environment === "live") {
        return parsed.environment;
      }
    } catch {
      // fall through
    }
  }
  if (txEnvironment === "test" || txEnvironment === "live") {
    return txEnvironment;
  }
  return getDefaultPayokEnvironment();
}

function isPayokBangladeshPayin(provider: string | null): boolean {
  return provider === "payok-bd-payin" || provider === null;
}

function isTerminalPayokOutcome(code?: string, status?: string): boolean {
  if (code === "SUCCESS" && status === "SUCCESS") return true;
  if (code === "FAIL" || status === "FAILED" || status === "FAIL") return true;
  return false;
}

export async function reconcileBangladeshPayokPayinByTransactionId(
  transactionId: string
): Promise<ReconcilePayokPayinResult> {
  const [tx] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, transactionId))
    .limit(1);

  if (!tx) {
    return { outcome: "error", detail: "transaction_not_found" };
  }
  if (tx.type !== "payin") {
    return { outcome: "error", detail: "not_payin" };
  }
  if (!isPayokBangladeshPayin(tx.provider)) {
    return { outcome: "skipped", transactionId: tx.id, reason: "wrong_rail" };
  }
  if (tx.status !== "pending") {
    return { outcome: "skipped", transactionId: tx.id, reason: "already_terminal" };
  }

  const payokEnvironment = resolvePayokEnvironment(tx.metadata, tx.environment);
  let inquiryStatus: number;
  let inquiryBody: unknown;
  try {
    const res = await payokPayinInquiry(tx.id, payokEnvironment);
    inquiryStatus = res.status;
    inquiryBody = res.body;
  } catch {
    return { outcome: "error", detail: "payok_inquiry_failed" };
  }

  if (inquiryStatus !== 200) {
    return { outcome: "error", detail: `payok_inquiry_http_${inquiryStatus}` };
  }

  const payload = (inquiryBody ?? {}) as Record<string, unknown>;
  const code = typeof payload.code === "string" ? payload.code : undefined;
  const payokStatus = typeof payload.status === "string" ? payload.status : undefined;

  if (!isTerminalPayokOutcome(code, payokStatus)) {
    return {
      outcome: "not_terminal",
      transactionId: tx.id,
      payokCode: code ?? null,
      payokStatus: payokStatus ?? null,
      detail: "payok_still_pending_or_unknown",
    };
  }

  const callbackCode = code === "SUCCESS" && payokStatus === "SUCCESS" ? "SUCCESS" : "FAIL";
  const callbackStatus = callbackCode;

  const merchantWebhook = await handlePayinCallback({
    code: callbackCode,
    status: callbackStatus,
    merchantOrderId: tx.id,
    platformOrderId:
      (typeof payload.platformOrderId === "string" ? payload.platformOrderId : undefined) ??
      tx.externalId ??
      undefined,
    amount: String(payload.amount ?? tx.amount),
    paidAmount: String(payload.paidAmount ?? payload.amount ?? tx.amount),
    paymentMethodCode:
      typeof payload.paymentMethodCode === "string" ? payload.paymentMethodCode : undefined,
  });

  return {
    outcome: "finalized",
    transactionId: tx.id,
    merchantWebhook,
    payokCode: code ?? null,
    payokStatus: payokStatus ?? null,
  };
}

export type RepairMisCreditedPayinResult =
  | { outcome: "error"; detail: string }
  | { outcome: "skipped"; transactionId: string; reason: "not_success" | "already_correct" | "no_ledger" }
  | {
      outcome: "repaired";
      transactionId: string;
      amount: string;
      fromWalletId: string;
      fromCurrency: string;
      toWalletId: string;
      toCurrency: string;
    };

/**
 * Move a successful pay-in ledger credit from the wrong currency wallet to tx.currency.
 * Used when an older callback credited the first merchant wallet instead of the settlement currency.
 */
export async function repairMisCreditedPayinWallet(
  transactionId: string
): Promise<RepairMisCreditedPayinResult> {
  const [tx] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, transactionId))
    .limit(1);

  if (!tx) {
    return { outcome: "error", detail: "transaction_not_found" };
  }
  if (tx.type !== "payin" || tx.status !== "success") {
    return { outcome: "skipped", transactionId: tx.id, reason: "not_success" };
  }

  const settlementCurrency = tx.currency.trim().toUpperCase() || "BDT";

  const [ledger] = await db
    .select()
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.referenceId, tx.id), eq(ledgerEntries.type, "payin")))
    .limit(1);

  if (!ledger || ledger.direction !== "credit") {
    return { outcome: "skipped", transactionId: tx.id, reason: "no_ledger" };
  }

  const result = await db.transaction(async (txDb) => {
    const [creditedWallet] = await txDb
      .select()
      .from(wallets)
      .where(eq(wallets.id, ledger.walletId))
      .for("update")
      .limit(1);

    if (!creditedWallet) {
      return { kind: "error" as const, detail: "credited_wallet_not_found" };
    }
    if (creditedWallet.currency === settlementCurrency) {
      return { kind: "skipped" as const, reason: "already_correct" as const };
    }

    let [targetWallet] = await txDb
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

    if (!targetWallet) {
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
        return { kind: "error" as const, detail: "target_wallet_create_failed" };
      }
      targetWallet = created;
    }

    const amount = ledger.amount;

    await txDb.insert(ledgerEntries).values({
      walletId: creditedWallet.id,
      environment: tx.environment,
      amount,
      direction: "debit",
      type: "payin_correction",
      referenceId: tx.id,
    });

    await txDb
      .update(wallets)
      .set({
        balance: subAmount(creditedWallet.balance, amount),
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, creditedWallet.id));

    await txDb.insert(ledgerEntries).values({
      walletId: targetWallet.id,
      environment: tx.environment,
      amount,
      direction: "credit",
      type: "payin",
      referenceId: tx.id,
    });

    await txDb
      .update(wallets)
      .set({
        balance: addAmount(targetWallet.balance, amount),
        updatedAt: new Date(),
      })
      .where(eq(wallets.id, targetWallet.id));

    return {
      kind: "repaired" as const,
      amount,
      fromWalletId: creditedWallet.id,
      fromCurrency: creditedWallet.currency,
      toWalletId: targetWallet.id,
      toCurrency: targetWallet.currency,
    };
  });

  if (result.kind === "error") {
    return { outcome: "error", detail: result.detail };
  }
  if (result.kind === "skipped") {
    return { outcome: "skipped", transactionId: tx.id, reason: result.reason };
  }

  audit({
    action: "provider.payok.payin.reconcile",
    actor: "repair:mis_credited_wallet",
    resource: tx.id,
    merchantId: tx.merchantId,
    meta: {
      repair: "mis_credited_wallet",
      amount: result.amount,
      fromWalletId: result.fromWalletId,
      fromCurrency: result.fromCurrency,
      toWalletId: result.toWalletId,
      toCurrency: result.toCurrency,
    },
  });

  return {
    outcome: "repaired",
    transactionId: tx.id,
    amount: result.amount,
    fromWalletId: result.fromWalletId,
    fromCurrency: result.fromCurrency,
    toWalletId: result.toWalletId,
    toCurrency: result.toCurrency,
  };
}
