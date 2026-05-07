/**
 * Integration test: webhook_events dedupe.
 *
 * The unique index on dedupe_hash must absorb a duplicate (rail,
 * environment, raw_body) replay so the apply function only fires once.
 *
 * Skipped when no DATABASE_URL is configured.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";

const skip =
  !process.env.DATABASE_URL &&
  !(process.env.DATABASE_URL_ENC && process.env.ENCRYPTION_MASTER_KEY);

test("tryClaimWebhookEvent: first call is fresh, second is duplicate", { skip }, async () => {
  const { tryClaimWebhookEvent, computeDedupeHash } = await import(
    "../../src/lib/webhook-events.js"
  );
  const { db } = await import("../../src/db/index.js");
  const { webhookEvents } = await import("../../src/db/schema/index.js");
  const { eq } = await import("drizzle-orm");

  const rawBody = `{"merchantOrderId":"test-${Math.random()}","status":"SUCCESS"}`;
  const dedupeHash = computeDedupeHash("payok-bd-payin", "test", rawBody);

  try {
    const first = await tryClaimWebhookEvent({
      rail: "payok-bd-payin",
      environment: "test",
      rawBody,
      signature: "sig-abc",
      signatureValid: true,
    });
    assert.equal(first.kind, "fresh");
    if (first.kind !== "fresh") return;

    const second = await tryClaimWebhookEvent({
      rail: "payok-bd-payin",
      environment: "test",
      rawBody,
      signature: "sig-abc",
      signatureValid: true,
    });
    assert.equal(second.kind, "duplicate");
    if (second.kind === "duplicate") {
      assert.equal(second.eventId, first.eventId);
    }
  } finally {
    await db.delete(webhookEvents).where(eq(webhookEvents.dedupeHash, dedupeHash));
  }
});

test("tryClaimWebhookEvent: different rail or environment is NOT a duplicate", { skip }, async () => {
  const { tryClaimWebhookEvent, computeDedupeHash } = await import(
    "../../src/lib/webhook-events.js"
  );
  const { db } = await import("../../src/db/index.js");
  const { webhookEvents } = await import("../../src/db/schema/index.js");
  const { inArray } = await import("drizzle-orm");

  const rawBody = `{"id":"shared-${Math.random()}"}`;
  const hashA = computeDedupeHash("payok-bd-payin", "test", rawBody);
  const hashB = computeDedupeHash("payok-bd-payin", "live", rawBody);
  const hashC = computeDedupeHash("payok-bd-payout", "test", rawBody);

  try {
    const a = await tryClaimWebhookEvent({
      rail: "payok-bd-payin",
      environment: "test",
      rawBody,
      signatureValid: true,
    });
    const b = await tryClaimWebhookEvent({
      rail: "payok-bd-payin",
      environment: "live",
      rawBody,
      signatureValid: true,
    });
    const c = await tryClaimWebhookEvent({
      rail: "payok-bd-payout",
      environment: "test",
      rawBody,
      signatureValid: true,
    });
    assert.equal(a.kind, "fresh");
    assert.equal(b.kind, "fresh");
    assert.equal(c.kind, "fresh");
  } finally {
    await db
      .delete(webhookEvents)
      .where(inArray(webhookEvents.dedupeHash, [hashA, hashB, hashC]));
  }
});
