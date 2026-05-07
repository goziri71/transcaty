# High-traffic posture (P2)

This document describes the cross-cutting infrastructure changes made to
ready the platform for higher concurrent load. It complements
`docs/MONEY_INVARIANTS.md`, which documents the money-safety guarantees
the application must preserve under the same load.

## 1. PostgreSQL connection pool

The app shares a single `pg.Pool` (see `src/db/index.ts`). Pool sizing
and per-connection timeouts are now environment-driven:

| Env                                | Default | Effect                                       |
| ---------------------------------- | ------: | -------------------------------------------- |
| `DB_POOL_MAX`                      |      20 | Max checked-out clients                      |
| `DB_POOL_IDLE_TIMEOUT_MS`          |  30 000 | Close idle clients after this                |
| `DB_POOL_CONNECTION_TIMEOUT_MS`    |   5 000 | Fail new checkouts after this                |
| `DB_STATEMENT_TIMEOUT_MS`          |  15 000 | Postgres-side `SET statement_timeout`        |
| `DB_QUERY_TIMEOUT_MS`              |  15 000 | pg client-side query deadline                |
| `DB_APPLICATION_NAME`              |   `transacty` | Shows up in `pg_stat_activity`         |

A long-running statement can no longer pin a pool slot indefinitely:
both `statement_timeout` and `query_timeout` are configured per
connection, so Postgres aborts the statement first and pg follows up.

`closeDb()` is now called from `src/server.ts` on `SIGTERM`/`SIGINT` so
the pool drains cleanly during a deploy.

## 2. Redis-backed rate limiting

`@fastify/rate-limit` is registered with the existing `getRedis()`
client when one is configured (see `app.ts`). With multiple app
instances behind a load balancer, a single client cannot evade the
limit by hopping instances.

| Env                  | Default     | Effect                            |
| -------------------- | ----------- | --------------------------------- |
| `RATE_LIMIT_MAX`     | `100`       | Requests per window per IP        |
| `RATE_LIMIT_WINDOW`  | `1 minute`  | Sliding window for the counter    |

When Redis is not configured, the limiter falls back to per-instance
in-memory counters. The boot log line `rate-limit configured` records
which store is in use.

## 3. Provider circuit breaker

`src/lib/provider-circuit-breaker.ts` now exposes an **async API**
(`assertProviderCircuitClosed`, `recordProviderCircuitSuccess`,
`recordProviderCircuitFailure`) that is the canonical way to gate
outbound payment-processor calls.

- The "open until <ts>" decision is published to Redis when configured,
  so a circuit opened on one instance is honored by all peers.
- The local in-process state still tracks the open window, so the hot
  path can short-circuit without an extra Redis round-trip.
- The legacy synchronous helpers
  (`assertCircuitClosed` / `recordProviderSuccess` / `recordProviderFailure`)
  are preserved as in-memory-only fallbacks for callers that cannot
  easily await; new code should use `getProviderCircuit(key)` and pass
  the resulting hooks to `outboundFetch`.

| Env                                       | Default     | Effect                                        |
| ----------------------------------------- | ----------- | --------------------------------------------- |
| `PROVIDER_CIRCUIT_ENABLED`                | `true`      | Master kill switch                            |
| `PROVIDER_CIRCUIT_REDIS`                  | `true`      | Set `false` to skip Redis publishing          |
| `PROVIDER_CIRCUIT_FAILURE_THRESHOLD`      | `5`         | Consecutive failures before opening           |
| `PROVIDER_CIRCUIT_COOLDOWN_MS`            | `60000`     | How long the circuit stays open               |
| `PROVIDER_CIRCUIT_PAYOK_*`                | -           | Per-rail overrides for PayOK                  |
| `PROVIDER_CIRCUIT_TYLT_*`                 | -           | Per-rail overrides for Tylt                   |

## 4. Outbound HTTP hardening

All outbound provider traffic now flows through
`src/lib/outbound-http.ts → outboundFetch()`. The Payok client
(`services/domestic/bangladesh/provider/client.ts`) and the Tylt
fetcher (`services/integrations/tylt/http.ts`) both delegate to it.

What `outboundFetch` provides:

- **Per-call timeouts** via `AbortSignal.timeout(timeoutMs)`. A hung
  upstream cannot occupy a pg-pool slot for minutes.
- **Bounded retries with jitter** on transient transport errors
  (`ECONNRESET`, `ECONNREFUSED`, `EAI_AGAIN`, undici timeouts) and on
  retryable HTTP statuses (`502`, `503`, `504`, `429`). Backoff uses
  decorrelated jitter capped by `OUTBOUND_HTTP_BACKOFF_CAP_MS`.
  `Retry-After` is honored when present.
