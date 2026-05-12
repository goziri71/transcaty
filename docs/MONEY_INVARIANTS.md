# Money Invariants

This document captures the rules every wallet/ledger mutation in Transacty must
follow. They were introduced in Phase 1 of the high-traffic readiness program
(see `p1_money_safety_hygiene` plan) and apply to:

- Bangladesh pay-in (`services/domestic/bangladesh/payin.ts`)
- Bangladesh payout (`services/domestic/bangladesh/payout.ts`)
- Internal transfer & refund (`services/operations/transfers.ts`)
- Tylt CrossRamp / CPG pay-in (`services/integrations/tylt/crossramp-payin.ts`,
  `services/integrations/tylt/cpg-payin.ts`)
- Tylt CPG payout (`services/integrations/tylt/cpg-payout.ts`)
- Platform fee posting (`src/lib/billing/fee-applier.ts`)
- Monthly billing (`src/lib/billing/monthly-billing.ts`)

## The three invariants

### 1. Conditional `pending -> terminal` transition

Every status change from `pending` to `success` or `failed` is performed by a
single conditional UPDATE that returns the row only on a real state change:

```sql
UPDATE transactions
SET status = $1, ...
WHERE id = $2 AND status = 'pending'
RETURNING ...;
```

If the UPDATE returns no row, the caller treats it as a no-op and returns
`null`. This makes duplicate provider callbacks safe: the second caller sees no
row and bails out before posting any ledger entry.

### 2. `SELECT ... FOR UPDATE` on every wallet read inside a money transaction

Inside the same `db.transaction(...)` that mutates a wallet, the wallet row is
locked via Drizzle's `.for("update")`. Postgres serialises concurrent attempts
to update the same wallet, so the read-modify-write cycle is atomic.

When a flow touches two wallets (transfers, refunds, fee posting), they are
locked in deterministic order (lowest `wallet.id` first) to avoid deadlocks.

### 3. Money math always goes through `src/lib/money.ts`

Wallet balance and ledger amounts are stored as `decimal(18,2)` in Postgres.
JavaScript `Number` cannot represent every decimal value exactly (`0.1 + 0.2`
is the canonical example), so all arithmetic uses `addAmount`, `subAmount`,
and `cmpAmount` from `src/lib/money.ts`, which operate on `BigInt` cents
internally. `toCents` strictly validates the input (no `NaN`, no `Infinity`,
no scientific notation, at most two decimal places).

Helpers:

- `toCents(amount: string): bigint`
- `fromCents(cents: bigint): string`
- `addAmount(a, b)`, `subAmount(a, b)`, `cmpAmount(a, b)`, `gteAmount(a, b)`
- `assertPositive(amount)` — throws if amount is zero, negative, or malformed.
- `assertNonNegative(amount)` — allows zero, throws on negatives or malformed.

## Composition rule for fee posting

`tryApplyTransactionFee(input, parentTx?)` and the underlying
`applyTransactionFee(input, parentTx?)` accept an optional Drizzle transaction
handle. Pay-in / payout success paths run inside their own `db.transaction`
and pass the handle in, so the fee posting and the success transition commit
or roll back atomically together. Standalone calls (none today, but supported)
open their own internal transaction.

## No outbound HTTP inside money transactions

Network calls to providers (Payok, Tylt) MUST happen outside any
`db.transaction(...)` block. A hung provider would otherwise hold wallet row
locks indefinitely and cascade into pool exhaustion.

For payouts this means the wallet is debited up front in transaction #1, the
provider HTTP call happens with no locks held, and a second transaction either
records the provider's `externalId` on success or refunds the debit on
failure. The conditional `WHERE status = 'pending'` clause makes both the
refund and the eventual webhook handler safe against arriving in either order.

## Outbound webhook delivery

`queueMerchantWebhook` enqueues a pg-boss job; merchant webhook delivery never
runs inside a money transaction. The audit log call is also issued after the
transaction commits.

## Tests

- `tests/lib/money.test.ts` — unit tests covering the helper.
- `tests/domestic/payin-callback.test.ts` — integration test: duplicate
  provider callbacks credit the wallet exactly once.
- `tests/operations/transfer-concurrency.test.ts` — integration test: 10
  parallel transfers against a 200.00 wallet succeed exactly six times.
- `tests/integration/webhook-events.test.ts` — duplicate webhook
  payloads are absorbed by the `webhook_events.dedupe_hash` unique
  index (P3 belt-and-braces dedupe).
- `tests/integration/transactions-provider-uniqueness.test.ts` — the
  partial unique index on `(provider, environment, external_id)`
  rejects duplicate provider order ids while still allowing the same
  id under a different rail or environment (P3 D2).
- `tests/integration/ledger-immutability.test.ts` — UPDATE/DELETE on
  `ledger_entries` is rejected by the database trigger (P3 D3).
- `tests/integration/idempotency-integration.test.ts` — same-key
  same-body requests collapse to one upstream call; same-key
  different-body returns a 409 conflict (P3 D4).

Integration tests skip themselves when no `DATABASE_URL` (or
`DATABASE_URL_ENC` + `ENCRYPTION_MASTER_KEY`) is present in the environment.
Run them against a disposable Postgres only; they create and clean up their
own merchant/wallet/ledger rows but should not be pointed at production data.

Scripts:

- `npm run test` — all tests (unit + integration + Tylt unit tests).
- `npm run test:unit` — unit tests only (no DB needed).
- `npm run test:integration` — money + correctness integration tests
  (DB required; covers domestic, operations, and `tests/integration/`).
- `npm run test:tylt` — pre-existing Tylt parser/signature tests.

## Related invariants

- `docs/HIGH_TRAFFIC_POSTURE.md` — pool, breaker, outbound HTTP, key
  cache (P2).
- `docs/WEBHOOK_DEDUPE_AND_IDEMPOTENCY.md` — webhook_events,
  transactions provider uniqueness, ledger immutability, and request
  idempotency body-hash semantics (P3).
- `docs/AUTH_HARDENING.md` — `PROVIDER_API_KEY` downgrade,
  constant-time login, JWT `iss`/`aud`/`jti` + revocation, step-up MFA
  on `wallet.adjust` and `tx.status.write` (P4).
- `docs/TYLT_MERCHANT_API_TESTING.md` — merchant HMAC auth, Postman setup,
  and step-by-step Tylt `/v1` flows (CrossRamp, H2H, CPG, internal transfer).
