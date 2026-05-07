/**
 * Webhook ingest helpers.
 *
 * Every payment-processor callback we receive is recorded in the
 * `webhook_events` table after signature verification. The unique index
 * on `dedupe_hash` makes replays cheap: the second insert violates the
 * constraint and we return without re-running the apply function.
 *
 * Failed signature verifications are NOT persisted here — that would
 * give an unauthenticated client a write amplifier. Logging them is
 * enough; the rate limiter handles flood control.
 *
 * Money-safety contract:
 *  - `tryClaimWebhookEvent` MUST be called inside a fresh DB context (no
 *    enclosing transaction). The dedupe write needs to be visible to
 *    other workers immediately, not on enclosing-tx commit.
 *  - The apply function should be idempotent on its own (P1 conditional
 *    UPDATE pattern); webhook_events is a belt-and-braces dedupe at the
 *    edge.
 */
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { webhookEvents } from "../db/schema/index.js";

export type WebhookClaim =
  /** First time we have seen this (rail, environment, raw_body). The
   * caller should run the apply function. */
  | {
      kind: "fresh";
      eventId: string;
      dedupeHash: string;
    }
  /** Already processed earlier. The apply function MUST NOT run again. */
  | {
      kind: "duplicate";
      eventId: string;
      previousStatus: string;
      dedupeHash: string;
    };

export interface ClaimInput {
  rail: string;
  environment: string;
  rawBody: string;
  signature?: string | null;
  signatureValid: boolean;
  externalId?: string | null;
}

export function computeDedupeHash(rail: string, environment: string, rawBody: string): string {
  return createHash("sha256")
    .update(`${rail}|${environment}|`, "utf8")
    .update(rawBody, "utf8")
    .digest("hex");
}

/**
 * Insert a row for the incoming webhook with `status = 'received'`. If a
 * row with the same `dedupe_hash` already exists, return its id with
 * `kind: 'duplicate'` so the caller can short-circuit.
 *
 * We use `INSERT ... ON CONFLICT DO NOTHING RETURNING id` so the path is
 * a single round-trip on the happy path. When the conflict fires, we do
 * a separate SELECT to recover the existing row id and current status.
 */
export async function tryClaimWebhookEvent(input: ClaimInput): Promise<WebhookClaim> {
  const dedupeHash = computeDedupeHash(input.rail, input.environment, input.rawBody);

  const inserted = await db
    .insert(webhookEvents)
    .values({
      rail: input.rail,
      environment: input.environment,
      dedupeHash,
      rawBody: input.rawBody,
      signature: input.signature ?? null,
      signatureValid: input.signatureValid,
      externalId: input.externalId ?? null,
      status: "received",
      attempts: "1",
    })
    .onConflictDoNothing({ target: webhookEvents.dedupeHash })
    .returning({ id: webhookEvents.id });

  if (inserted.length > 0) {
    return { kind: "fresh", eventId: inserted[0]!.id, dedupeHash };
  }

  // Conflict: row already exists. Look it up to decide what to log /
  // return to the caller.
  const [existing] = await db
    .select({ id: webhookEvents.id, status: webhookEvents.status })
    .from(webhookEvents)
    .where(eq(webhookEvents.dedupeHash, dedupeHash))
    .limit(1);

  // Best effort: bump attempts so we can see how aggressive a provider
  // is replaying us. Use a SQL increment because attempts is text.
  if (existing) {
    await db
      .update(webhookEvents)
      .set({ attempts: sql`(COALESCE(NULLIF(${webhookEvents.attempts}, ''), '0')::int + 1)::text` })
      .where(eq(webhookEvents.id, existing.id));
  }

  return {
    kind: "duplicate",
    eventId: existing?.id ?? "",
    previousStatus: existing?.status ?? "unknown",
    dedupeHash,
  };
}

/** Mark the claim as successfully applied. Safe to call multiple times. */
export async function markWebhookProcessed(
  eventId: string,
  details: { transactionId?: string | null } = {}
): Promise<void> {
  if (!eventId) return;
  await db
    .update(webhookEvents)
    .set({
      status: "processed",
      processedAt: new Date(),
      transactionId: details.transactionId ?? undefined,
      error: null,
    })
    .where(eq(webhookEvents.id, eventId));
}

/** Mark the claim as failed. The error is truncated to keep the table sane. */
export async function markWebhookFailed(eventId: string, error: unknown): Promise<void> {
  if (!eventId) return;
  const msg = error instanceof Error ? error.message : String(error);
  await db
    .update(webhookEvents)
    .set({
      status: "failed",
      processedAt: new Date(),
      error: msg.slice(0, 1024),
    })
    .where(eq(webhookEvents.id, eventId));
}
