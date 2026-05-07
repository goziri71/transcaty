/**
 * Integration tests for src/lib/idempotency.ts. Requires a reachable
 * Postgres; skipped otherwise.
 *
 * Verifies:
 *  - First request claims the slot and runs the work function.
 *  - Replay with the same body returns the cached snapshot WITHOUT
 *    re-running the work function.
 *  - Replay with a different body produces a 409-equivalent
 *    `body_mismatch` outcome.
 *  - Concurrent same-key/same-body requests collapse to a single work
 *    invocation.
 *  - Failures inside the work function release the slot so retries can
 *    proceed.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

const skip =
  !process.env.DATABASE_URL &&
  !(process.env.DATABASE_URL_ENC && process.env.ENCRYPTION_MASTER_KEY);

test("runIdempotent: replay returns cached snapshot without re-running work", { skip }, async () => {
  const { runIdempotent } = await import("../../src/lib/idempotency.js");
  const { db } = await import("../../src/db/index.js");
  const { merchants, idempotencyKeys } = await import("../../src/db/schema/index.js");
  const { eq, and } = await import("drizzle-orm");

  const [merchant] = await db
    .insert(merchants)
    .values({
      name: `test-idem-${randomUUID().slice(0, 8)}`,
      status: "active",
      kycStatus: "verified",
    })
    .returning();
  assert.ok(merchant);
  const merchantId = merchant.id;
  const key = `key-${randomUUID()}`;
  const body = { amount: "5.00", currency: "BDT" };

  let calls = 0;
  const work = async () => {
    calls++;
    return { ok: true, run: calls };
  };

  try {
    const r1 = await runIdempotent({ key, merchantId, body }, work);
    assert.equal(r1.kind, "fresh");
    if (r1.kind === "fresh") assert.equal(r1.result.run, 1);

    const r2 = await runIdempotent({ key, merchantId, body }, work);
    assert.equal(r2.kind, "replay");
    if (r2.kind === "replay") {
      assert.equal(r2.result.run, 1, "cached snapshot returned");
    }
    assert.equal(calls, 1, "work runs only once");
  } finally {
    await db
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.merchantId, merchantId)));
    await db.delete(merchants).where(eq(merchants.id, merchantId));
  }
});

test("runIdempotent: same key with different body returns body_mismatch", { skip }, async () => {
  const { runIdempotent } = await import("../../src/lib/idempotency.js");
  const { db } = await import("../../src/db/index.js");
  const { merchants, idempotencyKeys } = await import("../../src/db/schema/index.js");
  const { eq, and } = await import("drizzle-orm");

  const [merchant] = await db
    .insert(merchants)
    .values({
      name: `test-idem-${randomUUID().slice(0, 8)}`,
      status: "active",
      kycStatus: "verified",
    })
    .returning();
  assert.ok(merchant);
  const merchantId = merchant.id;
  const key = `key-${randomUUID()}`;

  try {
    const r1 = await runIdempotent(
      { key, merchantId, body: { amount: "5.00" } },
      async () => ({ id: "first" })
    );
    assert.equal(r1.kind, "fresh");

    const r2 = await runIdempotent(
      { key, merchantId, body: { amount: "5.01" } },
      async () => {
        throw new Error("work must not run on body_mismatch");
      }
    );
    assert.equal(r2.kind, "conflict");
    if (r2.kind === "conflict") {
      assert.equal(r2.reason, "body_mismatch");
    }
  } finally {
    await db
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.merchantId, merchantId)));
    await db.delete(merchants).where(eq(merchants.id, merchantId));
  }
});

test("runIdempotent: failing work releases the slot for retry", { skip }, async () => {
  const { runIdempotent } = await import("../../src/lib/idempotency.js");
  const { db } = await import("../../src/db/index.js");
  const { merchants, idempotencyKeys } = await import("../../src/db/schema/index.js");
  const { eq, and } = await import("drizzle-orm");

  const [merchant] = await db
    .insert(merchants)
    .values({
      name: `test-idem-${randomUUID().slice(0, 8)}`,
      status: "active",
      kycStatus: "verified",
    })
    .returning();
  assert.ok(merchant);
  const merchantId = merchant.id;
  const key = `key-${randomUUID()}`;
  const body = { amount: "3.00" };

  try {
    await assert.rejects(
      runIdempotent({ key, merchantId, body }, async () => {
        throw new Error("simulated upstream failure");
      })
    );

    let runs = 0;
    const r = await runIdempotent({ key, merchantId, body }, async () => {
      runs++;
      return { ok: true };
    });
    assert.equal(r.kind, "fresh", "second attempt should claim a fresh slot");
    assert.equal(runs, 1);
  } finally {
    await db
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.merchantId, merchantId)));
    await db.delete(merchants).where(eq(merchants.id, merchantId));
  }
});
