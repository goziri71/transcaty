/**
 * Integration tests for the maker-checker guard logic in
 * src/lib/payout-approvals.ts. Requires a reachable Postgres; skipped
 * otherwise (same convention as idempotency-integration.test.ts).
 *
 * Deliberately never lets a test reach executeRail() / a real rail
 * executor (Tylt/Tekko/PayOK) — every seeded row uses an out-of-bounds
 * amount so revalidateBeforeExecution fails deterministically BEFORE
 * dispatch, letting us verify the atomic-claim race and guard logic
 * without risking a live outbound payment call.
 *
 * Verifies:
 *  - A requester cannot approve their own payout (MAKER_CHECKER).
 *  - An expired request cannot be approved (EXPIRED), and is marked
 *    expired in the DB.
 *  - Concurrent double-approve collapses to exactly one atomic claim
 *    (the loser gets ALREADY_PROCESSED).
 *  - Rejecting a request, then trying to approve it, is rejected as
 *    ALREADY_PROCESSED.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";

const skip =
  !process.env.DATABASE_URL &&
  !(process.env.DATABASE_URL_ENC && process.env.ENCRYPTION_MASTER_KEY);

function fakeReply(): FastifyReply {
  const reply = {
    status() {
      return { send() {} };
    },
  };
  return reply as unknown as FastifyReply;
}

async function seedMerchantWithUsers() {
  const { db } = await import("../../src/db/index.js");
  const { merchants, merchantUsers } = await import("../../src/db/schema/index.js");

  const [merchant] = await db
    .insert(merchants)
    .values({
      name: `test-payout-approval-${randomUUID().slice(0, 8)}`,
      status: "active",
      kycStatus: "verified",
    })
    .returning();
  assert.ok(merchant);

  const [requester] = await db
    .insert(merchantUsers)
    .values({ merchantId: merchant!.id, email: `maker-${randomUUID().slice(0, 8)}@test.local`, role: "admin" })
    .returning();
  const [approver] = await db
    .insert(merchantUsers)
    .values({ merchantId: merchant!.id, email: `checker-${randomUUID().slice(0, 8)}@test.local`, role: "admin" })
    .returning();
  assert.ok(requester);
  assert.ok(approver);

  return { merchant: merchant!, requester: requester!, approver: approver! };
}

async function cleanup(merchantId: string) {
  const { db } = await import("../../src/db/index.js");
  const { merchants, merchantUsers, portalPayoutApprovalRequests } = await import(
    "../../src/db/schema/index.js"
  );
  const { eq } = await import("drizzle-orm");
  await db.delete(portalPayoutApprovalRequests).where(eq(portalPayoutApprovalRequests.merchantId, merchantId));
  await db.delete(merchantUsers).where(eq(merchantUsers.merchantId, merchantId));
  await db.delete(merchants).where(eq(merchants.id, merchantId));
}

/** Out-of-bounds BDT amount so revalidateBeforeExecution fails the LIMITS
 * check and returns before ever calling a real rail executor. */
const OUT_OF_BOUNDS_BDT_AMOUNT = "999999999.00";

async function seedPendingRequest(params: {
  merchantId: string;
  requestedBy: string;
  expiresAt?: Date;
}) {
  const { db } = await import("../../src/db/index.js");
  const { portalPayoutApprovalRequests } = await import("../../src/db/schema/index.js");

  const [row] = await db
    .insert(portalPayoutApprovalRequests)
    .values({
      rail: "bd",
      status: "pending",
      merchantId: params.merchantId,
      environment: "test",
      requestedBy: params.requestedBy,
      idempotencyKey: `key-${randomUUID()}`,
      bodyHash: "test-hash",
      payload: JSON.stringify({}),
      amount: OUT_OF_BOUNDS_BDT_AMOUNT,
      currency: "BDT",
      triggerReason: "dual_control_threshold",
      expiresAt: params.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000),
    })
    .returning();
  assert.ok(row);
  return row!;
}

