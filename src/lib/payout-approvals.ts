/**
 * Maker-checker (dual control) approval queue for large merchant-portal
 * payouts. Mirrors the working provider-side pattern (providerActionRequests
 * in api/provider/index.ts) on the merchant-portal side, across all 5
 * payout rails (EUR, CPG/India, Brazil, NGN, legacy Bangladesh).
 *
 * Flow:
 *  1. A route calls evaluatePortalPayoutGate with the exact params object
 *     it would otherwise pass straight to its rail executor. If the
 *     amount is over the configured per-currency threshold, or the
 *     platform payout-velocity breaker is in "review" mode and would
 *     fire, a pending row is inserted instead of executing, and the
 *     route returns 202 to the maker.
 *  2. A different admin/finance user (never the maker) approves via
 *     approvePortalPayoutRequest, which re-validates (access gate,
 *     LIMITS, velocity) since up to 15 minutes may have passed, then
 *     calls the same rail executor with the stored params — outside any
 *     DB transaction, per idempotency.ts's documented money-safety
 *     contract (outbound HTTP calls must not run inside an open tx).
 *
 * Execution failures after approval are terminal (status
 * 'execution_failed', no auto-retry): none of the 5 executors are safely
 * re-invokable outside their own withIdempotency wrap, which doesn't
 * apply here since approval is a separate HTTP request from creation.
 * Silently retrying risks double-firing a real payout — failures need
 * manual ops/merchant follow-up, consistent with this repo's fail-safe
 * convention (reject or mark failed, never guess success).
 */
import type { FastifyReply } from "fastify";
import { and, eq, gt } from "drizzle-orm";
import { db } from "../db/index.js";
import { portalPayoutApprovalRequests, merchantUsers } from "../db/schema/index.js";
import { audit } from "./audit.js";
import { queueTransactionalEmail } from "./transactional-email-queue.js";
import { canonicalStringify, computeBodyHash } from "./idempotency.js";
import {
  assertPayoutVelocityAllowed,
  PayoutVelocityReviewRequiredError,
  FraudPolicyRejectedError,
} from "./fraud-policy.js";
import {
  requirePortalEuropeAccess,
  requirePortalIndiaAccess,
  requirePortalBrazilAccess,
  requirePortalNgnAccess,
  requirePortalBangladeshAccess,
} from "./portal-payout-access.js";
import { LIMITS } from "./limits.js";
import { createTyltEurPayoutInstance } from "../../services/integrations/tylt/eur-payout.js";
import { createTyltCpgPayoutRequest } from "../../services/integrations/tylt/cpg-payout.js";
import { createPayoutOrder as createBrazilPayoutOrder } from "../../services/domestic/brazil/index.js";
import { createTekkoNgnPayout } from "../../services/integrations/tekko/index.js";
import { createPayoutOrder as createBangladeshPayoutOrder } from "../../services/domestic/bangladesh/payout.js";

export type PortalPayoutRail = "eur" | "cpg" | "br" | "ngn" | "bd";

const APPROVAL_TTL_MS = 15 * 60 * 1000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 0/unset = disabled for that currency. Currency alone disambiguates
 * across rails (EUR only ever comes from the EUR rail, NGN only from
 * NGN, etc.), so this is deliberately not keyed by rail. */
export function getPortalPayoutApprovalThreshold(currency: string): number {
  const perCurrency = process.env[`PORTAL_PAYOUT_APPROVAL_THRESHOLD_${currency.toUpperCase()}`];
  if (perCurrency != null && perCurrency.trim() !== "") {
    return envInt(`PORTAL_PAYOUT_APPROVAL_THRESHOLD_${currency.toUpperCase()}`, 0);
  }
  return envInt("PORTAL_PAYOUT_APPROVAL_THRESHOLD_DEFAULT", 0);
}

export interface PortalPayoutGateParams {
  rail: PortalPayoutRail;
  merchantId: string;
  merchantUserId: string;
  actorEmail: string;
  environment: "test" | "live";
  amount: string;
  currency: string;
  idempotencyKey: string;
  /** The exact params object the rail's executor would be called with. */
  executorParams: Record<string, unknown>;
}

export type PortalPayoutGateDecision =
  | { kind: "proceed" }
  | { kind: "queued"; requestId: string; expiresAt: string; triggerReason: "dual_control_threshold" | "velocity_ceiling" };

