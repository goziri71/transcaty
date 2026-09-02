/**
 * Tekko NGN permanent customer virtual account (one per Transacty merchant).
 * BVN Basic (no faceImage) → provision VA → credit Transacty NGN on customer.wallet.credited.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { merchants, transactions, ledgerEntries, wallets } from "../../../src/db/schema/index.js";
import { audit } from "../../../src/lib/audit.js";
import { addAmount } from "../../../src/lib/money.js";
import { UpstreamProviderClientError } from "../../../src/lib/merchant-facing-errors.js";
import { tryApplyTransactionFee } from "../../../src/lib/billing/index.js";
import {
  buildTransactionFeeBreakdown,
  feeBreakdownToWebhookFields,
} from "../../../src/lib/billing/transaction-fee-breakdown.js";
import type { WebhookEvent } from "../../../src/lib/merchant-webhook.js";
import {
  NGN_SETTLEMENT_CURRENCY,
  NGN_SETTLEMENT_DISPLAY_NAME,
} from "../../../src/lib/ngn-settlement.js";
import { PLATFORM_MERCHANT_ID } from "../../../src/lib/billing/platform-wallet.js";
import { LIMITS } from "../../../src/lib/limits.js";
import { getOrCreateMerchantWallet } from "../tylt/crossramp-payin.js";
import { ensureTekkoCustomerForMerchant } from "./customers.js";
import { assertTekkoNgnLiveEnvironment, type TekkoMerchantEnvironment } from "./ngn-collect.js";
import { tekkoGet, tekkoPost } from "./client.js";

export const TEKKO_NGN_VA_PROVIDER = "tekko-ngn-va";
export const TEKKO_NGN_VA_SETTLEMENT_CURRENCY = NGN_SETTLEMENT_CURRENCY;
export const TEKKO_NGN_VA_SETTLEMENT_DISPLAY_NAME = NGN_SETTLEMENT_DISPLAY_NAME;

export type TekkoNgnVaDetails = {
  status: string;
  accountNumber: string | null;
  bankName: string | null;
  accountName: string | null;
  currency: "NGN";
};

export type TekkoNgnBvnInput = {
  bvn: string;
  firstName: string;
  lastName: string;
  phoneNumber?: string;
  dateOfBirth?: string;
  customerEmail?: string;
};

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
    const code = (json as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  return fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeBvnStatus(raw: string | null | undefined): string {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "verified" || s === "pending" || s === "failed" || s === "not_submitted") return s;
  if (!s) return "not_submitted";
  return s;
}

export function extractNgnVaDetails(json: unknown): TekkoNgnVaDetails {
  const root = asRecord(json);
  const data = asRecord(root?.data) ?? root;
  const wallet = asRecord(data?.wallet) ?? asRecord(data?.virtualAccount) ?? data;
  const nestedVa = asRecord(wallet?.virtualAccount) ?? wallet;
  return {
    status: strField(data, "status") ?? strField(nestedVa, "status") ?? "unknown",
    accountNumber: strField(nestedVa, "accountNumber", "account_number"),
    bankName: strField(nestedVa, "bankName", "bank_name"),
    accountName: strField(nestedVa, "accountName", "account_name"),
    currency: "NGN",
  };
}

function extractBvnStatus(json: unknown): string {
  const root = asRecord(json);
  const data = asRecord(root?.data) ?? root;
  return normalizeBvnStatus(strField(data, "status", "bvnStatus", "bvn_status"));
}

async function loadMerchantVaRow(merchantId: string) {
  const [row] = await db
    .select({
      id: merchants.id,
      name: merchants.name,
      tekkoCustomerId: merchants.tekkoCustomerId,
      tekkoBvnStatus: merchants.tekkoBvnStatus,
      tekkoNgnVaStatus: merchants.tekkoNgnVaStatus,
      tekkoNgnVaAccountNumber: merchants.tekkoNgnVaAccountNumber,
      tekkoNgnVaBankName: merchants.tekkoNgnVaBankName,
      tekkoNgnVaAccountName: merchants.tekkoNgnVaAccountName,
    })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);
  return row ?? null;
}

async function persistVaFields(
  merchantId: string,
  patch: {
    tekkoBvnStatus?: string | null;
    tekkoNgnVaStatus?: string | null;
    tekkoNgnVaAccountNumber?: string | null;
    tekkoNgnVaBankName?: string | null;
    tekkoNgnVaAccountName?: string | null;
  }
): Promise<void> {
  await db
    .update(merchants)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(merchants.id, merchantId));
}

async function pollBvnUntilTerminal(customerId: number): Promise<string> {
  const delays = [500, 1000, 1500, 2000, 3000, 4000, 5000];
  let last = "pending";
  for (const delay of delays) {
    await sleep(delay);
    const res = await tekkoGet(`/customers/${customerId}/bvn/status`, {
      label: "tekko ngn bvn status",
    });
    last = extractBvnStatus(res.json);
    if (last === "verified" || last === "failed" || last === "not_submitted") return last;
  }
  return last;
}

/**
 * Submit BVN Basic for the merchant's Tekko customer. Never send faceImage.
 */
