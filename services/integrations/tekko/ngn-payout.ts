/**
 * Tekko NGN bank payout: debit Transacty merchant NGN pocket, then
 * `POST /customers/:id/ng/withdraw` (customer ledger where VA credits land).
 * Do not use master-wallet withdraw for merchant product payouts (partner KYB gate).
 */
import { and, eq, desc } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions, wallets, ledgerEntries } from "../../../src/db/schema/index.js";
import { audit } from "../../../src/lib/audit.js";
import { addAmount, assertPositive, cmpAmount, subAmount } from "../../../src/lib/money.js";
import { UpstreamProviderClientError } from "../../../src/lib/merchant-facing-errors.js";
import {
  previewTransactionFee,
  payoutTotalWalletDebit,
  ensurePayoutFeeCollected,
} from "../../../src/lib/billing/index.js";
import {
  buildTransactionFeeBreakdown,
  feeBreakdownToWebhookFields,
} from "../../../src/lib/billing/transaction-fee-breakdown.js";
import type { WebhookEvent } from "../../../src/lib/merchant-webhook.js";
import {
  getMerchantProviderExternalId,
  TEKKO_PROVIDER,
} from "../../../src/lib/merchant-provider-links.js";
import {
  NGN_SETTLEMENT_CURRENCY,
  NGN_SETTLEMENT_DISPLAY_NAME,
} from "../../../src/lib/ngn-settlement.js";
import { PayoutCreationError } from "../../domestic/bangladesh/payout.js";
import { getTekkoLiveConfig } from "./config.js";
import { tekkoGet, tekkoPost, tekkoPlatformRequest } from "./client.js";
import { assertTekkoNgnLiveEnvironment, type TekkoMerchantEnvironment } from "./ngn-collect.js";
import {
  assertMerchantTekkoBvnVerifiedForPayout,
  markMerchantTekkoBvnPayoutBlocked,
  tekkoDetailIndicatesBvnRequired,
  tekkoDetailIndicatesPartnerKybBvnRequired,
} from "./ngn-va.js";

export const TEKKO_NGN_PAYOUT_PROVIDER = "tekko-ngn-payout";

export type NgnPayoutBeneficiary = {
  accountNumber: string;
  bankCode: string;
  accountName: string;
  bankName?: string;
};

type WithdrawShape = {
  reference?: string;
  status?: string;
  amount?: string | number;
  currency?: string;
};

