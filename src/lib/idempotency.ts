/**
 * Merchant request idempotency helper.
 *
 * Solves three problems with the prior implementation:
 *
 * 1. **Dual-fire under concurrency.** The previous handler ran the
 *    upstream call first and only persisted the response afterwards, so
 *    two concurrent requests with the same `Idempotency-Key` could both
 *    invoke the provider. This helper claims the slot via INSERT ...
 *    ON CONFLICT DO NOTHING *before* any upstream work; the loser
 *    short-circuits with the saved snapshot.
 *
 * 2. **Same key, different body.** Without a body hash a malicious or
 *    confused client could reuse a key for a different request and get
 *    a stale snapshot. We persist the SHA-256 of the canonical body and
 *    return a 409 when a re-issued key arrives with a different body.
 *
 * 3. **In-flight visibility.** A status field distinguishes
 *    `in_progress` (an attempt is currently running) from `completed`
 *    (snapshot ready). A retry that hits an in-flight slot is told to
 *    back off rather than receiving a confusing empty payload.
 *
 * Money-safety contract:
 *  - The work function MUST be safe to NOT run when this helper returns
 *    `kind: "replay"` — it has already been run for this key.
 *  - The work function MUST be safe to run even if the helper later
 *    fails to persist its snapshot; the work itself is the source of
 *    truth (idempotent at the rail level via `transactions.provider +
 *    external_id` uniqueness from P3).
 *  - This helper does NOT open a database transaction around the work,
 *    because work calls outbound APIs.
 */
import { createHash } from "node:crypto";
import { eq, and } from "drizzle-orm";
import type { FastifyRequest, FastifyReply } from "fastify";
import { db } from "../db/index.js";
import { idempotencyKeys } from "../db/schema/index.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export type IdempotencyOutcome<T> =
  | { kind: "fresh"; result: T }
  | { kind: "replay"; result: T; previouslyCompletedAt?: Date }
  | { kind: "conflict"; reason: "body_mismatch" | "in_progress" };

export interface RunIdempotentInput {
  /** Trimmed `Idempotency-Key` header from the merchant. */
  key: string;
  /** Owner of the idempotency slot. */
  merchantId: string;
  /** Canonical JSON of the request body — used to compute the body
   * hash. The caller is responsible for stable serialization (key
   * ordering does not matter for primitive request shapes; this helper
   * does not re-canonicalize). */
  body: unknown;
  /** Optional override (ms). */
  ttlMs?: number;
}

/** Stable JSON.stringify with sorted object keys so the same logical
 * payload always produces the same body hash. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(value, replacer());
}

function replacer() {
  return function (this: unknown, _key: string, val: unknown): unknown {
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      const o = val as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) sorted[k] = o[k];
      return sorted;
    }
    return val;
  };
}

export function computeBodyHash(body: unknown): string {
  return createHash("sha256").update(canonicalStringify(body), "utf8").digest("hex");
}

/** Pull and trim an `Idempotency-Key` header. Empty / whitespace-only
 * keys are treated as absent. */