export async function submitMerchantNgnBvn(params: {
  merchantId: string;
  environment: TekkoMerchantEnvironment;
  bvn: TekkoNgnBvnInput;
}): Promise<{ bvnStatus: string; tekkoCustomerId: number }> {
  assertTekkoNgnLiveEnvironment(params.environment);

  const bvn = params.bvn.bvn.replace(/\s/g, "");
  if (!/^\d{11}$/.test(bvn)) {
    throw new UpstreamProviderClientError("Invalid BVN", "BVN must be exactly 11 digits", 400);
  }
  const firstName = params.bvn.firstName.trim();
  const lastName = params.bvn.lastName.trim();
  if (!firstName || !lastName) {
    throw new UpstreamProviderClientError(
      "Name required",
      "firstName and lastName are required",
      400
    );
  }

  const customerId = await ensureTekkoCustomerForMerchant({
    merchantId: params.merchantId,
    displayName: `${firstName} ${lastName}`.slice(0, 200),
  });

  const body: Record<string, string> = {
    bvn,
    firstName,
    lastName,
  };
  if (params.bvn.phoneNumber?.trim()) body.phoneNumber = params.bvn.phoneNumber.trim();
  if (params.bvn.dateOfBirth?.trim()) body.dateOfBirth = params.bvn.dateOfBirth.trim();
  if (params.bvn.customerEmail?.trim()) body.customerEmail = params.bvn.customerEmail.trim();

  const idempotencyKey = `tekko-bvn-${params.merchantId}-${bvn.slice(-4)}`.slice(0, 255);
  const res = await tekkoPost(`/customers/${customerId}/bvn/verify`, body, idempotencyKey, {
    label: "tekko ngn bvn verify",
  });

  let status = extractBvnStatus(res.json);
  if (res.status >= 400) {
    const detail = pickTekkoMessage(res.json, `Tekko BVN verify failed (${res.status})`);
    await persistVaFields(params.merchantId, { tekkoBvnStatus: "failed" });
    audit({
      action: "tekko.ngn.bvn.failed",
      merchantId: params.merchantId,
      meta: { status: res.status, code: detail.slice(0, 120) },
    });
    if (res.status >= 400 && res.status < 500) {
      throw new UpstreamProviderClientError(detail, "BVN verification failed. Check details and try again.", res.status);
    }
    throw new Error(detail);
  }

  if (status === "pending") {
    status = await pollBvnUntilTerminal(customerId);
  }

  await persistVaFields(params.merchantId, { tekkoBvnStatus: status });
  audit({
    action: status === "verified" ? "tekko.ngn.bvn.verified" : "tekko.ngn.bvn.status",
    merchantId: params.merchantId,
    meta: { bvnStatus: status },
  });

  if (status !== "verified") {
    throw new UpstreamProviderClientError(
      `BVN status=${status}`,
      status === "pending"
        ? "BVN verification is still pending. Try again shortly."
        : "BVN verification failed. Check details and try again.",
      400
    );
  }

  return { bvnStatus: status, tekkoCustomerId: customerId };
}

