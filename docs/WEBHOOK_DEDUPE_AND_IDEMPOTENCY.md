# Webhook dedupe and request idempotency (P3)

This document describes the database-enforced correctness guarantees
introduced in Phase 3 of the high-traffic readiness program. They
complement the application-level invariants in `MONEY_INVARIANTS.md`.

There are four moving parts:

1. `webhook_events` — provider callback dedupe.
2. `transactions(provider, environment, external_id)` partial unique
   index — duplicate transaction rows for the same provider order id
   are rejected at the storage layer.
3. `ledger_entries` immutability trigger — UPDATE/DELETE on the audit
   ledger is rejected by Postgres.
4. `idempotency_keys.body_hash` + `status` — merchant `Idempotency-Key`
   handling now claims the slot before any upstream call and rejects
   key reuse with a different body.

## 1. webhook_events

Every provider callback that **passes signature verification** is
written to `webhook_events`. The unique index on `dedupe_hash`
(= `sha256(rail || environment || raw_body)`) guarantees that a replay
from the provider is absorbed by the database, so the apply function
runs at most once per logical event.

Failed-signature requests are NOT persisted — that would let an
unauthenticated client write to our database. The rate limiter (P2) and
log redaction (P1) handle flood control.

### Helper API

```ts
import {
  tryClaimWebhookEvent,
  markWebhookProcessed,
  markWebhookFailed,
} from "src/lib/webhook-events";

const claim = await tryClaimWebhookEvent({
  rail: "payok-bd-payin",
  environment: "test",
  rawBody,
  signature,
  signatureValid: true,
  externalId: providerOrderId, // optional, best-effort
});

if (claim.kind === "duplicate") {
  // Provider replay; do NOT run the apply function.
  return ack(reply);
}

try {
  const result = await applyTheCallback(body);
  await markWebhookProcessed(claim.eventId, {
    transactionId: result?.transactionId ?? null,
  });
} catch (err) {
  await markWebhookFailed(claim.eventId, err);
  throw err;
}
```

### Rails

| Rail label             | Source                                     |
| ---------------------- | ------------------------------------------ |
| `payok-bd-payin`       | `/webhooks/payok/payin`                    |
| `payok-bd-payout`      | `/webhooks/payok/payout`                   |
| `tylt-crossramp`       | `/webhooks/tylt/crossramp/:environment`    |
| `tylt-h2h-upi`         | `/webhooks/tylt/h2h/:environment`          |
| `tylt-cpg-payin`       | `/webhooks/tylt/cpg-payin/:environment`    |
| `tylt-cpg-payout`      | `/webhooks/tylt/cpg-payout/:environment`   |
| `tylt-unified`         | `/webhooks/tylt/unified/:environment`      |

### Operations