export function readIdempotencyKey(request: FastifyRequest): string | null {
  const raw = request.headers["idempotency-key"];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Fastify wrapper around {@link runIdempotent}. Reads the
 * `Idempotency-Key` header, runs `work` exactly once for that key, and
 * returns the cached snapshot on replay. On conflict, sends a 409
 * response and returns `undefined` so the caller knows not to write a
 * second response.
 */
export async function withIdempotency<T>(
  opts: {
    request: FastifyRequest;
    reply: FastifyReply;
    merchantId: string;
    body: unknown;
    ttlMs?: number;
    /**
     * When true (money writes), missing/blank `Idempotency-Key` → 400.
     * Defaults false for non-money callers that still want optional replay safety.
     */
    required?: boolean;
  },
  work: () => Promise<T>
): Promise<T | undefined> {
  const key = readIdempotencyKey(opts.request);
  if (!key) {
    if (opts.required) {
      opts.reply.status(400).send({
        error: "Bad Request",
        message: "Idempotency-Key header is required",
      });
      return undefined;
    }
    return work();
  }

  const outcome = await runIdempotent(
    { key, merchantId: opts.merchantId, body: opts.body, ttlMs: opts.ttlMs },
    work
  );

  if (outcome.kind === "fresh" || outcome.kind === "replay") {
    return outcome.result;
  }

  const message =
    outcome.reason === "in_progress"
      ? "An earlier request with this Idempotency-Key is still in progress; retry shortly"
      : "Idempotency-Key was already used with a different request body";
  opts.reply.status(409).send({
    error: "Idempotency conflict",
    message,
    reason: outcome.reason,
  });
  return undefined;
}

/**
 * Run `work` exactly once per `(merchantId, key)`.
 *
 * Returns:
 *  - `kind: 'fresh'` — the slot was claimed, work ran, and its result is
 *    stored as the snapshot.
 *  - `kind: 'replay'` — a previous request with the same key and the
 *    same body completed successfully; the cached snapshot is returned
 *    as `result`.
 *  - `kind: 'conflict'` — either the slot is in flight from a sibling
 *    request (`in_progress`) or this request's body differs from the
 *    one originally associated with the key (`body_mismatch`).
 */
export async function runIdempotent<T>(
  input: RunIdempotentInput,
  work: () => Promise<T>
): Promise<IdempotencyOutcome<T>> {
  const { key, merchantId } = input;
  const trimmedKey = key.trim();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const bodyHash = computeBodyHash(input.body);
  const expiresAt = new Date(Date.now() + ttlMs);

  // 1. Try to claim the slot.
  const claimed = await db
    .insert(idempotencyKeys)
    .values({
      key: trimmedKey,
      merchantId,
      bodyHash,
      status: "in_progress",
      responseSnapshot: "",
      expiresAt,
    })
    .onConflictDoNothing({ target: [idempotencyKeys.key, idempotencyKeys.merchantId] })
    .returning({ key: idempotencyKeys.key });

  if (claimed.length === 0) {
    // 2. Existing row — inspect it.
    const [existing] = await db
      .select({
        bodyHash: idempotencyKeys.bodyHash,
        status: idempotencyKeys.status,
        responseSnapshot: idempotencyKeys.responseSnapshot,
        updatedAt: idempotencyKeys.updatedAt,
      })
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.key, trimmedKey),
          eq(idempotencyKeys.merchantId, merchantId)
        )
      )
      .limit(1);

    if (!existing) {
      // Race: row was just deleted (e.g. expired-and-purged). Retry the
      // claim once.
      return runIdempotent(input, work);
    }

    // Body mismatch is a hard conflict. Legacy rows have body_hash = ''
    // (default before P3); we treat empty as "unknown" and let them
    // through to avoid breaking already-cached snapshots.
    if (
      existing.bodyHash &&
      existing.bodyHash.length > 0 &&
      existing.bodyHash !== bodyHash
    ) {
      return { kind: "conflict", reason: "body_mismatch" };
    }

    if (existing.status === "completed") {
      const result = existing.responseSnapshot
        ? (JSON.parse(existing.responseSnapshot) as T)
        : (undefined as unknown as T);
      return { kind: "replay", result, previouslyCompletedAt: existing.updatedAt };
    }

    return { kind: "conflict", reason: "in_progress" };
  }

  // 3. Slot is ours. Run the work, then persist the snapshot.
  let result: T;
  try {
    result = await work();
  } catch (err) {
    // Best-effort cleanup so the merchant can retry with the same key
    // and body. We delete only when the row is still our in_progress
    // claim, never when another writer raced past us.
    await db
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.key, trimmedKey),
          eq(idempotencyKeys.merchantId, merchantId),
          eq(idempotencyKeys.status, "in_progress"),
          eq(idempotencyKeys.bodyHash, bodyHash)
        )
      )
      .catch(() => {});
    throw err;
  }

  const snapshot = JSON.stringify(result ?? null);
  await db
    .update(idempotencyKeys)
    .set({
      status: "completed",
      responseSnapshot: snapshot,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(idempotencyKeys.key, trimmedKey),
        eq(idempotencyKeys.merchantId, merchantId)
      )
    );

  return { kind: "fresh", result };
}