async function fetchTekkoCustomerVa(customerId: number): Promise<TekkoNgnVaDetails | null> {
  const res = await tekkoGet(`/customers/${customerId}/ng/virtual-account`, {
    label: "tekko ngn va get",
  });
  if (res.status === 404) return null;
  if (res.status >= 400) {
    const detail = pickTekkoMessage(res.json, `Tekko NGN VA get failed (${res.status})`);
    throw new Error(detail);
  }
  const details = extractNgnVaDetails(res.json);
  if (!details.accountNumber) return null;
  return details;
}

async function onboardTekkoCustomerVa(params: {
  merchantId: string;
  customerId: number;
  customerEmail?: string;
}): Promise<TekkoNgnVaDetails> {
  const body: Record<string, string> = {};
  if (params.customerEmail?.trim()) body.customerEmail = params.customerEmail.trim();

  const idempotencyKey = `tekko-ngn-va-${params.merchantId}`.slice(0, 255);
  const res = await tekkoPost(
    `/customers/${params.customerId}/ng/virtual-account/onboard`,
    body,
    idempotencyKey,
    { label: "tekko ngn va onboard" }
  );

  if (res.status >= 400) {
    // Prefer unified wallets path if onboard rejects with BVN required already handled.
    const walletsRes = await tekkoPost(
      `/customers/${params.customerId}/wallets`,
      { currency: "NGN", ...(params.customerEmail?.trim() ? { customerEmail: params.customerEmail.trim() } : {}) },
      `tekko-ngn-wallet-${params.merchantId}`.slice(0, 255),
      { label: "tekko ngn wallet provision" }
    );
    if (walletsRes.status >= 400) {
      const detail = pickTekkoMessage(
        walletsRes.json,
        pickTekkoMessage(res.json, `Tekko NGN VA onboard failed (${res.status})`)
      );
      if (res.status >= 400 && res.status < 500) {
        throw new UpstreamProviderClientError(
          detail,
          "NGN virtual account could not be provisioned. Complete BVN verification first.",
          res.status
        );
      }
      throw new Error(detail);
    }
    const fromWallets = extractNgnVaDetails(walletsRes.json);
    if (fromWallets.accountNumber) return fromWallets;
    const again = await fetchTekkoCustomerVa(params.customerId);
    if (again?.accountNumber) return again;
    throw new UpstreamProviderClientError(
      "VA provisioned without account number",
      "NGN virtual account is not ready yet. Try again shortly.",
      503
    );
  }

  const details = extractNgnVaDetails(res.json);
  if (details.accountNumber) return details;
  const again = await fetchTekkoCustomerVa(params.customerId);
  if (again?.accountNumber) return again;
  throw new UpstreamProviderClientError(
    "VA onboard missing account number",
    "NGN virtual account is not ready yet. Try again shortly.",
    503
  );
}

function vaViewFromRow(row: NonNullable<Awaited<ReturnType<typeof loadMerchantVaRow>>>): {
  status: string;
  bvnStatus: string;
  accountNumber: string | null;
  bankName: string | null;
  accountName: string | null;
  currency: "NGN";
  ready: boolean;
} {
  const bvnStatus = normalizeBvnStatus(row.tekkoBvnStatus);
  const accountNumber = row.tekkoNgnVaAccountNumber?.trim() || null;
  const ready = Boolean(accountNumber) && (row.tekkoNgnVaStatus ?? "").toLowerCase() !== "pending";
  return {
    status: ready ? row.tekkoNgnVaStatus?.trim() || "active" : accountNumber ? "pending" : bvnStatus === "verified" ? "bvn_verified" : "bvn_required",
    bvnStatus,
    accountNumber,
    bankName: row.tekkoNgnVaBankName?.trim() || null,
    accountName: row.tekkoNgnVaAccountName?.trim() || null,
    currency: "NGN",
    ready,
  };
}

