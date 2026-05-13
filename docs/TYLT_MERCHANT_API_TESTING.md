# Tylt merchant API — testing guide (Postman & flows)

## Who this guide is for

- **Transacty operators / you** — Step-by-step **Postman** (or similar) checks against the **merchant-facing HTTP API** you ship: **`/v1/*`** (cross-border rails such as **`/v1/crossramp`**, **`/v1/h2h`**, **`/v1/cpg`**, **`/v1/supported`**, etc.), using **HMAC** (API key + secret). Use it to confirm the integration you give merchants works before or after deploy.
- **Merchant-side backend engineers** — Anyone integrating **server-to-server** against Transacty (never from a browser with the secret).

## Who this guide is **not** for

- **Merchant portal / dashboard frontend** — That UI uses **`/portal/*`** and JWT, not HMAC. Spec: **`docs/PORTAL_FRONTEND_SPEC.md`**. Do not point storefront or SPA devs here as their primary doc.

---

This document assumes **you** expose Transacty as **API-as-a-service**: merchants (or their backends) call **your** Transacty **`/v1/*`** endpoints; Transacty authenticates them and calls **Tylt** with server-side credentials.

- **Merchant → Transacty:** HMAC-signed HTTP (this guide). **Public paths omit the liquidity provider name** (merchants integrate with Transacty only). **Legacy** `POST|GET /v1/tylt/...` URLs remain **aliases** of the same handlers for backward compatibility.
- **Tylt → Transacty (server-only):** Signed webhooks to **`/webhooks/tylt/...`** — never part of the merchant integration surface; only your infrastructure needs a public URL here.

**Same auth as Bangladesh merchant API:** one **API key + secret**, same HMAC headers and collection Pre-request Script pattern as `docs/POSTMAN_MERCHANT_API_GUIDE.md`. Use **one** Postman collection for all `/v1/*` regression (Payok + Tylt); add folders “Domestic BD” vs “Tylt” if you like.

