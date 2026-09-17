/**
 * JWT revocation helper (P4 Auth Hardening).
 *
 * Authenticated requests check `isJtiRevoked(realm, jti)` after the
 * JWT signature/expiry are verified. To avoid a DB round-trip on every
 * request, results are cached in-process with two TTLs:
 *
 *  - **Negative TTL** (`JWT_REVOCATION_NEGATIVE_TTL_MS`, default 5_000)
 *    for "not revoked" responses, so the hot path runs from memory
 *    while still picking up freshly-revoked jtis within a few seconds.
 *  - **Positive TTL** (`JWT_REVOCATION_POSITIVE_TTL_MS`, default 60_000)
 *    for "revoked" responses; revoked tokens stay revoked, so this can
 *    safely live longer.
 *
 * Eventual consistency across instances is acceptable for this use
 * case: a logout that hasn't propagated yet still has the bounded
 * window of `negative TTL`. For stricter behavior, broadcast revoke
 * events via Redis pub/sub (out of scope here).
 */
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { jwtRevocations } from "../db/schema/index.js";

const POSITIVE_TTL_MS = parseEnvInt(
  "JWT_REVOCATION_POSITIVE_TTL_MS",
  60_000,
  0
);
const NEGATIVE_TTL_MS = parseEnvInt(
  "JWT_REVOCATION_NEGATIVE_TTL_MS",
  5_000,
  0
);
const CACHE_MAX = parseEnvInt("JWT_REVOCATION_CACHE_MAX", 5_000, 1);

function parseEnvInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

interface CacheEntry {
  revoked: boolean;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test seam: override the DB-backed revocation lookup. Production
 * code never calls this; tests use it to stub the network/DB layer. */
type LookupFn = (jti: string) => Promise<boolean>;
let lookupOverride: LookupFn | null = null;
export function __setJwtRevocationLookupForTesting(fn: LookupFn | null): void {
  lookupOverride = fn;
  cache.clear();
}

function key(realm: string, jti: string): string {
  return `${realm}:${jti}`;
}

function evictIfFull(): void {
  if (cache.size <= CACHE_MAX) return;
  const overflow = cache.size - CACHE_MAX;
  let removed = 0;
  for (const k of cache.keys()) {
    cache.delete(k);
    removed++;
    if (removed >= overflow) break;
  }
}

export async function isJtiRevoked(realm: "portal" | "provider", jti: string | undefined): Promise<boolean> {
  if (!jti) return false; // Legacy tokens predate jti; treat as not revoked.
  const cacheKey = key(realm, jti);
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.revoked;
  }
  let revoked: boolean;
  if (lookupOverride) {
    revoked = await lookupOverride(jti);
  } else {
    const [row] = await db
      .select({ jti: jwtRevocations.jti })
      .from(jwtRevocations)
      .where(eq(jwtRevocations.jti, jti))
      .limit(1);
    revoked = !!row;
  }
  cache.set(cacheKey, {
    revoked,
    expiresAt: now + (revoked ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
  });
  evictIfFull();
  return revoked;
}

async function insertRevocationClaim(input: {
  realm: "portal" | "provider";
  jti: string;
  expiresAt: Date;
  subjectId?: string | null;
  reason?: string;
}): Promise<boolean> {
  const rows = await db
    .insert(jwtRevocations)
    .values({
      jti: input.jti,
      realm: input.realm,
      subjectId: input.subjectId ?? null,
      reason: input.reason ?? null,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing({ target: jwtRevocations.jti })
    .returning({ jti: jwtRevocations.jti });
  // Invalidate any negative cache entry so the next read sees the
  // revocation immediately on this instance. Other instances pick it
  // up within `NEGATIVE_TTL_MS`.
  cache.set(key(input.realm, input.jti), {
    revoked: true,
    expiresAt: Date.now() + POSITIVE_TTL_MS,
  });
  return rows.length > 0;
}

export async function revokeJti(input: {
  realm: "portal" | "provider";
  jti: string;
  expiresAt: Date;
  subjectId?: string | null;
  reason?: string;
}): Promise<void> {
  await insertRevocationClaim(input);
}

/** Test seam: override the atomic claim used by claimJtiOnce. Production
 * code never calls this; tests use it to stub the DB layer. */
type ClaimFn = (input: {
  realm: "portal" | "provider";
  jti: string;
  expiresAt: Date;
  subjectId?: string | null;
  reason?: string;
}) => Promise<boolean>;
let claimOverride: ClaimFn | null = null;
export function __setJwtRevocationClaimForTesting(fn: ClaimFn | null): void {
  claimOverride = fn;
}

/**
 * Atomically claims a jti for one-time use (e.g. a step-up MFA token).
 * Returns `true` only on the call that actually performs the insert;
 * `false` means the jti was already claimed by an earlier call — the
 * caller should treat this as a replay and reject the request. Race-safe:
 * relies on the `jwt_revocations` primary key, not a read-then-write.
 */
export async function claimJtiOnce(input: {
  realm: "portal" | "provider";
  jti: string;
  expiresAt: Date;
  subjectId?: string | null;
  reason?: string;
}): Promise<boolean> {
  if (claimOverride) return claimOverride(input);
  return insertRevocationClaim(input);
}

/** Test/debug helper. */
export function clearJwtRevocationCache(): void {
  cache.clear();
}

/** Garbage-collect revocation rows whose tokens have already expired.
 * Wire this into a periodic worker if you keep this list around for a
 * long time; not required for correctness. */
export async function cleanupExpiredRevocations(): Promise<number> {
  const { lt } = await import("drizzle-orm");
  const result = await db
    .delete(jwtRevocations)
    .where(lt(jwtRevocations.expiresAt, new Date()))
    .returning({ jti: jwtRevocations.jti });
  return result.length;
}