/**
 * GET or provision permanent NGN VA for merchant. Requires verified BVN (pass bvn to submit).
 */
export async function getOrProvisionMerchantNgnVa(params: {
  merchantId: string;
  environment: TekkoMerchantEnvironment;
  bvn?: TekkoNgnBvnInput;
  provision?: boolean;
}): Promise<{
  status: string;
  bvnStatus: string;
  accountNumber: string | null;
  bankName: string | null;
  accountName: string | null;
  currency: "NGN";
  ready: boolean;
  environment: TekkoMerchantEnvironment;
}> {
  assertTekkoNgnLiveEnvironment(params.environment);

  if (params.bvn) {
    await submitMerchantNgnBvn({
      merchantId: params.merchantId,
      environment: params.environment,
      bvn: params.bvn,
    });
  }

  let row = await loadMerchantVaRow(params.merchantId);
  if (!row) throw new Error("Merchant not found");

  // Fast path: already provisioned locally.
  if (row.tekkoNgnVaAccountNumber?.trim()) {
    return { ...vaViewFromRow(row), environment: params.environment };
  }

  const bvnStatus = normalizeBvnStatus(row.tekkoBvnStatus);
  const shouldProvision = params.provision !== false;

  if (bvnStatus !== "verified" && !params.bvn) {
    // Refresh BVN status from Tekko if we have a customer id.
    if (row.tekkoCustomerId?.trim()) {
      const customerId = Number(row.tekkoCustomerId.trim());
      if (Number.isFinite(customerId)) {
        try {
          const st = await tekkoGet(`/customers/${customerId}/bvn/status`, {
            label: "tekko ngn bvn status refresh",
          });
          const remote = extractBvnStatus(st.json);
          if (remote !== bvnStatus) {
            await persistVaFields(params.merchantId, { tekkoBvnStatus: remote });
            row = (await loadMerchantVaRow(params.merchantId)) ?? row;
          }
        } catch {
          // ignore refresh errors
        }
      }
    }
    const refreshed = normalizeBvnStatus(row.tekkoBvnStatus);
    if (refreshed !== "verified") {
      return {
        status: "bvn_required",
        bvnStatus: refreshed,
        accountNumber: null,
        bankName: null,
        accountName: null,
        currency: "NGN",
        ready: false,
        environment: params.environment,
      };
    }
  }

  if (!shouldProvision) {
    return { ...vaViewFromRow(row), environment: params.environment };
  }

  const customerId = await ensureTekkoCustomerForMerchant({
    merchantId: params.merchantId,
    displayName: row.name,
  });

  // Re-check remote VA first (idempotent).
  let details = await fetchTekkoCustomerVa(customerId);
  if (!details?.accountNumber) {
    details = await onboardTekkoCustomerVa({
      merchantId: params.merchantId,
      customerId,
      customerEmail: params.bvn?.customerEmail,
    });
  }

  await persistVaFields(params.merchantId, {
    tekkoBvnStatus: "verified",
    tekkoNgnVaStatus: details.status || "active",
    tekkoNgnVaAccountNumber: details.accountNumber,
    tekkoNgnVaBankName: details.bankName,
    tekkoNgnVaAccountName: details.accountName,
  });

  audit({
    action: "tekko.ngn.va.provisioned",
    merchantId: params.merchantId,
    meta: {
      status: details.status,
      accountMasked: details.accountNumber
        ? `****${details.accountNumber.slice(-4)}`
        : null,
    },
  });

  row = await loadMerchantVaRow(params.merchantId);
  if (!row) throw new Error("Merchant not found after VA provision");
  return { ...vaViewFromRow(row), environment: params.environment };
}

