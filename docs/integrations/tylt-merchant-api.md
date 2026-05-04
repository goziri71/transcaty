# Tylt merchant API (`/v1/tylt/*`)

All routes require **merchant API key** authentication (`Authorization: Bearer <secret>`) via the same middleware as other `/v1/*` merchant endpoints.

## Error shapes

Responses follow the shared merchant schemas in [`src/lib/merchant-api-zod.ts`](../src/lib/merchant-api-zod.ts):

- **`401`** — `{ error, message? }` (unauthorized).
- **`403`** — `{ error, message? }` (forbidden / missing scope / KYC).
- **`400`** / **`502`** / **`500`** — merchant-facing body may include optional **`code`**, **`transactionId`**, **`platformOrderId`** (never includes upstream processor names or raw upstream payloads).

Proxy **`GET`** handlers declare OpenAPI-oriented response codes **`200`**, **`400`**, **`401`**, **`403`**, **`404`**, **`502`**, **`500`**. Upstream Tylt HTTP statuses are forwarded when they match Transacty validation rules; upstream **`5xx`** is surfaced as **`502`**.

## Idempotency

These **`POST`** endpoints honor **`Idempotency-Key`** (same collision semantics as Bangladesh Payok routes: snapshot stored **24h**, scoped per merchant):

| Route |
|-------|
| `/v1/tylt/crossramp/payin-instances` |
| `/v1/tylt/h2h/payin-instances` |
| `/v1/tylt/cpg/payin-requests` |
| `/v1/tylt/cpg/payout-requests` |
| `/v1/tylt/internal-transfer` |

## Route matrix

| Method | Path | Scope(s) | KYC | Notes |
|--------|------|----------|-----|--------|
| POST | `/v1/tylt/crossramp/payin-instances` | `payin:create` or `*` | If `KYC_REQUIRED=true` | Hosted CrossRamp widget |
| POST | `/v1/tylt/h2h/payin-instances` | `payin:create` or `*` | If required | H2H UPI instance |
| POST | `/v1/tylt/h2h/buyer-confirms-payment` | `payin:create` or `*` | If required | Body: `transactionId`, optional `utr` |
| GET | `/v1/tylt/h2h/payment-methods` | `payin:create` or `*` | — | Proxies Tylt JSON |
| GET | `/v1/tylt/h2h/crypto-currencies` | `payin:create` or `*` | — | Proxies Tylt JSON |
| GET | `/v1/tylt/supported/crypto-currencies` | `balance:read` **or** `payin:create` **or** `payout:create` or `*` | — | Cached lists (`TYLT_DISCOVERY_CACHE_TTL_MS`) |
| GET | `/v1/tylt/supported/fiat-currencies` | same | — | Cached |
| GET | `/v1/tylt/supported/crypto-networks` | same | — | Cached |
| GET | `/v1/tylt/supported/base-currencies` | same | — | Cached |
| GET | `/v1/tylt/account-balance` | `balance:read` or `*` | — | Query passthrough to Tylt; balance cache `TYLT_ACCOUNT_BALANCE_CACHE_TTL_MS` (default off) |
| POST | `/v1/tylt/cpg/payin-requests` | `payin:create` or `*` | If required | Travel-rule `payeeDetails` |
| GET | `/v1/tylt/cpg/payin-information/:transactionId` | `payin:create` or `*` | — | UUID path param |
| GET | `/v1/tylt/cpg/payin-history` | `payin:create` or `*` | — | Query `rows` (1–100), `page` |
| POST | `/v1/tylt/cpg/payout-requests` | `payout:create` or `*` | If required | Debits merchant wallet on success |
| GET | `/v1/tylt/cpg/payout-information/:transactionId` | `payout:create` or `*` | — | UUID path param |
| GET | `/v1/tylt/cpg/payout-history` | `payout:create` or `*` | — | Query `rows`, `page` |
| GET | `/v1/tylt/merchant-details` | `tylt:internal_transfer` or `*` | — | Wallet UUID discovery |
| POST | `/v1/tylt/internal-transfer` | `tylt:internal_transfer` or `*` | If required | Pair allowlist env vars required |

## Zod route schemas

Shared proxy response bundle: [`src/lib/tylt-merchant-api-schemas.ts`](../src/lib/tylt-merchant-api-schemas.ts).

POST bodies/responses for create flows remain declared inline on routes in [`app.ts`](../app.ts) next to handlers (same pattern as Bangladesh `/v1/payins`).

## Webhooks (callbacks)

Callback URLs are **not** under `/v1/` — see [`tylt-integration-spec.md`](./tylt-integration-spec.md) §9 and [`services/integrations/tylt/webhooks.ts`](../services/integrations/tylt/webhooks.ts). Unified optional ingress: **`POST /webhooks/tylt/unified/:environment`**.

## Environment

Merchant key **`environment`** (`test` \| `live`) selects Tylt credentials (`TYLT_*` / `TYLT_TEST_*` / `TYLT_LIVE_*`).
