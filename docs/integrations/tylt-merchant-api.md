# Cross-border merchant API (Transacty `/v1/*`)

**Public merchant paths** omit the processor name (e.g. `/v1/cpg`, `/v1/h2h`). **India UPI pay-in** on the merchant API is **H2H only** (`/v1/h2h/...`); **`POST /v1/crossramp/payin-instances`** is **not** registered (hosted widget / `rampUrl` create is out of scope for `/v1`). Legacy **`/v1/tylt/...`** URLs remain aliases where handlers exist.

**Rail boundary:** All routes in this document are implemented under **`services/integrations/tylt/`** and **TL Pay** upstream (`TYLT_*` env, `/webhooks/tylt/...`). They do **not** use Payok (`services/domestic/bangladesh/`, `/webhooks/payok/...`). Bangladesh domestic APIs are documented separately.

All routes require **merchant HMAC** (`X-Transacty-Key`, `X-Transacty-Timestamp`, `X-Transacty-Signature`) like other `/v1/*` merchant endpoints (`docs/POSTMAN_MERCHANT_API_GUIDE.md`).

## Error shapes

Responses follow the shared merchant schemas in [`src/lib/merchant-api-zod.ts`](../src/lib/merchant-api-zod.ts):

- **`401`** — `{ error, message? }` (unauthorized).
- **`403`** — `{ error, message? }` (forbidden / missing scope / KYC).
- **`400`** — validation or partner rejection; may include **`code: "payment_provider_rejected"`** and a clear **`message`** (limits, KYC, confirm timing) when TL Pay returns a 4xx with text. Still no raw upstream payloads or secrets.
- **`502`** / **`500`** — merchant-facing body may include optional **`code`**, **`transactionId`**, **`platformOrderId`** (never includes raw upstream payloads or secrets). OpenAPI-oriented response codes **`200`**, **`400`**, **`401`**, **`403`**, **`404`**, **`502`**, **`500`**. Upstream Tylt HTTP statuses are forwarded when they match Transacty validation rules; upstream **`5xx`** is surfaced as **`502`**.

## Idempotency

These **`POST`** endpoints honor **`Idempotency-Key`** (snapshot stored **24h**, scoped per merchant; same collision semantics as other `/v1` POST routes):

| Route |
|-------|
| `/v1/h2h/payin-instances` |
| `/v1/cpg/payin-requests` |
| `/v1/cpg/payout-requests` |
| `/v1/internal-transfer` |

## Route matrix

| Method | Path | Scope(s) | KYC | Notes |
|--------|------|----------|-----|--------|
| POST | `/v1/h2h/payin-instances` | `payin:create` or `*` | If required | H2H UPI instance (India pay-in on `/v1`) |
| POST | `/v1/h2h/buyer-confirms-payment` | `payin:create` or `*` | If required | Body: `transactionId`, **`utr`** (required; TL Pay `isUTRNeeded: 1` on create) |
| GET | `/v1/h2h/payment-methods` | `payin:create` or `*` | — | Proxies TL Pay JSON |
| GET | `/v1/h2h/crypto-currencies` | `payin:create` or `*` | — | Proxies TL Pay JSON |
| GET | `/v1/h2h/conversion-rates` | `payin:create` or `*` | — | Proxies TL Pay JSON |
| GET | `/v1/transactions/:transactionId` | Merchant key | — | Transacty row (any provider); use for H2H status polling |
| GET | `/v1/supported/crypto-currencies` | `balance:read` **or** `payin:create` **or** `payout:create` or `*` | — | Cached lists (`TYLT_DISCOVERY_CACHE_TTL_MS`) |
| GET | `/v1/supported/fiat-currencies` | same | — | Cached |
| GET | `/v1/supported/crypto-networks` | same | — | Cached |
| GET | `/v1/supported/base-currencies` | same | — | Cached |
| GET | `/v1/account-balance` | `balance:read` or `*` | — | Query passthrough to Tylt; balance cache `TYLT_ACCOUNT_BALANCE_CACHE_TTL_MS` (default off) |
| POST | `/v1/cpg/payin-requests` | `payin:create` or `*` | If required | Travel-rule `payeeDetails` |
| GET | `/v1/cpg/payin-information/:transactionId` | `payin:create` or `*` | — | UUID path param |
| GET | `/v1/cpg/payin-history` | `payin:create` or `*` | — | Query `rows` (1–100), `page` |
| POST | `/v1/cpg/payout-requests` | `payout:create` or `*` | If required | Debits merchant wallet on success |
| GET | `/v1/cpg/payout-information/:transactionId` | `payout:create` or `*` | — | UUID path param |
| GET | `/v1/cpg/payout-history` | `payout:create` or `*` | — | Query `rows`, `page` |
| GET | `/v1/merchant-details` | `internal_transfer:create` or `*` (legacy `tylt:internal_transfer`) | — | Wallet UUID discovery |
| POST | `/v1/internal-transfer` | `internal_transfer:create` or `*` (legacy `tylt:internal_transfer`) | If required | Pair allowlist env vars required |

