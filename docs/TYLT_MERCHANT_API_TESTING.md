# Tylt merchant API — testing guide (Postman & flows)

This document is for **operators and integrators** who expose Transacty as **API-as-a-service** to merchants. Merchants call **your** Transacty `/v1/*` endpoints; Transacty authenticates them and calls **Tylt** with server-side credentials.

- **Merchant → Transacty:** HMAC-signed HTTP (this guide).
- **Tylt → Transacty:** Webhooks to `/webhooks/tylt/...` (not called from Postman; needs a public URL for real E2E).

Related: environment variables for Tylt are listed in `.env.example` (`TYLT_*`, `TYLT_TEST_*`, `TYLT_LIVE_*`, `TYLT_ALLOW_KYC_BYPASS`).

---

## 1. Prerequisites

| Requirement | Notes |
|-------------|--------|
| Transacty base URL | e.g. `https://api.example.com` or `http://localhost:3000` for local dev. |
| Tylt credentials on the server | `TYLT_API_KEY` / `TYLT_API_SECRET` (or per-environment `TYLT_TEST_*` / `TYLT_LIVE_*`). |
| Merchant account | Created via portal signup or a seed script. |
| Merchant API key | Created in portal; note **public key** + **secret** (secret is shown once). |
| Key **environment** | `test` or `live` on the key row must match the Tylt credentials you expect for that traffic. |
| Scopes on the key | See [§6 Route reference](#6-route-reference). Use `*` only in non-production sandboxes. |
| KYC gate | If `KYC_REQUIRED=true`, merchant `kycStatus` must be **`verified`** or Tylt **create** routes return `403` with `KYC verification required`. |
| Optional merchant webhook | `PATCH /v1/me/webhook` so Transacty can POST events to the merchant’s own URL when transactions change. |

---

## 2. Authentication (every `/v1/*` request)

All routes under **`/v1/`** go through **merchant HMAC** verification.

### Headers

| Header | Description |
|--------|-------------|
| `X-Transacty-Key` | The merchant’s **public** API key string. |
| `X-Transacty-Timestamp` | Unix time in **seconds** (integer as string). Must be within **±5 minutes** of the server clock. |
| `X-Transacty-Signature` | **Lowercase hex** HMAC-SHA256 of the signing payload, using the API **secret**. |

### Signing payload

```
{timestamp}.{rawBody}
```

- **`timestamp`** — same value as `X-Transacty-Timestamp` (string).
- **`rawBody`** — the **exact** raw HTTP body bytes for this request. For **GET** (no body), `rawBody` is empty: sign `{timestamp}.` (note the trailing dot).

### Rules that break Postman if ignored

1. **Body must not change after signing.** Use **Body → raw → JSON**. Any edit after generating the signature invalidates the signature.
2. **Clock skew:** fix your machine clock or NTP if you see “timestamp expired”.
3. **`Idempotency-Key`** (optional on POST): does **not** participate in the HMAC string; only `timestamp` + raw body do.

### Idempotency (POST create endpoints)

If the client sends **`Idempotency-Key`**:

- Same key + **same** JSON body → same response as the first successful completion (**replay**).
- Same key + **different** body → **409** `Idempotency conflict` (`body_mismatch`).
- Concurrent duplicate keys while work is running → **409** (`in_progress`).

If **`Idempotency-Key` is omitted**, each POST runs without an idempotency slot (safe retries are the client’s responsibility).

---

## 3. Postman setup

### 3.1 Collection variables (suggested)

| Variable | Example |
|----------|---------|
| `baseUrl` | `https://api.example.com` |
| `merchantKey` | Public key from portal |
| `merchantSecret` | Secret from portal (store in **secret** type in Postman) |
| `idempotencyKey` | UUID; change per *logical* operation, reuse only when retrying the **same** body |

### 3.2 Pre-request script (HMAC)

Add this to the **collection** or **folder** that contains all `/v1` requests so every request gets fresh `timestamp` + `signature`.

**Requirements:** Postman’s `crypto` module is available in the sandbox.

```javascript
const secret = pm.collectionVariables.get("merchantSecret");
const key = pm.collectionVariables.get("merchantKey");
if (!secret || !key) {
  throw new Error("Set collection variables merchantSecret and merchantKey");
}

const ts = Math.floor(Date.now() / 1000).toString();
let rawBody = "";
try {
  rawBody = pm.request.body && pm.request.body.raw ? pm.request.body.raw : "";
} catch (e) {
  rawBody = "";
}

const payload = ts + "." + rawBody;
const sig = CryptoJS.HmacSHA256(payload, secret).toString(CryptoJS.enc.Hex);

pm.request.headers.upsert({ key: "X-Transacty-Key", value: key });
pm.request.headers.upsert({ key: "X-Transacty-Timestamp", value: ts });
pm.request.headers.upsert({ key: "X-Transacty-Signature", value: sig });
```

> **Note:** Postman’s default might not include `crypto-js`. If `CryptoJS` is undefined, use **Postman → Settings → Experimental → Crypto** or install the **CryptoJS** snippet from Postman learning center, or compute the signature with an external script and paste `X-Transacty-Signature` manually for one-off tests.

Alternative: use ** Newman ** or a tiny Node script with `createHmac("sha256", secret).update(payload).digest("hex")` — same algorithm as production.

### 3.3 Optional: Idempotency header

On POST requests that support it, add:

```
Idempotency-Key: {{$guid}}
```

Or bind to `{{idempotencyKey}}` and reuse that variable only when **retrying the identical body**.

---

## 4. Smoke tests (do this first)

| Step | Method | Path | Body | Expect |
|------|--------|------|------|--------|
| A | GET | `/health` | — | No merchant auth. `200` if app + deps healthy. |
| B | GET | `/v1/me` | empty (sign `ts.`) | `200` → `merchantId`, `scopes`, `environment`. |

If **B** fails with `401` / `Invalid signature`, fix signing or body mismatch before any Tylt route.

---

## 5. Amount limits (enforced before Tylt)

| Flow | Field | Bounds (app-level) |
|------|--------|---------------------|
| CrossRamp / H2H pay-in | `amount` + `currencySymbol` | **USDT:** 1 … 500_000. **INR:** 200 … 500_000. |
| CPG pay-in | `baseAmount` (float) | `1e-8` … `1e15` (sanity bounds). |
| CPG payout | `amount` | `1e-8` … `1e15`. |
| Internal transfer | `settledAmount` | `1e-8` … `1e15`. |

---

## 6. Route reference

All paths below are under **`{{baseUrl}}`**. All require **HMAC** unless noted.

### Discovery & balance (GET)

| Path | Scope (typical) |
|------|-----------------|
| `GET /v1/tylt/supported/crypto-currencies` | `balance:read` **or** `payin:create` **or** `payout:create` **or** `*` |
| `GET /v1/tylt/supported/fiat-currencies` | same |
| `GET /v1/tylt/supported/crypto-networks` | same |
| `GET /v1/tylt/supported/base-currencies` | same |
| `GET /v1/tylt/account-balance?...` | `balance:read` (query forwarded to Tylt) |
| `GET /v1/tylt/h2h/payment-methods` | `payin:create` or `*` |
| `GET /v1/tylt/h2h/crypto-currencies` | `payin:create` or `*` |

Sign with **empty body** (`timestamp.` only).

### CrossRamp pay-in

| Method | Path | Scope |
|--------|------|--------|
| POST | `/v1/tylt/crossramp/payin-instances` | `payin:create` or `*` |

**JSON body:**

| Field | Required | Notes |
|-------|----------|--------|
| `amount` | yes | String decimal, within [§5](#5-amount-limits-enforced-before-tylt) for `currencySymbol`. |
| `currencySymbol` | yes | `USDT` or `INR`. |
| `returnUrl` | yes | **HTTPS** in production, or **http** only for `localhost` / `127.0.0.1` / `[::1]`. Max length 200. No userinfo in URL. |
| `userEmail` | no | Valid email if present. |

**Response (200):** `transactionId`, `status: "pending"`, `amount`, `currency`, `instanceId`, **`rampUrl`**, optional `expiresAt`.

**Flow:** Postman creates session → open **`rampUrl`** in a browser for the payer → Tylt sends webhook to Transacty → merchant polls **`GET /v1/transactions`** or receives **merchant webhook** (if configured).

### H2H UPI pay-in

| Method | Path | Scope |
|--------|------|--------|
| POST | `/v1/tylt/h2h/payin-instances` | `payin:create` or `*` |
| POST | `/v1/tylt/h2h/buyer-confirms-payment` | `payin:create` or `*` |

**Create body:** `amount`, `currencySymbol` (`USDT` | `INR`), optional `returnUrl` (validated if set), optional `userEmail`.

**Create response:** `transactionId`, `instanceId`, **`paymentDetails`** (object — payment instructions from Tylt).

**Confirm body:** `transactionId` (UUID from create), optional `utr`.

**Flow:** Create → show `paymentDetails` to payer → payer pays UPI → **`buyer-confirms-payment`** → webhooks → poll transactions / merchant webhook.

### CPG pay-in

| Method | Path | Scope |
|--------|------|--------|
| POST | `/v1/tylt/cpg/payin-requests` | `payin:create` or `*` |
| GET | `/v1/tylt/cpg/payin-information/:transactionId` | `payin:create` or `*` |
| GET | `/v1/tylt/cpg/payin-history?rows=20&page=1` | `payin:create` or `*` |

**POST body:**

| Field | Required |
|-------|----------|
| `baseAmount` | yes (string) |
| `baseCurrency` | yes |
| `settledCurrency` | yes |
| `networkSymbol` | yes |
| `payeeDetails` | yes — non-empty object (shape per Tylt product docs) |
| `settleUnderpayment` | no — `0` or `1` if used |

**Response:** `transactionId`, `status: "pending"`, `amount`, `currency`, `platformOrderId` (nullable).

**Flow:** POST create → GET pay-in information for deposit instructions → user sends on-chain / per Tylt → webhook → poll / merchant webhook.

### CPG payout

| Method | Path | Scope |
|--------|------|--------|
| POST | `/v1/tylt/cpg/payout-requests` | `payout:create` or `*` |
| GET | `/v1/tylt/cpg/payout-information/:transactionId` | `payout:create` or `*` |
| GET | `/v1/tylt/cpg/payout-history?rows=20&page=1` | `payout:create` or `*` |

**POST body:** `amount`, `settledCurrency`, `networkSymbol`, **`destinationDetails`** (required non-empty object).

**Important:** Transacty **debits the merchant wallet** (same environment as the API key) when the create path succeeds at the persistence layer, then calls Tylt. Ensure **sufficient balance** in that currency before testing.

### Tylt internal transfer

| Method | Path | Scope |
|--------|------|--------|
| GET | `/v1/tylt/merchant-details` | `tylt:internal_transfer` or `*` |
| POST | `/v1/tylt/internal-transfer` | `tylt:internal_transfer` or `*` |

**POST body:** `fromUUID`, `toUUID` (Tylt UUIDs), `settledAmount`, `settledCurrency`, optional `comments`.

Use **merchant-details** (or Tylt’s own admin UI) to discover UUIDs acceptable to Tylt.

---

## 7. `returnUrl` rules (CrossRamp & PayOK-style flows)

- Must be a valid **absolute** URL.
- **HTTPS** required except **http** allowed for `localhost`, `127.0.0.1`, `[::1]`.
- No `username:password@` in the URL.
- Max **200** characters (enforced for PayOK parity; CrossRamp uses the same validator).

---

## 8. Webhooks — what Postman does *not* cover

| Direction | Who calls whom |
|-----------|----------------|
| **Tylt → Transacty** | Tylt POSTs to your deployed paths, e.g. `/webhooks/tylt/crossramp/:environment`, `/webhooks/tylt/h2h/:environment`, `/webhooks/tylt/cpg-payin/:environment`, `/webhooks/tylt/cpg-payout/:environment`, and optionally `/webhooks/tylt/unified/:environment`. These URLs must be **publicly reachable** from Tylt’s network for full E2E. Use **ngrok** (or similar) pointing at your local server if you develop locally. |
| **Transacty → merchant** | If the merchant sets `webhookUrl` via `PATCH /v1/me/webhook`, Transacty delivers events to **their** server (separate from Tylt callbacks). |

You can still test **create** endpoints in Postman without webhooks; transaction rows may stay **`pending`** until a webhook is delivered or you reconcile manually in ops tools.

---

## 9. Suggested end-to-end checklist

1. [ ] `GET /health`
2. [ ] `GET /v1/me` (HMAC OK)
3. [ ] If `KYC_REQUIRED=true`: complete KYC until `GET /v1/me/kyc` shows verified (or use a pre-verified test merchant)
4. [ ] (Optional) `GET` discovery / `account-balance` with correct scopes
5. [ ] Pick one product: **CrossRamp** *or* **H2H** *or* **CPG pay-in** *or* **CPG payout** *or* **internal transfer**
6. [ ] POST create with **`Idempotency-Key`**; save `transactionId`
7. [ ] Complete user step (browser / chain) as required by that product
8. [ ] Confirm webhooks received (ngrok logs or production logs) **or** poll `GET /v1/transactions`
9. [ ] (Optional) Verify merchant webhook receiver got the event

---

## 10. Related docs

- `docs/MONEY_INVARIANTS.md` — wallet / ledger / payout debit semantics.
- `docs/WEBHOOK_DEDUPE_AND_IDEMPOTENCY.md` — provider callback dedupe and merchant `Idempotency-Key` behavior.
- `docs/HIGH_TRAFFIC_POSTURE.md` — outbound HTTP and rate limits (affects retries under load).

---

## Changelog

- **Initial:** Merchant-facing Tylt route list, HMAC rules, Postman variables + pre-request script template, flows and webhook limitations.
