/**
 * Per-process cache for merchant API key lookups + AES-decrypted secrets.
 *
 * Why this exists: every authenticated merchant request runs the same
 * pipeline — `SELECT merchant_api_keys WHERE keyHash = ? AND status = 'active'`
 * followed by an AES-256-GCM decrypt of `secretEnc`. Under load that
 * doubles as a DB round-trip + ~100µs of crypto on the hot path. A small
 * TTL cache eliminates that work for repeat callers in the common case
 * where a single merchant signs many requests in a window.
 *
 * Design notes:
 * - Keyed by the SHA-256 hash of the API key, NOT the API key itself.
 *   That makes the cache safe to inspect or dump without leaking secrets,
 *   though we still treat the cache as sensitive and never serialize it.
 * - Positive entries (key exists + active) are cached for
 *   `MERCHANT_KEY_CACHE_POSITIVE_TTL_MS` (default 60s).
 * - Negative entries (key not found OR not active) are cached for a
 *   shorter window of `MERCHANT_KEY_CACHE_NEGATIVE_TTL_MS` (default 5s)
 *   so a flood of bad keys cannot hammer the DB. We do not reflect 4xx
 *   responses out of the cache; auth-layer rejection still happens at
 *   the call site.
 * - Cache size capped at `MERCHANT_KEY_CACHE_MAX` (default 5000) entries
 *   with a simple LRU-by-insertion-order eviction. This is per-process
 *   memory; multi-instance deployments accept eventual consistency on
 *   key revocation within the positive TTL.
 * - Revocation/rotation paths must call {@link invalidateMerchantApiKeyCache}
 *   so a freshly-revoked key cannot continue authenticating from cache.
 */

const POSITIVE_TTL_MS = parseEnvInt("MERCHANT_KEY_CACHE_POSITIVE_TTL_MS", 60_000, 0);
const NEGATIVE_TTL_MS = parseEnvInt("MERCHANT_KEY_CACHE_NEGATIVE_TTL_MS", 5_000, 0);
const MAX_ENTRIES = parseEnvInt("MERCHANT_KEY_CACHE_MAX", 5_000, 16);
const ENABLED = (() => {
  const v = process.env.MERCHANT_KEY_CACHE_ENABLED?.trim().toLowerCase();
  if (v === "false" || v === "0") return false;
  return true;
})();

function parseEnvInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

export interface MerchantKeyCacheValue {
  /** UUID of the key row. */
  keyId: string;
  /** UUID of the owning merchant. */
  merchantId: string;
  /** Comma-separated scopes from the DB row, lazily split when consumed. */
  scopes: string[];
  /** "live" | "test". */
  environment: "live" | "test";
  /** AES-decrypted plaintext HMAC secret. Treat as sensitive. */
  secret: string;
}

type Entry =
  | { kind: "hit"; expiresAt: number; value: MerchantKeyCacheValue }
  | { kind: "miss"; expiresAt: number };

const cache = new Map<string, Entry>();
let hits = 0;
let misses = 0;
let negative = 0;
let evictions = 0;

function now(): number {
  return Date.now();
}

function evictIfNeeded(): void {
  if (cache.size <= MAX_ENTRIES) return;
  // Map iteration order is insertion order. Evict the oldest entries
  // until we are back under the cap. This is not strict LRU — we don't
  // re-promote on read — but it bounds memory cheaply.
  const overflow = cache.size - MAX_ENTRIES;
  let removed = 0;
  for (const key of cache.keys()) {
    if (removed >= overflow) break;
    cache.delete(key);
    removed++;
  }
  evictions += removed;
}

/** Look up a cached entry, returning `undefined` when there is no usable
 * entry (either no entry, or expired, or caching disabled). */
export function getMerchantKeyCache(keyHash: string): Entry | undefined {
  if (!ENABLED) return undefined;
  const e = cache.get(keyHash);
  if (!e) return undefined;
  if (e.expiresAt <= now()) {
    cache.delete(keyHash);
    return undefined;
  }
  if (e.kind === "hit") hits++;
  else negative++;
  return e;
}

export function setMerchantKeyCacheHit(
  keyHash: string,
  value: MerchantKeyCacheValue
): void {
  if (!ENABLED || POSITIVE_TTL_MS <= 0) return;
  cache.set(keyHash, { kind: "hit", expiresAt: now() + POSITIVE_TTL_MS, value });
  evictIfNeeded();
}

export function setMerchantKeyCacheMiss(keyHash: string): void {
  if (!ENABLED || NEGATIVE_TTL_MS <= 0) return;
  cache.set(keyHash, { kind: "miss", expiresAt: now() + NEGATIVE_TTL_MS });
  evictIfNeeded();
  misses++;
}

/** Drop a cached entry. Call after the underlying key row is revoked,
 * rotated, or otherwise mutated. Safe to call with an unknown hash. */
export function invalidateMerchantApiKeyCache(keyHash: string): void {
  cache.delete(keyHash);
}

/** Wipe everything. Safe to call from tests; rarely needed in prod. */
export function clearMerchantKeyCache(): void {
  cache.clear();
}

/** Current cache statistics. Intended for /metrics or debug endpoints. */
export function merchantKeyCacheStats(): {
  size: number;
  hits: number;
  misses: number;
  negative: number;
  evictions: number;
  enabled: boolean;
  positiveTtlMs: number;
  negativeTtlMs: number;
} {
  return {
    size: cache.size,
    hits,
    misses,
    negative,
    evictions,
    enabled: ENABLED,
    positiveTtlMs: POSITIVE_TTL_MS,
    negativeTtlMs: NEGATIVE_TTL_MS,
  };
}