## Zod route schemas

Shared proxy response bundle: [`src/lib/tylt-merchant-api-schemas.ts`](../src/lib/tylt-merchant-api-schemas.ts).

POST bodies/responses for create flows remain declared inline on routes in [`app.ts`](../app.ts) next to handlers (same pattern as Bangladesh `/v1/payins`).

## Webhooks (callbacks)

Callback URLs are **not** under `/v1/` — see [`tylt-integration-spec.md`](./tylt-integration-spec.md) §9 and [`services/integrations/tylt/webhooks.ts`](../services/integrations/tylt/webhooks.ts). Unified optional ingress: **`POST /webhooks/tylt/unified/:environment`**.

## Environment

Merchant key **`environment`** (`test` \| `live`) selects which **Tylt credential set** is used for that request.

Tylt issues **separate API key + secret per enabled service**. Transacty maps that to two roles:

| Role | Tylt usage in this repo |
|------|-------------------------|
| **Pay-in** | H2H UPI, CPG pay-in, CrossRamp, supported-currency/network discovery, account balance, internal transfer, merchant details; webhooks **`/webhooks/tylt/h2h`**, **`crossramp`**, **`cpg-payin`**. |
| **Pay-out** | CPG payout create/history/info; webhook **`/webhooks/tylt/cpg-payout`**. |

**Env vars (plain or `*_ENC`) — recommended lane split:**

- **India pay-in (test):** `TYLT_TEST_INDIA_PAYIN_API_KEY`, `TYLT_TEST_INDIA_PAYIN_API_SECRET`, optional `TYLT_TEST_INDIA_PAYIN_BASE_URL`
- **India pay-out (test):** `TYLT_TEST_INDIA_PAYOUT_*` — CPG payout, India payout webhooks
- **EU pay-in (test):** `TYLT_TEST_EUR_PAYIN_*` — Prime Fiat pay-in, `/webhooks/tylt/eur-payin/*`
- **EU pay-out (test):** `TYLT_TEST_EUR_PAYOUT_*` — EUR bank payout, `/webhooks/tylt/eur-payout/*`
- **Live:** same pattern with `TYLT_LIVE_INDIA_*` / `TYLT_LIVE_EUR_*`

**Fallback (backward compatible):** per profile, `TYLT_{TEST|LIVE}_{EUR|INDIA}_{PAYIN|PAYOUT}_*` → `TYLT_{TEST|LIVE}_{PAYIN|PAYOUT}_*` → `TYLT_{TEST|LIVE}_*` → `TYLT_*` (default base `https://api.tylt.money`).

**Unified webhook** (`POST /webhooks/tylt/unified/:environment`) tries EU then India pay-in secrets, then pay-out secrets, then generic `PAYIN_` / `PAYOUT_` fallbacks.