type BankRow = {
  code?: string;
  name?: string;
  bankCode?: string;
  bankName?: string;
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

function pickTekkoCode(json: unknown): string | null {
  const root = asRecord(json);
  if (!root) return null;
  const data = asRecord(root.data);
  for (const obj of [root, data]) {
    if (!obj) continue;
    const code = obj.code ?? obj.errorCode ?? obj.error_code;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  return null;
}

/** Parse Tekko NGN withdraw create/status JSON (exports for unit tests). */
export function extractTekkoNgnWithdraw(json: unknown): WithdrawShape | null {
  const root = asRecord(json);
  if (!root) return null;

  const candidates: Array<Record<string, unknown> | null> = [
    asRecord(root.data),
    asRecord(asRecord(root.data)?.withdrawal),
    asRecord(asRecord(root.data)?.payout),
    asRecord(asRecord(root.data)?.result),
    asRecord(root.withdrawal),
    asRecord(root.payout),
    root,
  ];

  for (const data of candidates) {
    if (!data) continue;
    const reference = strField(
      data,
      "reference",
      "withdrawalReference",
      "withdrawal_reference",
      "payoutReference",
      "payout_reference",
      "transactionReference",
      "transaction_reference",
      "externalId",
      "external_id",
      "id"
    );
    const status = strField(data, "status", "withdrawalStatus", "withdrawal_status", "state");
    if (reference || status) {
      return {
        reference: reference ?? undefined,
        status: status ?? undefined,
        amount: (data.amount as string | number | undefined) ?? undefined,
        currency: typeof data.currency === "string" ? data.currency : undefined,
      };
    }
  }
  return null;
}

function extractWithdraw(json: unknown): WithdrawShape | null {
  return extractTekkoNgnWithdraw(json);
}

/** True when Tekko accepted a withdraw create (2xx) even if body shape is sparse. */
export function tekkoWithdrawCreateAccepted(httpStatus: number, json: unknown, reference: string | null): boolean {
  if (httpStatus < 200 || httpStatus >= 300) return false;
  if (reference) return true;
  const msg = pickTekkoMessage(json, "").toLowerCase();
  return (
    msg.includes("initiated") ||
    msg.includes("accepted") ||
    msg.includes("processing") ||
    msg.includes("queued") ||
    msg.includes("pending") ||
    msg.includes("success")
  );
}

/** Platform path for customer NGN bank withdraw (not master-wallet). */
export function tekkoCustomerNgnWithdrawPath(tekkoCustomerId: number): string {
  return `/customers/${tekkoCustomerId}/ng/withdraw`;
}

/** Status / detail poll paths for a customer NGN withdrawal reference. */
export function tekkoCustomerNgnWithdrawPollPaths(
  tekkoCustomerId: number,
  reference: string
): string[] {
  const ref = encodeURIComponent(reference);
  const base = `/customers/${tekkoCustomerId}`;
  return [`${base}/ng/withdraw/${ref}/status`, `${base}/ng/withdrawals/${ref}`];
}

export function tekkoDetailIndicatesVaRequired(detail: string, code?: string | null): boolean {
  const c = (code ?? "").trim().toUpperCase();
  if (
    c === "END_USER_BRAILS_VA_REQUIRED" ||
    c === "NGN_VA_REQUIRED" ||
    c === "VIRTUAL_ACCOUNT_REQUIRED"
  ) {
    return true;
  }
  const d = detail.toLowerCase();
  return (
    (d.includes("virtual account") || d.includes("brails")) &&
    (d.includes("required") || d.includes("onboard"))
  );
}

export function tekkoDetailIndicatesInsufficientCustomerNgn(
  detail: string,
  code?: string | null
): boolean {
  const c = (code ?? "").trim().toUpperCase();
  if (c === "INSUFFICIENT_NGN_BALANCE" || c === "INSUFFICIENT_BALANCE") return true;
  const d = detail.toLowerCase();
  return d.includes("insufficient") && (d.includes("ngn") || d.includes("balance") || d.includes("customer"));
}

export function tekkoNgnWithdrawErrorKind(
  detail: string,
  code?: string | null
): "partner_kyb" | "customer_bvn" | "va_required" | "insufficient" | "other" {
  const c = (code ?? "").trim().toUpperCase();
  if (c === "MERCHANT_BVN_REQUIRED" || tekkoDetailIndicatesPartnerKybBvnRequired(detail)) {
    return "partner_kyb";
  }
  if (tekkoDetailIndicatesVaRequired(detail, code)) return "va_required";
  if (tekkoDetailIndicatesInsufficientCustomerNgn(detail, code)) return "insufficient";
  if (c === "BVN_VERIFICATION_REQUIRED" || tekkoDetailIndicatesBvnRequired(detail)) {
    return "customer_bvn";
  }
  return "other";
}

async function resolveTekkoCustomerIdForPayout(merchantId: string): Promise<number> {
  const existing = await getMerchantProviderExternalId(merchantId, TEKKO_PROVIDER);
  const n = existing ? Number(existing) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw new PayoutCreationError(
      "NGN virtual account required before payouts",
      "",
      null,
      "ngn_va_required"
    );
  }
  return n;
}

export function isNgnWithdrawalSuccess(status: string | null | undefined): boolean {
  const s = (status ?? "").trim().toLowerCase();
  return s === "completed" || s === "success" || s === "successful" || s === "paid";
}

export function isNgnWithdrawalFailure(status: string | null | undefined): boolean {
  const s = (status ?? "").trim().toLowerCase();
  return s === "failed" || s === "reversed" || s === "declined" || s === "cancelled";
}

function findWithdrawInList(json: unknown, reference: string): WithdrawShape | null {
  const root = asRecord(json);
  const data = root?.data;
  const rows: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray(root?.items)
      ? (root.items as unknown[])
      : Array.isArray(root?.withdrawals)
        ? (root.withdrawals as unknown[])
        : Array.isArray(asRecord(data)?.items)
          ? ((asRecord(data)?.items as unknown[]) ?? [])
          : Array.isArray(asRecord(data)?.withdrawals)
            ? ((asRecord(data)?.withdrawals as unknown[]) ?? [])
            : [];
  const want = reference.trim();
  for (const row of rows) {
    const rec = asRecord(row);
    if (!rec) continue;
    const ref = strField(rec, "reference", "withdrawalReference", "id");
    if (want && ref === want) {
      return {
        reference: ref ?? undefined,
        status: strField(rec, "status", "withdrawalStatus") ?? undefined,
        amount: rec.amount as string | number | undefined,
        currency: typeof rec.currency === "string" ? rec.currency : undefined,
      };
    }
  }
  return null;
}

function extractNewestWithdrawFromList(json: unknown): WithdrawShape | null {
  const root = asRecord(json);
  const data = root?.data;
  const rows: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray(root?.items)
      ? (root.items as unknown[])
      : Array.isArray(root?.withdrawals)
        ? (root.withdrawals as unknown[])
        : Array.isArray(asRecord(data)?.items)
          ? ((asRecord(data)?.items as unknown[]) ?? [])
          : Array.isArray(asRecord(data)?.withdrawals)
            ? ((asRecord(data)?.withdrawals as unknown[]) ?? [])
            : [];
  let best: WithdrawShape | null = null;
  let bestTs = 0;
  for (const row of rows) {
    const rec = asRecord(row);
    if (!rec) continue;
    const ref = strField(rec, "reference", "withdrawalReference", "id");
    if (!ref) continue;
    const created =
      strField(rec, "createdAt", "created_at", "updatedAt", "updated_at") ?? "";
    const ts = Date.parse(created) || 0;
    if (!best || ts >= bestTs) {
      bestTs = ts;
      best = {
        reference: ref,
        status: strField(rec, "status", "withdrawalStatus") ?? undefined,
        amount: rec.amount as string | number | undefined,
        currency: typeof rec.currency === "string" ? rec.currency : undefined,
      };
    }
  }
  return best;
}

async function refundPendingNgnPayout(params: {
  txId: string;
  merchantId: string;
  environment: TekkoMerchantEnvironment;
  amount: string;
  failedStage: string;
  failureReason: string;
  externalId?: string | null;
}): Promise<void> {
  await db.transaction(async (txDb) => {
    const [pending] = await txDb
      .select({ metadata: transactions.metadata })
      .from(transactions)
      .where(and(eq(transactions.id, params.txId), eq(transactions.status, "pending")))
      .limit(1);
    if (!pending) return;

    const [updated] = await txDb
      .update(transactions)
      .set({
        status: "failed",
        externalId: params.externalId ?? undefined,
        metadata: mergeMeta(pending.metadata, {
          withdrawalStatus: "failed",
          failedStage: params.failedStage,
          failureReason: params.failureReason,
        }),
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.id, params.txId), eq(transactions.status, "pending")))
      .returning({ id: transactions.id });
    if (!updated) return;

    const [wallet] = await txDb
      .select()
      .from(wallets)
      .where(
        and(
          eq(wallets.merchantId, params.merchantId),
          eq(wallets.environment, params.environment),
          eq(wallets.type, "merchant"),
          eq(wallets.currency, NGN_SETTLEMENT_CURRENCY)
        )
      )
      .for("update")
      .limit(1);
    if (!wallet) return;

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

  audit({
    action: "payout.failed",
    resource: params.txId,
    merchantId: params.merchantId,
    meta: {
      provider: TEKKO_NGN_PAYOUT_PROVIDER,
      failedStage: params.failedStage,
      failureReason: params.failureReason,
    },
  });
}

export async function listTekkoNgnBanks(params?: { search?: string }): Promise<
  Array<{ bankCode: string; bankName: string }>
> {
  if (!getTekkoLiveConfig()) {
    throw new UpstreamProviderClientError(
      "Tekko credentials not configured",
      "Payment rail temporarily unavailable",
      503
    );
  }
  const qs = params?.search?.trim()
    ? `?search=${encodeURIComponent(params.search.trim())}`
    : "";
  const res = await tekkoGet(`/banks${qs}`, { label: "tekko ngn list banks" });
  if (res.status >= 400) {
    const detail = pickTekkoMessage(res.json, `Tekko banks list failed (${res.status})`);
    throw new UpstreamProviderClientError(
      detail,
      "Bank list temporarily unavailable",
      res.status >= 500 ? 503 : res.status
    );
  }
  const root = asRecord(res.json);
  const data = root?.data ?? root;
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(asRecord(data)?.banks)
      ? (asRecord(data)!.banks as unknown[])
      : Array.isArray(asRecord(data)?.items)
        ? (asRecord(data)!.items as unknown[])
        : [];
  const out: Array<{ bankCode: string; bankName: string }> = [];
  for (const row of rows) {
    const r = asRecord(row) as BankRow | null;
    if (!r) continue;
    const bankCode = (r.code ?? r.bankCode ?? "").trim();
    const bankName = (r.name ?? r.bankName ?? "").trim();
    if (bankCode && bankName) out.push({ bankCode, bankName });
  }
  return out;
}

export async function verifyTekkoNgnBankAccount(params: {
  accountNumber: string;
  bankCode: string;
}): Promise<{ accountNumber: string; bankCode: string; accountName: string }> {
  if (!getTekkoLiveConfig()) {
    throw new UpstreamProviderClientError(
      "Tekko credentials not configured",
      "Payment rail temporarily unavailable",
      503
    );
  }
  const accountNumber = params.accountNumber.trim();
  const bankCode = params.bankCode.trim();
  if (!accountNumber || !bankCode) {
    throw new UpstreamProviderClientError(
      "accountNumber and bankCode required",
      "accountNumber and bankCode are required",
      400
    );
  }
  const res = await tekkoPlatformRequest({
    method: "POST",
    path: "/master-wallet/ng/verify-account",
    body: { accountNumber, bankCode },
    label: "tekko ngn verify account",
  });
  const root = asRecord(res.json);
  const data = asRecord(root?.data) ?? root;
  const accountName = strField(data, "accountName", "account_name");
  if (res.status >= 400 || !accountName) {
    const detail = pickTekkoMessage(res.json, `Account verification failed (${res.status})`);
    throw new UpstreamProviderClientError(
      detail,
      "Could not verify this bank account. Check account number and bank code.",
      res.status >= 500 ? 503 : res.status
    );
  }
  return {
    accountNumber: strField(data, "accountNumber", "account_number") ?? accountNumber,
    bankCode: strField(data, "bankCode", "bank_code") ?? bankCode,
    accountName,
  };
}

export async function createTekkoNgnPayout(params: {
  merchantId: string;
  environment: TekkoMerchantEnvironment;
  amount: string;
  beneficiary: NgnPayoutBeneficiary;
  description?: string;
  merchantReference?: string;
  portalActor?: { merchantUserId: string; email: string };
}): Promise<{
  transactionId: string;
  reference: string;
  status: string;
  amount: string;
  currency: typeof NGN_SETTLEMENT_CURRENCY;
}> {
  assertTekkoNgnLiveEnvironment(params.environment);
  assertPositive(params.amount);

  const beneficiary = {
    accountNumber: params.beneficiary.accountNumber.trim(),
    bankCode: params.beneficiary.bankCode.trim(),
    accountName: params.beneficiary.accountName.trim(),
    bankName: params.beneficiary.bankName?.trim() || undefined,
  };
  if (!beneficiary.accountNumber || !beneficiary.bankCode || !beneficiary.accountName) {
    throw new UpstreamProviderClientError(
      "Invalid beneficiary",
      "accountNumber, bankCode, and accountName are required",
      400
    );
  }

  await assertMerchantTekkoBvnVerifiedForPayout(params.merchantId);
  const tekkoCustomerId = await resolveTekkoCustomerIdForPayout(params.merchantId);

  const payoutFeePreview = await previewTransactionFee({
    merchantId: params.merchantId,
    environment: params.environment,
    currency: NGN_SETTLEMENT_CURRENCY,
    provider: TEKKO_NGN_PAYOUT_PROVIDER,
    amount: params.amount,
    feeType: "payout",
  });
  const totalWalletDebit = payoutTotalWalletDebit(params.amount, payoutFeePreview);

  const created = await db.transaction(async (txDb) => {
    const [wallet] = await txDb
      .select()
      .from(wallets)
      .where(
        and(
          eq(wallets.merchantId, params.merchantId),
          eq(wallets.environment, params.environment),
          eq(wallets.type, "merchant"),
          eq(wallets.currency, NGN_SETTLEMENT_CURRENCY),
          eq(wallets.status, "active")
        )
      )
      .for("update")
      .limit(1);

    if (!wallet) {
      throw new PayoutCreationError("Merchant NGN wallet not found", "", null, "wallet_not_found");
    }
    if (cmpAmount(wallet.balance, totalWalletDebit) < 0) {
      throw new PayoutCreationError("Insufficient balance", "", null, "insufficient_balance");
    }

    const [tx] = await txDb
      .insert(transactions)
      .values({
        merchantId: params.merchantId,
        environment: params.environment,
        type: "payout",
        status: "pending",
        amount: params.amount,
        currency: NGN_SETTLEMENT_CURRENCY,
        provider: TEKKO_NGN_PAYOUT_PROVIDER,
        metadata: JSON.stringify({
          rail: "tekko",
          tekkoProduct: "ngn_payout",
          tekkoWithdrawMode: "customer",
          tekkoCustomerId,
          environment: params.environment,
          beneficiary,
          merchantReference: params.merchantReference ?? null,
          description: params.description ?? null,
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
  const idempotencyKey = `tekko-ngn-payout-${tx.id}`.slice(0, 255);
  const description =
    (params.description?.trim() || params.merchantReference?.trim() || `Transacty payout ${tx.id}`).slice(
      0,
      255
    );

  let withdrawRes: { status: number; json: unknown };
  try {
    withdrawRes = await tekkoPost(
      tekkoCustomerNgnWithdrawPath(tekkoCustomerId),
      {
        amount: params.amount,
        accountNumber: beneficiary.accountNumber,
        bankCode: beneficiary.bankCode,
        accountName: beneficiary.accountName,
        ...(beneficiary.bankName ? { bankName: beneficiary.bankName } : {}),
        description,
      },
      idempotencyKey,
      { label: "tekko ngn customer withdraw" }
    );
  } catch (err) {
    await refundPendingNgnPayout({
      txId: tx.id,
      merchantId: params.merchantId,
      environment: params.environment,
      amount: params.amount,
      failedStage: "create_withdraw",
      failureReason: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const withdraw = extractWithdraw(withdrawRes.json);
  let reference = withdraw?.reference?.trim() || null;
  const accepted = tekkoWithdrawCreateAccepted(withdrawRes.status, withdrawRes.json, reference);

  // Never treat a 2xx "initiated" response as failure — money may already have left Tekko.
  if (!accepted) {
    const detail = pickTekkoMessage(withdrawRes.json, `Tekko NGN withdraw failed (${withdrawRes.status})`);
    const tekkoCode = pickTekkoCode(withdrawRes.json);
    await refundPendingNgnPayout({
      txId: tx.id,
      merchantId: params.merchantId,
      environment: params.environment,
      amount: params.amount,
      failedStage: "create_withdraw",
      failureReason: detail,
    });
    if (withdrawRes.status >= 400 && withdrawRes.status < 500) {
      const kind = tekkoNgnWithdrawErrorKind(detail, tekkoCode);
      if (kind === "partner_kyb") {
        throw new PayoutCreationError(
          "NGN payout is temporarily unavailable. Contact support.",
          tx.id,
          reference,
          "ngn_payout_provider_kyb",
          detail
        );
      }
      if (kind === "va_required") {
        throw new PayoutCreationError(
          "NGN virtual account required before payouts",
          tx.id,
          reference,
          "ngn_va_required",
          detail
        );
      }
      if (kind === "insufficient") {
        throw new PayoutCreationError(
          "Insufficient NGN balance for payout",
          tx.id,
          reference,
          "insufficient_balance",
          detail
        );
      }
      if (kind === "customer_bvn") {
        await markMerchantTekkoBvnPayoutBlocked(params.merchantId, detail);
        throw new PayoutCreationError(
          "BVN verification required before NGN payouts",
          tx.id,
          reference,
          "ngn_bvn_required",
          detail
        );
      }
      throw new PayoutCreationError(
        "NGN payout could not be started. Check beneficiary details and balance.",
        tx.id,
        reference,
        undefined,
        detail
      );
    }
    throw new PayoutCreationError(
      "NGN payout could not be started. Try again later or contact support.",
      tx.id,
      reference,
      undefined,
      detail
    );
  }

  // Recover reference from list if create body was sparse (message-only success).
  if (!reference) {
    try {
      const listed = await tekkoGet(`/customers/${tekkoCustomerId}/ng/withdrawals`, {
        label: "tekko ngn customer withdraw list after create",
      });
      const fromList = extractNewestWithdrawFromList(listed.json);
      if (fromList?.reference?.trim()) reference = fromList.reference.trim();
    } catch {
      // Keep pending without external id; webhook may still attach via metadata match later.
    }
  }
  if (!reference) {
    // Stable interim key so webhooks/reconcile can still find this row via metadata.
    reference = idempotencyKey;
  }

  const withdrawalStatus = withdraw?.status ?? "processing";
  await db
    .update(transactions)
    .set({
      externalId: reference,
      metadata: mergeMeta(tx.metadata, {
        withdrawalReference: reference,
        withdrawalStatus,
        tekkoCustomerId,
        tekkoWithdrawMode: "customer",
        createHttpStatus: withdrawRes.status,
        createMessage: pickTekkoMessage(withdrawRes.json, ""),
      }),
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, tx.id));

  audit({
    action: "payout.created",
    resource: tx.id,
    merchantId: params.merchantId,
    merchantUserId: params.portalActor?.merchantUserId,
    actorEmail: params.portalActor?.email,
    meta: {
      provider: TEKKO_NGN_PAYOUT_PROVIDER,
      reference,
      amount: params.amount,
      tekkoCustomerId,
      tekkoWithdrawMode: "customer",
      source: params.portalActor ? "portal" : "api",
    },
  });

  return {
    transactionId: tx.id,
    reference,
    status: withdrawalStatus,
    amount: params.amount,
    currency: NGN_SETTLEMENT_CURRENCY,
  };
}

export async function getTekkoNgnPayoutStatus(params: {
  merchantId: string;
  transactionId: string;
}): Promise<{
  transactionId: string;
  reference: string | null;
  status: string;
  withdrawalStatus: string | null;
  amount: string;
  currency: string;
  settlementCurrency: typeof NGN_SETTLEMENT_CURRENCY;
  settlementCurrencyLabel: typeof NGN_SETTLEMENT_DISPLAY_NAME;
  beneficiary: NgnPayoutBeneficiary | null;
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
        eq(transactions.provider, TEKKO_NGN_PAYOUT_PROVIDER)
      )
    )
    .limit(1);
  if (!tx) return null;

  const meta = parseMeta(tx.metadata);
  const reference =
    (typeof meta.withdrawalReference === "string" ? meta.withdrawalReference : null) ??
    tx.externalId;
  let withdrawalStatus =
    typeof meta.withdrawalStatus === "string" ? meta.withdrawalStatus : null;
  const beneficiary =
    meta.beneficiary && typeof meta.beneficiary === "object"
      ? (meta.beneficiary as NgnPayoutBeneficiary)
      : null;

  if (tx.environment === "live" && tx.status === "pending" && reference) {
    let tekkoCustomerId =
      typeof meta.tekkoCustomerId === "number"
        ? meta.tekkoCustomerId
        : typeof meta.tekkoCustomerId === "string" && /^\d+$/.test(meta.tekkoCustomerId)
          ? Number(meta.tekkoCustomerId)
          : null;
    if (tekkoCustomerId == null || !Number.isFinite(tekkoCustomerId)) {
      try {
        tekkoCustomerId = await resolveTekkoCustomerIdForPayout(params.merchantId);
      } catch {
        tekkoCustomerId = null;
      }
    }

    const pollPaths =
      tekkoCustomerId != null && Number.isFinite(tekkoCustomerId)
        ? [
            ...tekkoCustomerNgnWithdrawPollPaths(tekkoCustomerId, reference),
            `/customers/${tekkoCustomerId}/ng/withdrawals`,
          ]
        : [];

    for (const path of pollPaths) {
      try {
        const res = await tekkoGet(path, { label: "tekko ngn customer withdraw status" });
        let withdraw = extractWithdraw(res.json);
        if (!withdraw?.status && path.endsWith("/ng/withdrawals")) {
          withdraw = findWithdrawInList(res.json, reference);
        }
        if (withdraw?.status) {
          withdrawalStatus = withdraw.status;
          await db
            .update(transactions)
            .set({
              metadata: mergeMeta(tx.metadata, {
                withdrawalStatus,
                lastPolledAt: new Date().toISOString(),
                ...(tekkoCustomerId != null ? { tekkoCustomerId, tekkoWithdrawMode: "customer" } : {}),
              }),
              updatedAt: new Date(),
            })
            .where(eq(transactions.id, tx.id));

          if (isNgnWithdrawalSuccess(withdrawalStatus)) {
            await finalizeTekkoNgnPayoutSuccess({
              transactionId: tx.id,
              withdrawalStatus,
              source: "poll",
            });
          } else if (isNgnWithdrawalFailure(withdrawalStatus)) {
            await finalizeTekkoNgnPayoutFailure({
              transactionId: tx.id,
              withdrawalStatus,
              source: "poll",
            });
          }
          break;
        }
      } catch {
        // Best-effort poll; try alternate path or return DB snapshot.
      }
    }
  }

  const [latest] = await db.select().from(transactions).where(eq(transactions.id, tx.id)).limit(1);
  const row = latest ?? tx;
  const latestMeta = parseMeta(row.metadata);
  return {
    transactionId: row.id,
    reference,
    status: row.status,
    withdrawalStatus:
      typeof latestMeta.withdrawalStatus === "string" ? latestMeta.withdrawalStatus : withdrawalStatus,
    amount: String(row.amount),
    currency: row.currency,
    settlementCurrency: NGN_SETTLEMENT_CURRENCY,
    settlementCurrencyLabel: NGN_SETTLEMENT_DISPLAY_NAME,
    beneficiary,
    environment: row.environment,
    settled: row.status === "success",
  };
}

export async function finalizeTekkoNgnPayoutSuccess(params: {
  transactionId: string;
  withdrawalStatus: string;
  source: "webhook" | "poll" | "reconcile";
}): Promise<{ merchantId: string; event: WebhookEvent } | null> {
  const [tx] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, params.transactionId))
    .limit(1);
  if (!tx || tx.provider !== TEKKO_NGN_PAYOUT_PROVIDER || tx.status !== "pending") {
    return null;
  }

  const result = await db.transaction(async (txDb) => {
    const [updated] = await txDb
      .update(transactions)
      .set({
        status: "success",
        metadata: mergeMeta(tx.metadata, {
          withdrawalStatus: params.withdrawalStatus,
          settledAt: new Date().toISOString(),
          settledFrom: params.source,
        }),
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.id, tx.id), eq(transactions.status, "pending")))
      .returning();
    if (!updated) return null;

    await ensurePayoutFeeCollected(
      {
        merchantId: tx.merchantId,
        transactionId: tx.id,
        environment: tx.environment as TekkoMerchantEnvironment,
        currency: tx.currency,
        provider: TEKKO_NGN_PAYOUT_PROVIDER,
        amount: String(tx.amount),
        feeType: "payout",
      },
      txDb
    );
    return updated;
  });

  if (!result) return null;

  audit({
    action: "payout.completed",
    resource: tx.id,
    merchantId: tx.merchantId,
    meta: { provider: TEKKO_NGN_PAYOUT_PROVIDER, reference: tx.externalId, source: params.source },
  });

  const breakdown = await buildTransactionFeeBreakdown({
    merchantId: tx.merchantId,
    environment: tx.environment as TekkoMerchantEnvironment,
    transactionId: tx.id,
    type: "payout",
    status: "success",
    amount: String(tx.amount),
    currency: NGN_SETTLEMENT_CURRENCY,
    provider: TEKKO_NGN_PAYOUT_PROVIDER,
  }).catch(() => null);

  return {
    merchantId: tx.merchantId,
    event: {
      type: "payout.completed",
      transactionId: tx.id,
      status: "success",
      amount: String(tx.amount),
      currency: NGN_SETTLEMENT_CURRENCY,
      platformOrderId: tx.externalId ?? null,
      ...feeBreakdownToWebhookFields(breakdown),
    },
  };
}

export async function finalizeTekkoNgnPayoutFailure(params: {
  transactionId: string;
  withdrawalStatus: string;
  source: "webhook" | "poll" | "reconcile";
  failureReason?: string;
}): Promise<{ merchantId: string; event: WebhookEvent } | null> {
  const [tx] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, params.transactionId))
    .limit(1);
  if (!tx || tx.provider !== TEKKO_NGN_PAYOUT_PROVIDER || tx.status !== "pending") {
    return null;
  }

  const result = await db.transaction(async (txDb) => {
    const [updated] = await txDb
      .update(transactions)
      .set({
        status: "failed",
        metadata: mergeMeta(tx.metadata, {
          withdrawalStatus: params.withdrawalStatus,
          failedAt: new Date().toISOString(),
          failedFrom: params.source,
          ...(params.failureReason ? { failureReason: params.failureReason } : {}),
        }),
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.id, tx.id), eq(transactions.status, "pending")))
      .returning();
    if (!updated) return null;

    const [wallet] = await txDb
      .select()
      .from(wallets)
      .where(
        and(
          eq(wallets.merchantId, tx.merchantId),
          eq(wallets.environment, tx.environment),
          eq(wallets.type, "merchant"),
          eq(wallets.currency, NGN_SETTLEMENT_CURRENCY)
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
    return updated;
  });

  if (!result) return null;

  audit({
    action: "payout.failed",
    resource: tx.id,
    merchantId: tx.merchantId,
    meta: { provider: TEKKO_NGN_PAYOUT_PROVIDER, withdrawalStatus: params.withdrawalStatus },
  });

  return {
    merchantId: tx.merchantId,
    event: {
      type: "payout.failed",
      transactionId: tx.id,
      status: "failed",
      amount: String(tx.amount),
      currency: NGN_SETTLEMENT_CURRENCY,
      platformOrderId: tx.externalId ?? null,
    },
  };
}

export async function findTekkoNgnPayoutByReference(
  reference: string
): Promise<(typeof transactions.$inferSelect) | null> {
  const ref = reference.trim();
  if (!ref) return null;
  const [byExternal] = await db
    .select()
    .from(transactions)
    .where(
      and(eq(transactions.externalId, ref), eq(transactions.provider, TEKKO_NGN_PAYOUT_PROVIDER))
    )
    .limit(1);
  if (byExternal) return byExternal;

  // Create response may have stored reference only in metadata (or interim idempotency key).
  const recent = await db
    .select()
    .from(transactions)
    .where(eq(transactions.provider, TEKKO_NGN_PAYOUT_PROVIDER))
    .orderBy(desc(transactions.createdAt))
    .limit(50);
  for (const row of recent) {
    const meta = parseMeta(row.metadata);
    if (typeof meta.withdrawalReference === "string" && meta.withdrawalReference === ref) {
      return row;
    }
    if (row.metadata?.includes(ref)) return row;
  }
  return null;
}

export type TekkoNgnPayoutReconcileResult =
  | {
      outcome: "finalized";
      transactionId: string;
      withdrawalStatus: string | null;
      merchantWebhook: { merchantId: string; event: WebhookEvent } | null;
    }
  | {
      outcome: "not_terminal";
      transactionId: string;
      withdrawalStatus: string | null;
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

export async function reconcileTekkoNgnPayoutByTransactionId(
  transactionId: string
): Promise<TekkoNgnPayoutReconcileResult> {
  const [tx] = await db.select().from(transactions).where(eq(transactions.id, transactionId)).limit(1);
  if (!tx) return { outcome: "error", detail: "transaction_not_found" };
  if (tx.provider !== TEKKO_NGN_PAYOUT_PROVIDER) {
    return { outcome: "skipped", transactionId, reason: "wrong_rail" };
  }
  if (tx.type !== "payout") return { outcome: "error", detail: "not_payout" };
  if (tx.status === "success" || tx.status === "failed") {
    return { outcome: "skipped", transactionId, reason: "already_terminal" };
  }

  const status = await getTekkoNgnPayoutStatus({
    merchantId: tx.merchantId,
    transactionId: tx.id,
  });
  if (!status) return { outcome: "error", detail: "status_unavailable" };

  const [latest] = await db.select().from(transactions).where(eq(transactions.id, tx.id)).limit(1);
  if (!latest) return { outcome: "error", detail: "transaction_not_found" };

  if (latest.status === "success") {
    const breakdown = await buildTransactionFeeBreakdown({
      merchantId: latest.merchantId,
      environment: latest.environment as TekkoMerchantEnvironment,
      transactionId: latest.id,
      type: "payout",
      status: "success",
      amount: String(latest.amount),
      currency: NGN_SETTLEMENT_CURRENCY,
      provider: TEKKO_NGN_PAYOUT_PROVIDER,
    }).catch(() => null);
    return {
      outcome: "finalized",
      transactionId: latest.id,
      withdrawalStatus: status.withdrawalStatus,
      merchantWebhook: {
        merchantId: latest.merchantId,
        event: {
          type: "payout.completed",
          transactionId: latest.id,
          status: "success",
          amount: String(latest.amount),
          currency: NGN_SETTLEMENT_CURRENCY,
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
      withdrawalStatus: status.withdrawalStatus,
      merchantWebhook: {
        merchantId: latest.merchantId,
        event: {
          type: "payout.failed",
          transactionId: latest.id,
          status: "failed",
          amount: String(latest.amount),
          currency: NGN_SETTLEMENT_CURRENCY,
          platformOrderId: latest.externalId ?? null,
        },
      },
    };
  }

  return {
    outcome: "not_terminal",
    transactionId: latest.id,
    withdrawalStatus: status.withdrawalStatus,
    detail: `withdrawal_status=${status.withdrawalStatus ?? "unknown"}`,
  };
}

export async function reconcileTekkoNgnByTransactionId(
  transactionId: string
): Promise<
  | { kind: "collect"; result: import("./ngn-collect.js").TekkoNgnReconcileResult }
  | { kind: "payout"; result: TekkoNgnPayoutReconcileResult }
  | { kind: "error"; detail: string }
> {
  const [tx] = await db.select().from(transactions).where(eq(transactions.id, transactionId)).limit(1);
  if (!tx) return { kind: "error", detail: "transaction_not_found" };
  if (tx.provider === "tekko-ngn-collect") {
    const { reconcileTekkoNgnCollectByTransactionId } = await import("./ngn-collect.js");
    return { kind: "collect", result: await reconcileTekkoNgnCollectByTransactionId(transactionId) };
  }
  if (tx.provider === TEKKO_NGN_PAYOUT_PROVIDER) {
    return { kind: "payout", result: await reconcileTekkoNgnPayoutByTransactionId(transactionId) };
  }
  return { kind: "error", detail: "wrong_rail" };
}