**Recommended scopes** to exercise **everything** in [§11](#11-full-postman-regression-order-all-tylt-endpoints) without scope errors (tighten in production):

`payin:create,payout:create,balance:read,internal_transfer:create` — or `*` only in sandboxes. (`tylt:internal_transfer` is still accepted as a legacy scope name.)

Related: environment variables for Tylt are listed in `.env.example` (`TYLT_*`, `TYLT_TEST_*`, `TYLT_LIVE_*`, `TYLT_ALLOW_KYC_BYPASS`).

**Schemas in code:** Request bodies match `app.ts` (Zod) for each route; shared query helpers live in `src/lib/tylt-merchant-api-schemas.ts`.

---

## 1. Prerequisites

| Requirement | Notes |
|-------------|--------|
| Transacty base URL | e.g. `https://api.example.com` or `http://localhost:3000` for local dev. |
| Tylt credentials on the server | `TYLT_API_KEY` / `TYLT_API_SECRET` (or per-environment `TYLT_TEST_*` / `TYLT_LIVE_*`). |
| Merchant account | Created via portal signup or a seed script. |
| Merchant API key | Created in portal; note **public key** + **secret** (secret is shown once). |
| Key **environment** | `test` or `live` on the key row must match the Tylt credentials you expect for that traffic. |
| Scopes on the key | See [§6](#6-postman-request-cookbook-copy-paste). Use `*` only in non-production sandboxes. |
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

### Idempotency (`Idempotency-Key` header)

If the client sends **`Idempotency-Key`**:

- Same key + **same** JSON body → same response as the first successful completion (**replay**).
- Same key + **different** body → **409** `Idempotency conflict` (`body_mismatch`).
- Concurrent duplicate keys while work is running → **409** (`in_progress`).

If **`Idempotency-Key` is omitted**, each POST runs without an idempotency slot (safe retries are the client’s responsibility).

**Cross-border merchant routes** that use Transacty idempotency (recommended: send `Idempotency-Key` on these POSTs):

| Route | Idempotency |
|-------|-------------|
| `POST /v1/crossramp/payin-instances` | Yes |
| `POST /v1/h2h/payin-instances` | Yes |
| `POST /v1/cpg/payin-requests` | Yes |
| `POST /v1/cpg/payout-requests` | Yes |
| `POST /v1/internal-transfer` | Yes |
| `POST /v1/h2h/buyer-confirms-payment` | **No** |

---

## 3. Postman setup

### 3.1 Collection variables (suggested)

| Variable | Example |
|----------|---------|
| `baseUrl` | `https://api.example.com` |
| `merchantKey` | Public key from portal |
| `merchantSecret` | Secret from portal (store in **secret** type in Postman) |
| `idempotencyKey` | UUID; change per *logical* operation, reuse only when retrying the **same** body |
| `tyltTransactionId` | Save from a create response (UUID) for follow-up GETs / confirm |

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

### 3.3 Common mistakes (401 “Missing X-Transacty-Key…”)

1. **Script on “Post-response” instead of “Pre-request Script”** — The HMAC script must run **before** the request is sent. If it lives under **Post-res**, headers are added **too late** and the server sees none of them → this exact error.
2. **Wrong variable names** — The snippet uses **`merchantKey`** / **`merchantSecret`**. If you store **`TRANSCATY_KEY`** / **`TRANSCATY_SECRET`** in an **environment**, either rename those collection variables or change the script to `pm.environment.get("TRANSCATY_KEY")` (and same for secret).
3. **Manual headers with empty `{{vars}}`** — If variables don’t resolve, headers are blank and behave as “missing.”
4. **Stale `timestamp` / `signature` in env** — Don’t send a months-old timestamp (clock skew); regenerate **timestamp + signature in the pre-request script** every time (the snippet above does this).

Alternative: use **Newman** or a tiny Node script with `createHmac("sha256", secret).update(payload).digest("hex")` — same algorithm as production.

### 3.4 Optional: Idempotency header

On POST requests that support it (see table in [§2](#2-authentication-every-v1-request)), add:

```
Idempotency-Key: {{$guid}}
```

Or bind to `{{idempotencyKey}}` and reuse that variable only when **retrying the identical body**.

### 3.5 POST body tab (all JSON POSTs here)

- **Body:** raw, **JSON**.
- **Headers:** set **`Content-Type: application/json`** (recommended; signing uses whatever bytes Postman sends as the raw body).
- Do not switch to **form-data** for these routes — the server expects JSON bodies as in `app.ts`.

---

## 4. Smoke tests (do this first)

| Step | Method | Path | Body | Expect |
|------|--------|------|------|--------|
| A | GET | `/health` | — | No merchant auth. `200` if app + deps healthy. |
| B | GET | `/v1/me` | empty (sign `ts.`) | `200` → `merchantId`, `scopes`, `environment`. |

If **B** fails with `401` / `Invalid signature`, fix signing or body mismatch before any Tylt route.

**Postman — B:**

- Method: **GET**
- URL: `{{baseUrl}}/v1/me`
- Body: **none** (not “empty JSON `{}`” — no body tab content for GET).

---

## 5. Amount limits (enforced before Tylt)

| Flow | Field | Bounds (app-level) |
|------|--------|---------------------|
| CrossRamp / H2H pay-in | `amount` + `currencySymbol` | **USDT:** 1 … 500_000. **INR:** 200 … 500_000. |
| CPG pay-in | `baseAmount` (parsed float) | `1e-8` … `1e15`. |
| CPG payout | `amount` | `1e-8` … `1e15`. |
| Internal transfer | `settledAmount` | `1e-8` … `1e15`. |

---

## 6. Postman request cookbook (copy-paste)

Use **`{{baseUrl}}`** and the collection **Pre-request Script** for every row below unless noted.

**GET requests:** leave the body empty; the signing string is `timestamp.` (trailing dot).

**POST requests:** paste the JSON into **Body → raw**, then send (script re-signs after any body edit).

### 6.1 Discovery and H2H lists (GET)

| # | Method | URL (Postman) | Scope |
|---|--------|---------------|--------|
| 1 | GET | `{{baseUrl}}/v1/supported/crypto-currencies` | `balance:read` **or** `payin:create` **or** `payout:create` **or** `*` |
| 2 | GET | `{{baseUrl}}/v1/supported/fiat-currencies` | same |
| 3 | GET | `{{baseUrl}}/v1/supported/crypto-networks` | same |
| 4 | GET | `{{baseUrl}}/v1/supported/base-currencies` | same |
| 5 | GET | `{{baseUrl}}/v1/h2h/payment-methods` | `payin:create` or `*` |
| 6 | GET | `{{baseUrl}}/v1/h2h/crypto-currencies` | `payin:create` or `*` |

No query parameters required. Response shape is **upstream Tylt JSON** (proxied).

### 6.2 Account balance (GET, query passthrough)

- **Method:** GET  
- **URL:** `{{baseUrl}}/v1/account-balance`  
- **Scope:** `balance:read` or `*`  

**Query parameters:** Optional. Transacty **forwards** any non-empty query keys to Tylt’s `getAccountBalance` (`services/integrations/tylt/discovery-balance.ts`). There is **no** fixed list in this repo — use whatever Tylt’s merchant API documents for that endpoint.

**Examples:**

- No filters: `{{baseUrl}}/v1/account-balance`
- With illustrative params (replace names with Tylt’s real ones):  
  `{{baseUrl}}/v1/account-balance?foo=bar&currency=USDT`

In Postman, use the **Params** tab; empty values are dropped before the upstream call.

### 6.3 CrossRamp pay-in (POST)

- **Method:** POST  
- **URL:** `{{baseUrl}}/v1/crossramp/payin-instances`  
- **Scope:** `payin:create` or `*`  
- **Idempotency:** recommended (`Idempotency-Key`)

**Body (raw JSON):**

```json
{
  "amount": "100",
  "currencySymbol": "USDT",
  "returnUrl": "https://merchant.example.com/pay/return",
  "userEmail": "payer@example.com"
}
```

| Field | Required | Notes |
|-------|----------|--------|
| `amount` | yes | String; must satisfy [§5](#5-amount-limits-enforced-before-tylt) for `currencySymbol`. |
| `currencySymbol` | yes | `"USDT"` or `"INR"`. |
| `returnUrl` | yes | Absolute URL; rules in [§8](#8-returnurl-rules-crossramp--payok-style-flows). For local dev, `http://localhost:3000/...` is allowed. |
| `userEmail` | no | If present, must be a valid email. |

**Omit `userEmail` example:**

```json
{
  "amount": "200",
  "currencySymbol": "INR",
  "returnUrl": "https://merchant.example.com/pay/return"
}
```

**Expect (200):** `transactionId`, `status: "pending"`, `amount`, `currency`, `instanceId`, `rampUrl`, optional `expiresAt`.

### 6.4 H2H UPI pay-in — create (POST)

- **Method:** POST  
- **URL:** `{{baseUrl}}/v1/h2h/payin-instances`  
- **Scope:** `payin:create` or `*`  
- **Idempotency:** recommended

**Body (minimal — no `returnUrl`):**

```json
{
  "amount": "200",
  "currencySymbol": "INR"
}
```

**Body (with optional fields):**

```json
{
  "amount": "100",
  "currencySymbol": "USDT",
  "returnUrl": "https://merchant.example.com/h2h/return",
  "userEmail": "payer@example.com"
}
```

`returnUrl` is optional; if sent, it is validated like CrossRamp.

**Expect (200):** `transactionId`, `status: "pending"`, `amount`, `currency`, `instanceId`, `paymentDetails` (object), optional `expiresAt`.

### 6.5 H2H — buyer confirms payment (POST)

- **Method:** POST  
- **URL:** `{{baseUrl}}/v1/h2h/buyer-confirms-payment`  
- **Scope:** `payin:create` or `*`  
- **Idempotency:** **not** used on this route

**Body:**

```json
{
  "transactionId": "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
  "utr": "123456789012"
}
```

| Field | Required | Notes |
|-------|----------|--------|
| `transactionId` | yes | UUID of the Transacty transaction created in [§6.4](#64-h2h-upi-pay-in--create-post). |
| `utr` | no | If present: length 4–64. |

`utr` may be omitted:

```json
{
  "transactionId": "{{tyltTransactionId}}"
}
```

**Expect (200):** `{ "transactionId": "...", "acknowledged": true }` when Tylt accepts the confirm; **400** if the row is not an H2H pay-in, instance id missing, or upstream rejects.

### 6.6 CPG pay-in — create (POST)

- **Method:** POST  
- **URL:** `{{baseUrl}}/v1/cpg/payin-requests`  
- **Scope:** `payin:create` or `*`  
- **Idempotency:** recommended

**Body:**

```json
{
  "baseAmount": "10",
  "baseCurrency": "USDT",
  "settledCurrency": "USDT",
  "networkSymbol": "TRX",
  "settleUnderpayment": 0,
  "payeeDetails": {
    "exampleKey": "replace-with-tylt-required-fields"
  }
}
```

| Field | Required | Notes |
|-------|----------|--------|
| `baseAmount` | yes | String; parsed float must be within [§5](#5-amount-limits-enforced-before-tylt). |
| `baseCurrency` | yes | Non-empty string. |
| `settledCurrency` | yes | Non-empty string. |
| `networkSymbol` | yes | Non-empty string. |
| `payeeDetails` | yes | Object with **at least one** key; shape is defined by **Tylt CPG** (this repo does not validate inner fields). |
| `settleUnderpayment` | no | Integer **0** or **1** if provided. |

Omit optional field:

```json
{
  "baseAmount": "10",
  "baseCurrency": "USDT",
  "settledCurrency": "USDT",
  "networkSymbol": "TRX",
  "payeeDetails": { "exampleKey": "replace-with-tylt-required-fields" }
}
```

**Expect (200):** `transactionId`, `status: "pending"`, `amount`, `currency`, `platformOrderId` (nullable).

### 6.7 CPG pay-in — information (GET)

- **Method:** GET  
- **URL:** `{{baseUrl}}/v1/cpg/payin-information/{{tyltTransactionId}}`  
- **Scope:** `payin:create` or `*`  

Path param `transactionId` must be a **UUID** and must be a **CPG pay-in** your key owns.

### 6.8 CPG pay-in — history (GET)

- **Method:** GET  
- **URL:** `{{baseUrl}}/v1/cpg/payin-history?rows=20&page=1`  
- **Scope:** `payin:create` or `*`  

**Query (validated by Transacty):**

| Param | Default | Range |
|-------|---------|--------|
| `rows` | 20 | 1–100 |
| `page` | 1 | integer ≥ 1 |

Example: `?rows=50&page=2`

### 6.9 CPG payout — create (POST)

- **Method:** POST  
- **URL:** `{{baseUrl}}/v1/cpg/payout-requests`  
- **Scope:** `payout:create` or `*`  
- **Idempotency:** recommended  

**Important:** A successful create **debits the merchant wallet** in the API key’s environment for `settledCurrency`. Fund the wallet first or expect an insufficient-balance path.

**Body:**

```json
{
  "amount": "10",
  "settledCurrency": "USDT",
  "networkSymbol": "TRX",
  "destinationDetails": {
    "exampleKey": "replace-with-tylt-required-fields"
  }
}
```

| Field | Required | Notes |
|-------|----------|--------|
| `amount` | yes | String; bounds in [§5](#5-amount-limits-enforced-before-tylt). |
| `settledCurrency` | yes | Non-empty string. |
| `networkSymbol` | yes | Non-empty string. |
| `destinationDetails` | yes | Non-empty object per **Tylt CPG** payout schema. |

**Expect (200):** `transactionId`, `status: "pending"`, `amount`, `platformOrderId` (nullable).

### 6.10 CPG payout — information (GET)

- **Method:** GET  
- **URL:** `{{baseUrl}}/v1/cpg/payout-information/{{tyltTransactionId}}`  
- **Scope:** `payout:create` or `*`  

Must reference a **CPG payout** transaction (type `payout`) for this merchant.

### 6.11 CPG payout — history (GET)

- **Method:** GET  
- **URL:** `{{baseUrl}}/v1/cpg/payout-history?rows=20&page=1`  
- **Scope:** `payout:create` or `*`  

Same `rows` / `page` rules as [§6.8](#68-cpg-pay-in--history-get).

### 6.12 Tylt merchant details (GET)

- **Method:** GET  
- **URL:** `{{baseUrl}}/v1/merchant-details`  
- **Scope:** `internal_transfer:create` or `*` (legacy `tylt:internal_transfer` accepted)

Use the response to obtain **`fromUUID` / `toUUID`** (or other IDs) that Tylt accepts for internal transfer.

### 6.13 Internal transfer (POST)

- **Method:** POST  
- **URL:** `{{baseUrl}}/v1/internal-transfer`  
- **Scope:** `internal_transfer:create` or `*` (legacy `tylt:internal_transfer` accepted)
- **Idempotency:** recommended  

**Body:**

```json
{
  "fromUUID": "aaaaaaaa-bbbb-4ccc-dddd-111111111111",
  "toUUID": "aaaaaaaa-bbbb-4ccc-dddd-222222222222",
  "settledAmount": "1",
  "settledCurrency": "USDT",
  "comments": "Postman internal transfer test"
}
```

| Field | Required | Notes |
|-------|----------|--------|
| `fromUUID` | yes | UUID. |
| `toUUID` | yes | UUID. |
| `settledAmount` | yes | String; bounds in [§5](#5-amount-limits-enforced-before-tylt). |
| `settledCurrency` | yes | Non-empty string. |
| `comments` | no | Optional string. |

**Expect (200):** `transactionId`, `status: "success"`, `platformOrderId` (nullable).

`comments` may be omitted.

### 6.14 Domestic sanity check (optional, same collection)

- **GET** `{{baseUrl}}/v1/balance?environment=test` — requires `balance:read` or `*`; confirms BD wallet path still works with the same key as in [§11](#11-full-postman-regression-order-all-tylt-endpoints).

### 6.15 List transactions (GET)

- **GET** `{{baseUrl}}/v1/transactions` — same HMAC key; use to see rows created from the flows above (filter client-side if your client exposes provider metadata).

---

## 7. Route index (quick lookup)

| Method | Path | Scope |
|--------|------|--------|
| GET | `/v1/supported/crypto-currencies` | discovery |
| GET | `/v1/supported/fiat-currencies` | discovery |
| GET | `/v1/supported/crypto-networks` | discovery |
| GET | `/v1/supported/base-currencies` | discovery |
| GET | `/v1/account-balance` | `balance:read` |
| GET | `/v1/h2h/payment-methods` | `payin:create` |
| GET | `/v1/h2h/crypto-currencies` | `payin:create` |
| POST | `/v1/crossramp/payin-instances` | `payin:create` |
| POST | `/v1/h2h/payin-instances` | `payin:create` |
| POST | `/v1/h2h/buyer-confirms-payment` | `payin:create` |
| POST | `/v1/cpg/payin-requests` | `payin:create` |
| GET | `/v1/cpg/payin-information/:transactionId` | `payin:create` |
| GET | `/v1/cpg/payin-history` | `payin:create` |
| POST | `/v1/cpg/payout-requests` | `payout:create` |
| GET | `/v1/cpg/payout-information/:transactionId` | `payout:create` |
| GET | `/v1/cpg/payout-history` | `payout:create` |
| GET | `/v1/merchant-details` | `internal_transfer:create` |
| POST | `/v1/internal-transfer` | `internal_transfer:create` |

---

## 8. `returnUrl` rules (CrossRamp & PayOK-style flows)

- Must be a valid **absolute** URL.
- **HTTPS** required except **http** allowed for `localhost`, `127.0.0.1`, `[::1]`.
- No `username:password@` in the URL.
- Max **200** characters (enforced for PayOK parity; CrossRamp uses the same validator).

---

## 9. Webhooks — what Postman does *not* cover

| Direction | Who calls whom |
|-----------|----------------|
| **Tylt → Transacty** | Tylt POSTs to your deployed paths, e.g. `/webhooks/tylt/crossramp/:environment`, `/webhooks/tylt/h2h/:environment`, `/webhooks/tylt/cpg-payin/:environment`, `/webhooks/tylt/cpg-payout/:environment`, and optionally `/webhooks/tylt/unified/:environment`. These URLs must be **publicly reachable** from Tylt’s network for full E2E. Use **ngrok** (or similar) pointing at your local server if you develop locally. |
| **Transacty → merchant** | If the merchant sets `webhookUrl` via `PATCH /v1/me/webhook`, Transacty delivers events to **their** server (separate from Tylt callbacks). |

You can still test **create** endpoints in Postman without webhooks; transaction rows may stay **`pending`** until a webhook is delivered or you reconcile manually in ops tools.

---

## 10. Short end-to-end checklist (pick one product)

1. [ ] `GET /health`
2. [ ] `GET /v1/me` (HMAC OK)
3. [ ] If `KYC_REQUIRED=true`: merchant KYC **verified** (`kycStatus` on merchant / portal) or Tylt **create** routes return `403`
4. [ ] (Optional) Discovery GETs ([§6.1](#61-discovery-and-h2h-lists-get))
5. [ ] Pick **one** product: CrossRamp *or* H2H *or* CPG pay-in *or* CPG payout *or* internal transfer
6. [ ] POST create with **`Idempotency-Key`** where applicable ([§2](#2-authentication-every-v1-request)); save `transactionId`
7. [ ] Browser / chain step if needed
8. [ ] Webhooks (ngrok/prod) **or** `GET /v1/transactions`
9. [ ] (Optional) Merchant webhook delivery

---

## 11. Full Postman regression order (all Tylt `/v1` endpoints)

Use this sequence to prove the **entire** Tylt merchant surface is healthy after a deploy. Re-use the same HMAC setup as `docs/POSTMAN_MERCHANT_API_GUIDE.md`. Use **`test`** API key environment until you intentionally test **live**.

| # | Method | Path | Scope | Notes |
|---|--------|------|--------|--------|
| **0** | GET | `/health` | — | No HMAC. |
| **1** | GET | `/v1/me` | any | Confirms key, scopes, `environment` (`test` \| `live`). |
| **2** | GET | `/v1/balance?environment=test` | `balance:read` or `*` | BDT wallet for BD; confirms domestic path still OK with the same key. |
| **3** | GET | `/v1/supported/crypto-currencies` | discovery | Empty body signing. |
| **4** | GET | `/v1/supported/fiat-currencies` | discovery | |
| **5** | GET | `/v1/supported/crypto-networks` | discovery | |
| **6** | GET | `/v1/supported/base-currencies` | discovery | |
| **7** | GET | `/v1/account-balance` | `balance:read` | Add query params per Tylt if needed ([§6.2](#62-account-balance-get-query-passthrough)). |
| **8** | GET | `/v1/h2h/payment-methods` | `payin:create` | |
| **9** | GET | `/v1/h2h/crypto-currencies` | `payin:create` | |
| **10** | POST | `/v1/crossramp/payin-instances` | `payin:create` | `Idempotency-Key` recommended. Example body: [§6.3](#63-crossramp-pay-in-post). |
| **11** | POST | `/v1/h2h/payin-instances` | `payin:create` | Example body: [§6.4](#64-h2h-upi-pay-in--create-post). |
| **12** | POST | `/v1/h2h/buyer-confirms-payment` | `payin:create` | Example body: [§6.5](#65-h2h--buyer-confirms-payment-post). No idempotency header. |
| **13** | POST | `/v1/cpg/payin-requests` | `payin:create` | Example body: [§6.6](#66-cpg-pay-in--create-post). |
| **14** | GET | `/v1/cpg/payin-information/:transactionId` | `payin:create` | Use `transactionId` from **13**. |
| **15** | GET | `/v1/cpg/payin-history?rows=20&page=1` | `payin:create` | |
| **16** | POST | `/v1/cpg/payout-requests` | `payout:create` | Needs **sufficient balance**. Example body: [§6.9](#69-cpg-payout--create-post). |
| **17** | GET | `/v1/cpg/payout-information/:transactionId` | `payout:create` | From **16**. |
| **18** | GET | `/v1/cpg/payout-history?rows=20&page=1` | `payout:create` | |
| **19** | GET | `/v1/merchant-details` | `internal_transfer:create` | Discover UUIDs for **20**. |
| **20** | POST | `/v1/internal-transfer` | `internal_transfer:create` | Example body: [§6.13](#613-internal-transfer-post). |
| **21** | GET | `/v1/transactions` | (same key) | Confirms rows for Tylt creates; filter client-side by `metadata` / provider if exposed. |

**Practical notes**

- Steps **10–12** may create **real** upstream state; use **test** keys and small amounts.
- **16** debits the **merchant wallet** in **settled** currency — fund that pocket first (e.g. prior pay-in) or expect `Insufficient balance`.
- Steps you cannot complete without browser/UPI/chain (**10**, **11–12**, **13**) still validate **HTTP + auth + validation** if Tylt returns an error — capture status and body.
- **Webhook E2E** remains outside Postman unless you tunnel; see [§9](#9-webhooks--what-postman-does-not-cover).

---

## 12. Related docs

- `docs/PORTAL_FRONTEND_SPEC.md` — **Merchant dashboard UI** (`/portal/*`, JWT). Not a substitute for this Postman guide.
- `docs/MONEY_INVARIANTS.md` — wallet / ledger / payout debit semantics.
- `docs/WEBHOOK_DEDUPE_AND_IDEMPOTENCY.md` — provider callback dedupe and merchant `Idempotency-Key` behavior.
- `docs/HIGH_TRAFFIC_POSTURE.md` — outbound HTTP and rate limits (affects retries under load).

---

## Changelog

- **Merchant paths:** Canonical URLs are **`/v1/crossramp`**, **`/v1/h2h`**, **`/v1/cpg`**, **`/v1/supported`**, **`/v1/account-balance`**, **`/v1/merchant-details`**, **`/v1/internal-transfer`** (no processor segment). **`/v1/tylt/...`** remains a **legacy alias** in `app.ts`. Scope **`internal_transfer:create`** preferred; **`tylt:internal_transfer`** still accepted.
- **Postman cookbook (§6):** Copy-paste URLs, JSON bodies, query rules (`account-balance` passthrough, `rows`/`page`), idempotency table (`buyer-confirms` excluded), `Content-Type` / GET body note, path to Zod in repo.
- **Audience:** Clarified this guide is for **Postman / server-side `/v1` testing** (Transacty operators + merchant backend integrators), **not** for merchant portal frontend (`PORTAL_FRONTEND_SPEC.md`).
- **Regression (§11):** Links into cookbook examples; §6 cookbook added as the primary Postman reference.
- **Initial:** Merchant-facing Tylt route list, HMAC rules, Postman variables + pre-request script template, flows and webhook limitations.