async function notifyPortalApproversOfPendingPayout(params: {
  merchantId: string;
  excludeMerchantUserId: string;
  rail: PortalPayoutRail;
  amount: string;
  currency: string;
  requestId: string;
  requestedByEmail: string;
  expiresAt: string;
}): Promise<void> {
  const rows = await db
    .select({ email: merchantUsers.email, role: merchantUsers.role, id: merchantUsers.id })
    .from(merchantUsers)
    .where(eq(merchantUsers.merchantId, params.merchantId));

  const emails = [
    ...new Set(
      rows
        .filter((r) => (r.role === "admin" || r.role === "finance") && r.id !== params.excludeMerchantUserId)
        .map((r) => r.email.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];

  for (const to of emails) {
    await queueTransactionalEmail({
      kind: "portal_payout_approval_pending",
      to,
      rail: params.rail,
      amount: params.amount,
      currency: params.currency,
      requestId: params.requestId,
      requestedByEmail: params.requestedByEmail,
      expiresAt: params.expiresAt,
    }).catch(() => {});
  }
}

async function queueApprovalRequest(
  params: PortalPayoutGateParams,
  triggerReason: "dual_control_threshold" | "velocity_ceiling"
): Promise<PortalPayoutGateDecision> {
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
  const [row] = await db
    .insert(portalPayoutApprovalRequests)
    .values({
      rail: params.rail,
      status: "pending",
      merchantId: params.merchantId,
      environment: params.environment,
      requestedBy: params.merchantUserId,
      idempotencyKey: params.idempotencyKey,
      bodyHash: computeBodyHash(params.executorParams),
      payload: canonicalStringify(params.executorParams),
      amount: params.amount,
      currency: params.currency,
      triggerReason,
      expiresAt,
    })
    .returning({ id: portalPayoutApprovalRequests.id });

  audit({
    action: "portal.payout_approval.queued",
    merchantId: params.merchantId,
    merchantUserId: params.merchantUserId,
    actorEmail: params.actorEmail,
    resource: row!.id,
    meta: { rail: params.rail, amount: params.amount, currency: params.currency, triggerReason },
  });

  await notifyPortalApproversOfPendingPayout({
    merchantId: params.merchantId,
    excludeMerchantUserId: params.merchantUserId,
    rail: params.rail,
    amount: params.amount,
    currency: params.currency,
    requestId: row!.id,
    requestedByEmail: params.actorEmail,
    expiresAt: expiresAt.toISOString(),
  });

  return { kind: "queued", requestId: row!.id, expiresAt: expiresAt.toISOString(), triggerReason };
}

/**
 * Called from inside each route's withIdempotency work closure, with the
 * exact params object that would otherwise go straight to the rail
 * executor. Runs the platform velocity breaker first (review mode may
 * queue), then the per-currency dual-control threshold.
 */
export async function evaluatePortalPayoutGate(
  params: PortalPayoutGateParams
): Promise<PortalPayoutGateDecision> {
  try {
    await assertPayoutVelocityAllowed({
      environment: params.environment,
      currency: params.currency,
      amount: params.amount,
    });
  } catch (err) {
    if (err instanceof PayoutVelocityReviewRequiredError) {
      return queueApprovalRequest(params, "velocity_ceiling");
    }
    throw err; // FraudPolicyRejectedError (block mode) propagates to the route's own catch.
  }

  const threshold = getPortalPayoutApprovalThreshold(params.currency);
  const amt = parseFloat(params.amount);
  if (threshold > 0 && Number.isFinite(amt) && amt >= threshold) {
    return queueApprovalRequest(params, "dual_control_threshold");
  }

  return { kind: "proceed" };
}

type ApprovalRow = typeof portalPayoutApprovalRequests.$inferSelect;

async function executeRail(rail: PortalPayoutRail, executorParams: Record<string, unknown>): Promise<{ transactionId: string }> {
  switch (rail) {
    case "eur": {
      const result = await createTyltEurPayoutInstance(
        executorParams as Parameters<typeof createTyltEurPayoutInstance>[0]
      );
      return { transactionId: result.transactionId };
    }
    case "cpg": {
      const result = await createTyltCpgPayoutRequest(
        executorParams as Parameters<typeof createTyltCpgPayoutRequest>[0]
      );
      return { transactionId: result.transactionId };
    }
    case "br": {
      const result = await createBrazilPayoutOrder(
        executorParams as Parameters<typeof createBrazilPayoutOrder>[0]
      );
      return { transactionId: result.transactionId };
    }
    case "ngn": {
      const result = await createTekkoNgnPayout(
        executorParams as Parameters<typeof createTekkoNgnPayout>[0]
      );
      return { transactionId: result.transactionId };
    }
    case "bd": {
      const result = await createBangladeshPayoutOrder(
        executorParams as Parameters<typeof createBangladeshPayoutOrder>[0]
      );
      return { transactionId: result.transactionId };
    }
  }
}

async function revalidateBeforeExecution(row: ApprovalRow, reply: FastifyReply): Promise<{ ok: true } | { ok: false; message: string }> {
  const gateByRail: Record<PortalPayoutRail, typeof requirePortalEuropeAccess> = {
    eur: requirePortalEuropeAccess,
    cpg: requirePortalIndiaAccess,
    br: requirePortalBrazilAccess,
    ngn: requirePortalNgnAccess,
    bd: requirePortalBangladeshAccess,
  };
  const accessOk = await gateByRail[row.rail as PortalPayoutRail](row.merchantId, row.environment, reply);
  if (!accessOk) return { ok: false, message: "Merchant no longer eligible for this payout (KYC/market access)" };

  const amt = parseFloat(row.amount);
  const boundsByCurrency: Record<string, { min: number; max: number } | undefined> = {
    EUR: LIMITS.tyltEurOpenBanking.EUR,
    GBP: LIMITS.tyltEurOpenBanking.GBP,
    NGN: LIMITS.tekkoNgn.payout,
    BRL: LIMITS.payokBr.payout,
    BDT: LIMITS.payout,
  };
  const bounds = boundsByCurrency[row.currency.toUpperCase()];
  if (bounds && (!Number.isFinite(amt) || amt < bounds.min || amt > bounds.max)) {
    return { ok: false, message: `Amount is no longer within allowed bounds for ${row.currency}` };
  }

  try {
    await assertPayoutVelocityAllowed({ environment: row.environment, currency: row.currency, amount: row.amount });
  } catch (err) {
    if (err instanceof FraudPolicyRejectedError || err instanceof PayoutVelocityReviewRequiredError) {
      return { ok: false, message: "Platform payout velocity limit would be exceeded" };
    }
    throw err;
  }

  return { ok: true };
}

export type PortalPayoutApprovalResult =
  | { ok: true; transactionId: string }
  | { ok: false; error: "NOT_FOUND" | "MAKER_CHECKER" | "EXPIRED" | "ALREADY_PROCESSED" | "EXECUTION_FAILED"; message: string };

export async function approvePortalPayoutRequest(params: {
  requestId: string;
  merchantId: string;
  approverMerchantUserId: string;
  approverEmail: string;
  reply: FastifyReply;
}): Promise<PortalPayoutApprovalResult> {
  const [row] = await db
    .select()
    .from(portalPayoutApprovalRequests)
    .where(
      and(
        eq(portalPayoutApprovalRequests.id, params.requestId),
        eq(portalPayoutApprovalRequests.merchantId, params.merchantId)
      )
    )
    .limit(1);

  if (!row) {
    return { ok: false, error: "NOT_FOUND", message: "Payout approval request not found" };
  }

  if (row.requestedBy && row.requestedBy === params.approverMerchantUserId) {
    return {
      ok: false,
      error: "MAKER_CHECKER",
      message: "You cannot approve a payout you submitted yourself",
    };
  }

  if (row.status === "pending" && row.expiresAt.getTime() <= Date.now()) {
    await db
      .update(portalPayoutApprovalRequests)
      .set({ status: "expired", updatedAt: new Date() })
      .where(
        and(eq(portalPayoutApprovalRequests.id, row.id), eq(portalPayoutApprovalRequests.status, "pending"))
      );
    audit({
      action: "portal.payout_approval.expired",
      merchantId: params.merchantId,
      resource: row.id,
      meta: { rail: row.rail },
    });
    return { ok: false, error: "EXPIRED", message: "This payout approval request has expired" };
  }

  const claimed = await db
    .update(portalPayoutApprovalRequests)
    .set({ status: "approved", approvedBy: params.approverMerchantUserId, updatedAt: new Date() })
    .where(
      and(
        eq(portalPayoutApprovalRequests.id, row.id),
        eq(portalPayoutApprovalRequests.status, "pending"),
        gt(portalPayoutApprovalRequests.expiresAt, new Date())
      )
    )
    .returning();

  if (claimed.length === 0) {
    return { ok: false, error: "ALREADY_PROCESSED", message: "This payout approval request is no longer pending" };
  }
  const claimedRow = claimed[0]!;

  const revalidation = await revalidateBeforeExecution(claimedRow, params.reply);
  if (!revalidation.ok) {
    await db
      .update(portalPayoutApprovalRequests)
      .set({ status: "execution_failed", lastError: revalidation.message, updatedAt: new Date() })
      .where(eq(portalPayoutApprovalRequests.id, row.id));
    audit({
      action: "portal.payout_approval.execution_failed",
      merchantId: params.merchantId,
      merchantUserId: params.approverMerchantUserId,
      actorEmail: params.approverEmail,
      resource: row.id,
      meta: { rail: row.rail, reason: revalidation.message },
    });
    return { ok: false, error: "EXECUTION_FAILED", message: revalidation.message };
  }

  try {
    const executorParams = JSON.parse(claimedRow.payload) as Record<string, unknown>;
    const result = await executeRail(claimedRow.rail as PortalPayoutRail, executorParams);

    await db
      .update(portalPayoutApprovalRequests)
      .set({
        status: "executed",
        executedAt: new Date(),
        executedTransactionId: result.transactionId,
        updatedAt: new Date(),
      })
      .where(eq(portalPayoutApprovalRequests.id, row.id));

    audit({
      action: "portal.payout_approval.approved",
      merchantId: params.merchantId,
      merchantUserId: params.approverMerchantUserId,
      actorEmail: params.approverEmail,
      resource: row.id,
      meta: { rail: row.rail, transactionId: result.transactionId },
    });

    return { ok: true, transactionId: result.transactionId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(portalPayoutApprovalRequests)
      .set({ status: "execution_failed", lastError: message.slice(0, 2000), updatedAt: new Date() })
      .where(eq(portalPayoutApprovalRequests.id, row.id));
    audit({
      action: "portal.payout_approval.execution_failed",
      merchantId: params.merchantId,
      merchantUserId: params.approverMerchantUserId,
      actorEmail: params.approverEmail,
      resource: row.id,
      meta: { rail: row.rail, error: message },
    });
    return { ok: false, error: "EXECUTION_FAILED", message: "The payout could not be executed. Contact support." };
  }
}

export async function rejectPortalPayoutRequest(params: {
  requestId: string;
  merchantId: string;
  rejectorMerchantUserId: string;
  rejectorEmail: string;
  reason: string;
}): Promise<{ ok: true } | { ok: false; error: "NOT_FOUND" | "ALREADY_PROCESSED" }> {
  const claimed = await db
    .update(portalPayoutApprovalRequests)
    .set({
      status: "rejected",
      approvedBy: params.rejectorMerchantUserId,
      rejectedReason: params.reason,
      rejectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(portalPayoutApprovalRequests.id, params.requestId),
        eq(portalPayoutApprovalRequests.merchantId, params.merchantId),
        eq(portalPayoutApprovalRequests.status, "pending")
      )
    )
    .returning({ id: portalPayoutApprovalRequests.id, rail: portalPayoutApprovalRequests.rail });

  if (claimed.length === 0) {
    const [exists] = await db
      .select({ id: portalPayoutApprovalRequests.id })
      .from(portalPayoutApprovalRequests)
      .where(
        and(
          eq(portalPayoutApprovalRequests.id, params.requestId),
          eq(portalPayoutApprovalRequests.merchantId, params.merchantId)
        )
      )
      .limit(1);
    return { ok: false, error: exists ? "ALREADY_PROCESSED" : "NOT_FOUND" };
  }

  audit({
    action: "portal.payout_approval.rejected",
    merchantId: params.merchantId,
    merchantUserId: params.rejectorMerchantUserId,
    actorEmail: params.rejectorEmail,
    resource: claimed[0]!.id,
    meta: { rail: claimed[0]!.rail, reason: params.reason },
  });

  return { ok: true };
}

export async function listPortalPayoutApprovals(params: {
  merchantId: string;
  status?: string;
  limit?: number;
}): Promise<{
  items: Array<{
    id: string;
    rail: string;
    status: string;
    amount: string;
    currency: string;
    environment: string;
    triggerReason: string;
    requestedBy: string | null;
    approvedBy: string | null;
    createdAt: string;
    expiresAt: string;
  }>;
}> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const conditions = [eq(portalPayoutApprovalRequests.merchantId, params.merchantId)];
  if (params.status) {
    conditions.push(
      eq(
        portalPayoutApprovalRequests.status,
        params.status as (typeof portalPayoutApprovalRequests.$inferSelect)["status"]
      )
    );
  }

  const rows = await db
    .select()
    .from(portalPayoutApprovalRequests)
    .where(and(...conditions))
    .orderBy(portalPayoutApprovalRequests.createdAt)
    .limit(limit);

  return {
    items: rows.map((r) => ({
      id: r.id,
      rail: r.rail,
      status: r.status,
      amount: r.amount,
      currency: r.currency,
      environment: r.environment,
      triggerReason: r.triggerReason,
      requestedBy: r.requestedBy,
      approvedBy: r.approvedBy,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
    })),
  };
}