export async function getMerchantNgnVa(params: {
  merchantId: string;
  environment: TekkoMerchantEnvironment;
}): Promise<{
  status: string;
  bvnStatus: string;
  accountNumber: string | null;
  bankName: string | null;
  accountName: string | null;
  currency: "NGN";
  ready: boolean;
  environment: TekkoMerchantEnvironment;
}> {
  // Read local first; if BVN verified but VA missing locally, try provision/fetch without new BVN body.
  const local = await getOrProvisionMerchantNgnVa({
    merchantId: params.merchantId,
    environment: params.environment,
    provision: false,
  });
  if (local.ready || local.bvnStatus !== "verified") return local;
  return getOrProvisionMerchantNgnVa({
    merchantId: params.merchantId,
    environment: params.environment,
    provision: true,
  });
}

async function ensureNgnWallet(params: { merchantId: string; environment: "test" | "live" }) {
  return getOrCreateMerchantWallet({
    merchantId: params.merchantId,
    environment: params.environment,
    currency: TEKKO_NGN_VA_SETTLEMENT_CURRENCY,
  });
}

/**
 * Credit merchant NGN from a permanent VA deposit (customer.wallet.credited).
 * Dedupes on provider + externalId (Tekko reference / event id).
 */
export async function settleTekkoNgnVaCredit(params: {
  merchantId: string;
  environment: TekkoMerchantEnvironment;
  amount: string;
  externalReference: string;
  endUserId?: string | number | null;
  source: "webhook" | "reconcile";
  eventId?: string | null;
}): Promise<{ merchantId: string; event: WebhookEvent; transactionId: string } | null> {
  assertTekkoNgnLiveEnvironment(params.environment);

  const paidAmount = params.amount.trim();
  if (!paidAmount || !Number.isFinite(Number(paidAmount)) || Number(paidAmount) <= 0) {
    throw new Error("Invalid Tekko NGN VA credit amount");
  }

  const bounds = LIMITS.tekkoNgn.payin;
  const amt = Number(paidAmount);
  if (amt < bounds.min || amt > bounds.max) {
    audit({
      action: "tekko.ngn.va.credit_out_of_limits",
      merchantId: params.merchantId,
      meta: { amount: paidAmount, min: bounds.min, max: bounds.max },
    });
    throw new UpstreamProviderClientError(
      "Amount out of limits",
      `Amount must be between ${bounds.min} and ${bounds.max} NGN`,
      400
    );
  }

  const externalId = (params.externalReference || params.eventId || "").trim();
  if (!externalId) {
    throw new Error("Missing Tekko NGN VA credit reference");
  }

  const [existing] = await db
    .select()
    .from(transactions)
    .where(
      and(eq(transactions.provider, TEKKO_NGN_VA_PROVIDER), eq(transactions.externalId, externalId))
    )
    .limit(1);
  if (existing?.status === "success") {
    return null;
  }

  const wallet = await ensureNgnWallet({
    merchantId: params.merchantId,
    environment: params.environment,
  });
  try {
    await getOrCreateMerchantWallet({
      merchantId: PLATFORM_MERCHANT_ID,
      environment: params.environment,
      currency: TEKKO_NGN_VA_SETTLEMENT_CURRENCY,
    });
  } catch {
    // Fee apply skips if platform NGN pocket missing.
  }

  const result = await db.transaction(async (txDb) => {
    // Re-check inside txn for races.
    const [dup] = await txDb
      .select({ id: transactions.id, status: transactions.status })
      .from(transactions)
      .where(
        and(eq(transactions.provider, TEKKO_NGN_VA_PROVIDER), eq(transactions.externalId, externalId))
      )
      .limit(1);
    if (dup?.status === "success") return null;

    let txId = dup?.id;
    if (!txId) {
      const [created] = await txDb
        .insert(transactions)
        .values({
          merchantId: params.merchantId,
          environment: params.environment,
          type: "payin",
          status: "pending",
          amount: paidAmount,
          paidAmount,
          currency: TEKKO_NGN_VA_SETTLEMENT_CURRENCY,
          provider: TEKKO_NGN_VA_PROVIDER,
          externalId,
          metadata: JSON.stringify({
            rail: "tekko",
            tekkoProduct: "ngn_va",
            environment: params.environment,
            endUserId: params.endUserId != null ? String(params.endUserId) : null,
            settledFrom: params.source,
            eventId: params.eventId ?? null,
            settlementCurrency: TEKKO_NGN_VA_SETTLEMENT_CURRENCY,
          }),
        })
        .returning({ id: transactions.id });
      if (!created) throw new Error("Failed to create NGN VA payin");
      txId = created.id;
    }

    const [updated] = await txDb
      .update(transactions)
      .set({
        status: "success",
        paidAmount,
        currency: TEKKO_NGN_VA_SETTLEMENT_CURRENCY,
        updatedAt: new Date(),
      })
      .where(and(eq(transactions.id, txId), eq(transactions.status, "pending")))
      .returning();

    if (!updated) {
      // Already success or concurrent settle.
      return null;
    }

    const [existingCredit] = await txDb
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.referenceId, txId),
          eq(ledgerEntries.type, "payin"),
          eq(ledgerEntries.direction, "credit")
        )
      )
      .limit(1);
    if (existingCredit) return { txId, skippedLedger: true as const };

    const [w] = await txDb.select().from(wallets).where(eq(wallets.id, wallet.id)).limit(1);
    if (!w) throw new Error("Wallet missing during Tekko NGN VA settle");

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
      referenceId: txId,
    });

    return { txId, skippedLedger: false as const };
  });

  if (!result) return null;

  await tryApplyTransactionFee({
    merchantId: params.merchantId,
    environment: params.environment,
    transactionId: result.txId,
    feeType: "payin",
    amount: paidAmount,
    currency: TEKKO_NGN_VA_SETTLEMENT_CURRENCY,
    provider: TEKKO_NGN_VA_PROVIDER,
  }).catch(() => undefined);

  audit({
    action: "payment.completed",
    resource: result.txId,
    merchantId: params.merchantId,
    meta: {
      provider: TEKKO_NGN_VA_PROVIDER,
      paidAmount,
      currency: TEKKO_NGN_VA_SETTLEMENT_CURRENCY,
      source: params.source,
      tekkoLedger: "customer",
    },
  });

  const breakdown = await buildTransactionFeeBreakdown({
    merchantId: params.merchantId,
    environment: params.environment,
    transactionId: result.txId,
    type: "payin",
    status: "success",
    amount: paidAmount,
    currency: TEKKO_NGN_VA_SETTLEMENT_CURRENCY,
    provider: TEKKO_NGN_VA_PROVIDER,
  }).catch(() => null);

  return {
    merchantId: params.merchantId,
    transactionId: result.txId,
    event: {
      type: "payin.completed",
      transactionId: result.txId,
      status: "success",
      amount: paidAmount,
      paidAmount,
      currency: TEKKO_NGN_VA_SETTLEMENT_CURRENCY,
      platformOrderId: externalId,
      ...feeBreakdownToWebhookFields(breakdown),
    },
  };
}

export async function findMerchantIdByTekkoCustomerId(
  endUserId: string | number
): Promise<string | null> {
  const id = String(endUserId).trim();
  if (!id) return null;
  const [row] = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(eq(merchants.tekkoCustomerId, id))
    .limit(1);
  return row?.id ?? null;
}

/** Fallback when webhook omits endUserId but includes the permanent VA NUBAN. */
export async function findMerchantIdByTekkoNgnVaAccountNumber(
  accountNumber: string
): Promise<string | null> {
  const acct = accountNumber.replace(/\s/g, "").trim();
  if (!acct) return null;
  const [row] = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(eq(merchants.tekkoNgnVaAccountNumber, acct))
    .limit(1);
  return row?.id ?? null;
}