The table is unbounded by design (it's an audit log). When operating at
scale, vacuum policy and a periodic archival/delete of rows older than
~90 days is recommended; that work is intentionally out of scope here.
The `attempts` text column captures how many times the same dedupe hash
was retried by the provider — useful for spotting misbehaving sources.

## 2. transactions(provider, environment, external_id) partial unique index

`transactions.provider` is a new column populated at every insert site
(`payok-bd-payin`, `payok-bd-payout`, `tylt-cpg-payin`,
`tylt-cpg-payout`, `tylt-crossramp`, `tylt-h2h-upi`, `tylt-internal`,
`internal-transfer`, `internal-refund`).

A partial unique index enforces:

```sql
UNIQUE (provider, environment, external_id)
WHERE provider IS NOT NULL AND external_id IS NOT NULL
```

Implications:

- A duplicate provider callback that races our own retry can't create a
  second row for the same `external_id` under the same provider and
  environment. The duplicate insert hits a 23505 error.
- Same `external_id` under a different provider is allowed (different
  processors carry independent id namespaces).
- Same `provider` + `external_id` in a different environment is allowed
  (test vs live).
- Rows still in flight (no `external_id` yet) and legacy rows without a
  `provider` value are excluded from the index, so we can keep creating
  pending records before the upstream returns.

## 3. Ledger immutability trigger

`drizzle/0017_ledger_immutability.sql` installs:

```sql
CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE ON ledger_entries ...
CREATE TRIGGER ledger_entries_no_delete BEFORE DELETE ON ledger_entries ...
```

Both invoke `enforce_ledger_immutability()`, which raises
`'ledger_entries is append-only'` unless the session variable
`app.allow_ledger_mutation` is set to `'true'`. In production the
variable is never set; routine application code does not need it.

The migration also drops the `ON DELETE CASCADE` on
`ledger_entries.wallet_id` and replaces it with `ON DELETE RESTRICT`,
so a wallet cannot be deleted while it has audit rows.

### Manual data fixes (DBA-only)

Use the escape hatch only inside an explicit transaction so the
override is scoped:

```sql
BEGIN;
SET LOCAL app.allow_ledger_mutation = 'true';
-- careful, audited mutation here
UPDATE ledger_entries SET ... WHERE ...;
COMMIT;
```

`SET LOCAL` is auto-cleared at COMMIT/ROLLBACK and never leaks past the
session.

## 4. Tightened request idempotency

Prior behavior had two correctness gaps:

1. **Concurrent same-key requests** could both invoke the upstream
   provider because the snapshot was only persisted *after* the work
   finished.
2. **Same key, different body** would silently return the cached
   response from the original request.

`src/lib/idempotency.ts` introduces:

```ts
runIdempotent({ key, merchantId, body, ttlMs }, async () => { ... })
withIdempotency({ request, reply, merchantId, body }, async () => { ... })
```

Algorithm:

1. INSERT…ON CONFLICT DO NOTHING into `idempotency_keys` with
   `status='in_progress'` and `body_hash=sha256(canonical(body))`.
2. **Insert succeeded** → run the work. On success persist the snapshot
   and set `status='completed'`. On failure delete our claim so the
   client can retry.
3. **Insert conflicted** → fetch the existing row.
   - `body_hash` differs → return `{ kind: "conflict", reason: "body_mismatch" }`. The Fastify wrapper sends 409.
   - `status='completed'` → return `{ kind: "replay", result }` from the persisted snapshot.
   - `status='in_progress'` → return `{ kind: "conflict", reason: "in_progress" }`. The Fastify wrapper sends 409 with a "retry shortly" hint.

### Wired routes

All v1 mutation endpoints now flow through `withIdempotency`:

- `POST /v1/payins` (Payok pay-in)
- `POST /v1/payouts` (Payok payout)
- `POST /v1/crossramp/payin-instances` (legacy `POST /v1/tylt/crossramp/payin-instances`)
- `POST /v1/h2h/payin-instances` (legacy `.../v1/tylt/...`)
- `POST /v1/cpg/payin-requests` (legacy `.../v1/tylt/...`)
- `POST /v1/cpg/payout-requests` (legacy `.../v1/tylt/...`)
- `POST /v1/internal-transfer` (legacy `.../v1/tylt/...`)

### Schema additions

`idempotency_keys` gains:

| Column           | Type        | Default        | Purpose                                           |
| ---------------- | ----------- | -------------- | ------------------------------------------------- |
| `body_hash`      | text        | `''`           | SHA-256 of canonical request body                 |
| `status`         | text        | `'completed'`  | `'in_progress'` (claimed) or `'completed'` (done) |
| `updated_at`     | timestamptz | `now()`        | When the snapshot was last persisted              |

`response_snapshot` is now defaulted to `''` so an in-progress claim
can exist before any snapshot is written.

## Validation

```bash
npm run test:unit         # canonicalStringify + computeBodyHash etc.
npm run test:integration  # webhook dedupe, ledger immutability, idempotency, transactions(provider, ...) uniqueness
```

The integration tests are gated on a reachable `DATABASE_URL` and skip
silently otherwise.