test("approvePortalPayoutRequest: requester cannot approve their own payout", { skip }, async () => {
  const { approvePortalPayoutRequest } = await import("../../src/lib/payout-approvals.js");
  const { merchant, requester } = await seedMerchantWithUsers();
  try {
    const row = await seedPendingRequest({ merchantId: merchant.id, requestedBy: requester.id });

    const result = await approvePortalPayoutRequest({
      requestId: row.id,
      merchantId: merchant.id,
      approverMerchantUserId: requester.id, // same as requestedBy
      approverEmail: requester.email,
      reply: fakeReply(),
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "MAKER_CHECKER");
  } finally {
    await cleanup(merchant.id);
  }
});

test("approvePortalPayoutRequest: an expired request cannot be approved", { skip }, async () => {
  const { approvePortalPayoutRequest } = await import("../../src/lib/payout-approvals.js");
  const { db } = await import("../../src/db/index.js");
  const { portalPayoutApprovalRequests } = await import("../../src/db/schema/index.js");
  const { eq } = await import("drizzle-orm");
  const { merchant, requester, approver } = await seedMerchantWithUsers();
  try {
    const row = await seedPendingRequest({
      merchantId: merchant.id,
      requestedBy: requester.id,
      expiresAt: new Date(Date.now() - 1000),
    });

    const result = await approvePortalPayoutRequest({
      requestId: row.id,
      merchantId: merchant.id,
      approverMerchantUserId: approver.id,
      approverEmail: approver.email,
      reply: fakeReply(),
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "EXPIRED");

    const [after] = await db
      .select({ status: portalPayoutApprovalRequests.status })
      .from(portalPayoutApprovalRequests)
      .where(eq(portalPayoutApprovalRequests.id, row.id))
      .limit(1);
    assert.equal(after?.status, "expired");
  } finally {
    await cleanup(merchant.id);
  }
});

test("approvePortalPayoutRequest: concurrent double-approve collapses to exactly one claim", { skip }, async () => {
  const { approvePortalPayoutRequest } = await import("../../src/lib/payout-approvals.js");
  const { merchant, requester, approver } = await seedMerchantWithUsers();
  try {
    const row = await seedPendingRequest({ merchantId: merchant.id, requestedBy: requester.id });

    const [r1, r2] = await Promise.all([
      approvePortalPayoutRequest({
        requestId: row.id,
        merchantId: merchant.id,
        approverMerchantUserId: approver.id,
        approverEmail: approver.email,
        reply: fakeReply(),
      }),
      approvePortalPayoutRequest({
        requestId: row.id,
        merchantId: merchant.id,
        approverMerchantUserId: approver.id,
        approverEmail: approver.email,
        reply: fakeReply(),
      }),
    ]);

    const results = [r1, r2];
    const alreadyProcessed = results.filter((r) => !r.ok && r.error === "ALREADY_PROCESSED");
    const claimed = results.filter((r) => !(!r.ok && r.error === "ALREADY_PROCESSED"));

    // Exactly one call wins the atomic claim; the loser is told the row is
    // no longer pending. The winner hits EXECUTION_FAILED (out-of-bounds
    // amount, deliberately, to avoid ever calling a real rail executor in
    // this test) rather than ALREADY_PROCESSED — the two are distinct
    // outcomes and only one caller may reach the non-ALREADY_PROCESSED path.
    assert.equal(alreadyProcessed.length, 1, "exactly one concurrent call should see ALREADY_PROCESSED");
    assert.equal(claimed.length, 1, "exactly one concurrent call should win the atomic claim");
    assert.equal(claimed[0]!.ok, false);
    if (!claimed[0]!.ok) assert.equal(claimed[0]!.error, "EXECUTION_FAILED");
  } finally {
    await cleanup(merchant.id);
  }
});

test("approvePortalPayoutRequest: rejecting first, then approving, is rejected as already processed", { skip }, async () => {
  const { approvePortalPayoutRequest, rejectPortalPayoutRequest } = await import(
    "../../src/lib/payout-approvals.js"
  );
  const { merchant, requester, approver } = await seedMerchantWithUsers();
  try {
    const row = await seedPendingRequest({ merchantId: merchant.id, requestedBy: requester.id });

    const rejected = await rejectPortalPayoutRequest({
      requestId: row.id,
      merchantId: merchant.id,
      rejectorMerchantUserId: approver.id,
      rejectorEmail: approver.email,
      reason: "test rejection",
    });
    assert.equal(rejected.ok, true);

    const approved = await approvePortalPayoutRequest({
      requestId: row.id,
      merchantId: merchant.id,
      approverMerchantUserId: approver.id,
      approverEmail: approver.email,
      reply: fakeReply(),
    });
    assert.equal(approved.ok, false);
    if (!approved.ok) assert.equal(approved.error, "ALREADY_PROCESSED");
  } finally {
    await cleanup(merchant.id);
  }
});