- **Response body size cap** so a malicious or misbehaving upstream
  cannot exhaust memory.
- **Idempotency-Key forwarding**: create endpoints
  (`payokPayinCreateOrder`, `payokPayoutAccountInquiry`,
  `payokPayoutCreate`, Tylt `createPayinRequest`,
  `createPayoutRequest`, `createInstance`, H2H UPI) now pass
  `merchantOrderId` (= our `transactions.id`) as `Idempotency-Key`.
  Both providers already dedupe on order id; the header is a
  belt-and-braces signal for any provider-side replay guard.
- **Circuit-breaker accounting**: each call site supplies a
  `ProviderCircuit` (from `getProviderCircuit('payok' | 'tylt')`) so
  HTTP 5xx and transport errors trip the breaker uniformly.

| Env                                  | Default        | Effect                                 |
| ------------------------------------ | --------------:| -------------------------------------- |
| `OUTBOUND_HTTP_TIMEOUT_MS`           |      `25000`   | Per-call deadline                      |
| `OUTBOUND_HTTP_RETRIES`              |          `2`   | Retries after the initial try          |
| `OUTBOUND_HTTP_BACKOFF_MS`           |        `200`   | Base backoff before jitter             |
| `OUTBOUND_HTTP_BACKOFF_CAP_MS`       |       `2500`   | Maximum backoff between attempts       |
| `OUTBOUND_HTTP_MAX_RESPONSE_BYTES`   |     `262144`   | Hard cap on response body bytes        |

### Money-safety constraint

`outboundFetch` MUST NOT be called inside a `db.transaction(...)`. Holding
a database transaction open across a network round-trip pins a pg-pool
slot for the duration of the call (and any retries). Money paths
(payouts especially) follow the upfront-debit pattern:

1. In transaction A: lock the wallet, validate balance, insert pending
   transaction, debit the balance.
2. **Outside any transaction**: call the provider via `outboundFetch`.
3. In transaction B (success path) or C (refund path): post the
   terminal status, ledger entries, and credits.

See `docs/MONEY_INVARIANTS.md` for the full guarantees.

## 5. Merchant API key cache

Every authenticated merchant request previously ran:
`SELECT merchant_api_keys WHERE keyHash = ? AND status = 'active'` →
AES-256-GCM decrypt of `secretEnc`. Under load this doubled as a DB
round-trip plus tens of microseconds of crypto on the hot path.

`src/lib/merchant-key-cache.ts` now caches the decrypted key in a
small per-process map keyed by the SHA-256 hash of the API key.

- **Positive entries** (key exists, status = active) are cached for
  `MERCHANT_KEY_CACHE_POSITIVE_TTL_MS` (default 60 000 ms).
- **Negative entries** (key not found / not active) are cached for
  `MERCHANT_KEY_CACHE_NEGATIVE_TTL_MS` (default 5 000 ms) so a flood of
  bad keys cannot hammer the DB.
- The cache is bounded at `MERCHANT_KEY_CACHE_MAX` (default 5 000)
  entries with insertion-order eviction.
- **Revocation invalidation**: `api/portal/api-keys.ts` calls
  `invalidateMerchantApiKeyCache(keyHash)` after marking a key
  revoked, so a freshly-revoked key cannot continue authenticating
  from cache. Multi-instance deployments accept eventual consistency:
  peers will drop the entry within `POSITIVE_TTL_MS`. If you need
  stricter behavior, also invalidate via Redis pub/sub (future work).

| Env                                       | Default | Effect                                          |
| ----------------------------------------- | ------: | ----------------------------------------------- |
| `MERCHANT_KEY_CACHE_ENABLED`              | `true`  | Master kill switch                              |
| `MERCHANT_KEY_CACHE_POSITIVE_TTL_MS`      | `60000` | Positive entry lifetime                         |
| `MERCHANT_KEY_CACHE_NEGATIVE_TTL_MS`      |  `5000` | Negative entry lifetime                         |
| `MERCHANT_KEY_CACHE_MAX`                  |  `5000` | Hard cap on entries                             |

`merchantKeyCacheStats()` exposes hit/miss/eviction counters suitable
for `/metrics` or a debug endpoint.

## Validation

Run the unit tests after any change in this area:

```bash
npm run test:unit
```

The relevant suites are:

- `tests/lib/outbound-http.test.ts` — retry / timeout / size-cap / circuit hooks
- `tests/lib/merchant-key-cache.test.ts` — TTL, invalidation, eviction
- `tests/lib/money.test.ts` — money helpers (P1)

For load regression testing, prefer running the full
`npm run test:integration` suite with a real `DATABASE_URL`; the
concurrency tests in `tests/operations/transfer-concurrency.test.ts`
exercise the transactional money paths.
