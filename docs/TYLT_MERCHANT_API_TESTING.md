# Tylt merchant API — testing guide (Postman & flows)

## Who this guide is for

- **Transacty operators / you** — Step-by-step **Postman** (or similar) checks against the **merchant-facing HTTP API** you ship: **`/v1/*`** (cross-border rails such as **`/v1/h2h`** (India UPI **H2H only**), **`/v1/cpg`**, **`/v1/supported`**, etc.), using **HMAC** (API key + secret). Use it to confirm the integration you give merchants works before or after deploy.
- **Merchant-side backend engineers** — Anyone integrating **server-to-server** against Transacty (never from a browser with the secret).

## Who this guide is **not** for

- **Merchant portal / dashboard frontend** — That UI uses **`/portal/*`** and JWT. Use **`docs/MERCHANT_INDIA_EUR_INTEGRATION.md`** (India + EU product + dashboard) and **`docs/PORTAL_FRONTEND_SPEC.md`** (all portal routes). This file is **Postman / HMAC** for India only.

---

This document assumes **you** expose Transacty as **API-as-a-service**: merchants (or their backends) call **your** Transacty **`/v1/*`** endpoints; Transacty authenticates them and calls **TL Pay (Tylt)** with server-side credentials.

- **Merchant → Transacty:** HMAC-signed HTTP (this guide). **Public paths omit the liquidity provider name** (merchants integrate with Transacty only). **Legacy** `POST|GET /v1/tylt/...` URLs remain **aliases** of the same handlers for backward compatibility.
- **TL Pay → Transacty (server-only):** Signed webhooks to **`/webhooks/tylt/...`** — never part of the merchant integration surface; only your infrastructure needs a public URL here.

**This guide is Tylt / India cross-border only** (`/v1/h2h`, `/v1/cpg`, discovery, internal transfer). **Do not use this file for EUR/GBP Open Banking.**

| Region / product | Postman doc | Merchant paths |
|------------------|-------------|----------------|
| **India** (this file) | Below | `/v1/h2h/*`, `/v1/cpg/*` |
| **EU Open Banking** | **`docs/TYLT_EUR_OPEN_BANKING.md`** | `/v1/eur/*` — widget `checkoutUrl`, USDC settlement |
| **Bangladesh** | `docs/POSTMAN_MERCHANT_API_GUIDE.md` | `/v1/payins`, `/v1/payouts` |

Use a **separate Postman collection** (or folder) for EU vs India so you do not mix H2H UTR steps with EU widget redirects.

**HMAC auth** uses the same headers as `docs/POSTMAN_MERCHANT_API_GUIDE.md` (EU doc §2–3 repeats the pre-request script for a standalone EU collection).

**India UPI pay-in (merchant API):** Transacty exposes **H2H UPI only** (`POST /v1/h2h/payin-instances`, `POST /v1/h2h/buyer-confirms-payment`). **Hosted CrossRamp** widget create (`rampUrl`) is **not** registered on the merchant API so checkout stays **in your UI**. Webhooks under `/webhooks/tylt/crossramp/...` may still be used for **legacy** hosted-widget traffic; new integrations should use **H2H** + `/webhooks/tylt/h2h/...`.

### How TL Pay works (from [official docs](https://docs.tylt.money/))

TL Pay is **crypto settlement infrastructure** (stablecoins, conversion rails, treasury). Fiat legs (e.g. UPI in India) run via partners; TL Pay tracks **instances**, **trades**, and **transactions** and is **webhook-first**.

| TL Pay term | Meaning for integrators |
|-------------|-------------------------|
| **Instance** | One pay-in session from **create** — you get **`instanceId`**. |
| **Trade** | Lifecycle of that instance (matching, UPI ready, confirm, complete). **Not** “stock trading” — it is their state machine for conversion. |
| **Transaction** | Merchant **credit/debit** when the trade is final (often empty in early webhooks). |
| **Account** | Merchant balance / rates in TL Pay (`accounts` blocks in payloads). |

**Typical UPI H2H `trade.event.id` (webhooks):**

| `event.id` | Meaning |
|------------|---------|
| **1** | Trade initiated — finding counterparty (“seller”). UPI details often **not** ready yet. |
| **2** | Seller found — **UPI / QR** may appear in `paymentMethod.details`. |
| **3** | Buyer confirmed payment — verification in progress. |
| **4** / **6** | Completed. |
| **9** | Expired / not completed in time. |

**Who pays whom:** The **customer (payer)** sends **INR via UPI** toward this pay-in. The **merchant** integrates via Transacty APIs and receives **success/failed** on their Transacty transaction — not a payout to the customer.

**Webhook directions (Tylt flows):**

1. **TL Pay → Transacty** — `POST {APP_BASE_URL}/webhooks/tylt/h2h/{test|live}` (operators; drives trade lifecycle).
2. **Transacty → merchant** — `PATCH /v1/me/webhook` registers **your** URL; events like `payin.completed` when Transacty finalizes.

**IDs merchants should store:**

| Field | Source |
|-------|--------|
| **`transactionId`** | Transacty `POST /v1/h2h/payin-instances` — use for **buyer-confirm** and **`GET /v1/transactions/:transactionId`**. |
| **`instanceId`** | TL Pay instance — stored as `platformOrderId` / `instanceId` on the transaction row. |
| **`merchantOrderId` in TL Pay webhooks** | TL Pay’s copy of the id sent at create (Transacty uses a dedicated UUID per create in metadata). |

**Recommended scopes** to exercise **everything** in [§11](#11-full-postman-regression-order-all-tylt-endpoints) without scope errors (tighten in production):

`payin:create,payout:create,balance:read,internal_transfer:create` — or `*` only in sandboxes. (`tylt:internal_transfer` is still accepted as a legacy scope name.)

Related: environment variables for Tylt are listed in `.env.example`: **India** lane (`TYLT_{TEST|LIVE}_INDIA_PAYIN_*` / `INDIA_PAYOUT_*`), with fallbacks to generic `PAYIN_` / `PAYOUT_` and legacy `TYLT_*`. EU uses `TYLT_*_EUR_PAYIN_*` / `EUR_PAYOUT_*` (see `TYLT_EUR_OPEN_BANKING.md`). Optional `TYLT_H2H_REQUIRE_END_USER_KYC`, caches, internal-transfer allowlist.

**Schemas in code:** Request bodies match `app.ts` (Zod) for each route; shared query helpers live in `src/lib/tylt-merchant-api-schemas.ts`.

---

## Merchant quick test — India UPI H2H (Postman, step by step)

Use this as the **default onboarding flow** for backend engineers building against Transacty. It is only what the **merchant server** calls: **`/v1/*` + HMAC**. You do **not** call TL Pay directly and you do **not** “fetch webhooks” from an API — webhooks are **TL Pay → Transacty** (see §1 deploy note below).

| Step | Action | Method & path | Body / notes |
|------|--------|---------------|--------------|
| **0** | Configure Postman | — | Set `baseUrl`, `merchantKey`, `merchantSecret`. Add the **Pre-request script** from [§3.2](#32-pre-request-script-hmac). |
| **1** | **Create** pay-in | `POST /v1/h2h/payin-instances` | JSON: `amount` (string, e.g. `"500"`), `currencySymbol` (`INR` or `USDT`), `userDetails`: `{ "email": "payer@example.com" }`. Optional header: `Idempotency-Key: <uuid>`. **Save** `transactionId` and `instanceId` from the response. Expect **200**, `status: "pending"`. |
| **2** | **Get** transaction (optional) | `GET /v1/transactions/:transactionId` | Use `transactionId` from step 1. Expect `status: pending`, `rail: india`, `railLabel: India UPI (H2H)`, `currency: INR` (or `USDT`), `instanceId` set after create. |
| **3** | **Wait** until the trade can accept payment | — | TL Pay moves the trade forward **asynchronously**. UPI details and lifecycle updates usually arrive on **your** Transacty’s webhook URL — not in Postman. If you call confirm too soon, TL Pay returns **400** (e.g. `Invalid trade state.`). Use TL Pay dashboard / logs / their test checklist to know when the payer can pay. |
| **4** | **Payer pays** (real or sandbox per TL Pay) | — | Customer completes UPI. **UTR** appears in the payer’s bank/UPI app (not in the create response). |
| **5** | **Confirm** payment | `POST /v1/h2h/buyer-confirms-payment` | JSON: `transactionId` (step 1), `utr` (step 4). **No** `Idempotency-Key`. Expect **200** + `acknowledged: true` if TL Pay accepts it. |
| **6** | **Check** final status | `GET /v1/transactions/:transactionId` | When processing is done, `status` becomes **`success`** or **`failed`**. Or list: `GET /v1/transactions?type=payin`. |

**If something returns 400:** Read `message` in the JSON. When TL Pay rejected the call, you may see `code: "payment_provider_rejected"` and their explanation (amount limits, trade state, etc.).

**Deploy check:** On the Transacty server, **`APP_BASE_URL`** must be the **same** public origin that receives **`POST /webhooks/tylt/h2h/test`** (or `live`). If merchants call `https://api.yourproduct.com` but webhooks go to another host, creates may succeed while status never advances — align env with the service that owns the database.

**Deeper reference** (discovery GETs, CPG, full regression order): continue from [§6](#6-postman-request-cookbook-copy-paste) below — you can ignore those until this 6-step flow works.

---

## 1. Prerequisites

| Requirement | Notes |
|-------------|--------|
| Transacty base URL | e.g. `https://api.example.com` or `http://localhost:3000` for local dev. |
| Tylt credentials on the server | **India:** `TYLT_TEST_INDIA_PAYIN_*` / `INDIA_PAYOUT_*` (or `TYLT_TEST_PAYIN_*` / `PAYOUT_*` / legacy). See `.env.example`. |
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
| H2H UPI pay-in | `amount` + `currencySymbol` | **USDT:** 1 … 500_000. **INR:** 200 … 500_000. |
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
| 7 | GET | `{{baseUrl}}/v1/h2h/conversion-rates` | `payin:create` or `*` |

No query parameters required. Response shape is **upstream TL Pay JSON** (proxied).

### 6.2 Account balance (GET, query passthrough)

- **Method:** GET  
- **URL:** `{{baseUrl}}/v1/account-balance`  
- **Scope:** `balance:read` or `*`  

The path is **`/v1/account-balance` only**. Do **not** put the scope in the URL (e.g. `/v1/account-balance:read` is invalid and returns **404**). `balance:read` is configured on the **merchant API key**, not in the path.

**Query parameters:** Optional. Transacty **forwards** any non-empty query keys to Tylt’s `getAccountBalance` (`services/integrations/tylt/discovery-balance.ts`). There is **no** fixed list in this repo — use whatever Tylt’s merchant API documents for that endpoint.

**Examples:**

- No filters: `{{baseUrl}}/v1/account-balance`
- With illustrative params (replace names with Tylt’s real ones):  
  `{{baseUrl}}/v1/account-balance?foo=bar&currency=USDT`

In Postman, use the **Params** tab; empty values are dropped before the upstream call.

### 6.3 India UPI — H2H only (no hosted CrossRamp create)

The merchant API **does not** expose `POST /v1/crossramp/payin-instances` (no **`rampUrl`** / hosted-widget create). Use **H2H** below so payment instructions and UX stay **on your side**.

#### End-to-end flow (aligned with TL Pay H2H UPI docs)

This mirrors TL Pay’s sequence: [Create a Pay-in Instance](https://docs.tylt.money/introduction/tylt-crossramp-fiat-crypto-solutions/india-inr/upi-payin-inr-usdt-or-h2h/create-a-pay-in-instance) → lifecycle **webhooks** on your `callBackUrl` → payer completes UPI → [Buyer Confirms Payment](https://docs.tylt.money/introduction/tylt-crossramp-fiat-crypto-solutions/india-inr/upi-payin-inr-usdt-or-h2h/buyer-confirms-payment) → terminal **webhook** / completed trade.

| Step | Who | What |
|------|-----|------|
| **1** | Your backend | **`POST /v1/h2h/payin-instances`** with amount, `currencySymbol`, `userDetails.email`, etc. You receive `transactionId` (Transacty row), **`instanceId`** (TL Pay), and `paymentDetails`. |
| **2** | TL Pay → your server | **`POST`** signed webhooks to **`{APP_BASE_URL}/webhooks/tylt/h2h/{test\|live}`** ([Web-hook: UPI Pay-In](https://docs.tylt.money/introduction/tylt-crossramp-fiat-crypto-solutions/india-inr/upi-payin-inr-usdt-or-h2h/web-hook-upi-pay-in)). Process lifecycle by `data.trade.event.id` (e.g. **2** = seller found / UPI instructions for the payer). Instructions may also appear in create **`paymentDetails`** depending on TL Pay response shape—prefer webhooks + docs for production UX. |
| **3** | Payer | Pays via UPI using the **UPI ID / QR** from your UI (from webhook and/or create response). |
| **4** | Your backend | After payment, **`POST /v1/h2h/buyer-confirms-payment`** with `transactionId` + **`utr`** (UTR is **mandatory** here: Transacty always sends **`isUTRNeeded: 1`** to TL Pay on create, per their API). This maps to TL Pay `instanceId` + `utr`. |
| **5** | TL Pay → your server | Further webhooks until terminal events (**4** / **6** completed, **9** expired, etc.). Transacty finalizes ledger / merchant webhooks on success paths. |

**`APP_BASE_URL` must match the deployment that receives webhooks.** It is the prefix of `callBackUrl` sent to TL Pay. If merchants call **`api.example.com`** but `APP_BASE_URL` is another host (e.g. a different Render service), TL Pay will POST webhooks to the **wrong** URL—creates may succeed but lifecycle/payment instructions won’t match the same app you’re testing from.

See [§6.4](#64-h2h-upi-pay-in--create-post) and [§6.5](#65-h2h--buyer-confirms-payment-post).

### 6.4 H2H UPI pay-in — create (POST)

- **Method:** POST  
- **URL:** `{{baseUrl}}/v1/h2h/payin-instances`  
- **Scope:** `payin:create` or `*`  
- **Idempotency:** recommended

**Body (minimal — Tylt requires `userDetails`; `userEmail` alone is still accepted and mapped to `userDetails.email`):**

```json
{
  "amount": "200",
  "currencySymbol": "INR",
  "userDetails": {
    "email": "payer@example.com"
  }
}
```

**Body (with optional fields):**

```json
{
  "amount": "100",
  "currencySymbol": "USDT",
  "returnUrl": "https://merchant.example.com/h2h/return",
  "userDetails": {
    "email": "payer@example.com",
    "name": "Paying Customer",
    "phone": "+919876543210"
  }
}
```

`returnUrl` is optional; if sent, it is validated per [§8](#8-returnurl-rules-merchant-returnurl).

**Expect (200):** `transactionId`, `status: "pending"`, `amount`, `currency`, `instanceId`, `paymentDetails` (object), optional `expiresAt`. Continue the flow in [§6.3](#63-india-upi--h2h-only-no-hosted-crossramp-create) (webhooks → payer UPI → [§6.5](#65-h2h--buyer-confirms-payment-post)).

**Upstream 4xx on create:** Response body may include **`code: "payment_provider_rejected"`** and TL Pay’s **`message`** (amount bands, KYC, etc.) for faster debugging.

**Troubleshooting upstream 400:** The server forwards `APP_BASE_URL` into Tylt’s required **`callBackUrl`** (`{APP_BASE_URL}/webhooks/tylt/h2h/{test|live}`). If `APP_BASE_URL` is **`http://localhost:...`**, Tylt may **reject** the create with **HTTP 400** (they often require a **public** webhook URL). Use **ngrok** (or your deployed API URL) in `APP_BASE_URL` for integration tests, restart the API, then retry. Check server logs for `upstream_message=` / `upstream_body=` after failures (operators only).

**Webhook replay vs new callback:** Set **`TYLT_WEBHOOK_DEBUG_BODY=1`** on the API service (Render env), restart, then trigger TL Pay callbacks. Logs include **`dedupeHash`**, **`tyltEventId`**, **`merchantOrderId`**, and **`claim`** (`fresh` vs `duplicate`). With debug on, **`tyltWebhookPayload`** is the exact raw JSON body — compare hashes/bodies when TL Pay resends vs pushes an updated status after manual handling. Remove the env var after debugging.

**Manual settlement (India H2H / CrossRamp):** When TL Pay ops completes a trade manually, callbacks include **`data.manualSettlement: 1`** with terminal success **`event.id` 4 or 6**. If Transacty already marked the pay-in **`failed`** (e.g. expiry before manual fix), the webhook handler can **recover** to **`success`** and credit the wallet. Identical replays of the same manual-success body are **re-applied** (not dedupe-blocked) so a missed first apply can be fixed by TL Pay resending the same webhook.

### 6.5 H2H — buyer confirms payment (POST)

- **Method:** POST  
- **URL:** `{{baseUrl}}/v1/h2h/buyer-confirms-payment`  
- **Scope:** `payin:create` or `*`  
- **Idempotency:** **not** used on this route

**Body (TL Pay–aligned — `utr` required):**

```json
{
  "transactionId": "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
  "utr": "123456789012"
}
```

| Field | Required | Notes |
|-------|----------|--------|
| `transactionId` | yes | UUID of the Transacty transaction from [§6.4](#64-h2h-upi-pay-in--create-post). |
| `utr` | **yes** | **4–64** chars. TL Pay treats UTR as **mandatory** when `isUTRNeeded: 1` at create; Transacty **always** sends `1` on create, so omitting `utr` is invalid on this API. Use the real UTR from the payer’s bank/UPI app after they paid. |

Call **after** the payer has completed UPI and ideally when webhooks show the trade is waiting for confirm (e.g. TL Pay **`event.id` 2** / **3** per their [webhook doc](https://docs.tylt.money/introduction/tylt-crossramp-fiat-crypto-solutions/india-inr/upi-payin-inr-usdt-or-h2h/web-hook-upi-pay-in)). Confirming too early can produce TL Pay **400**—the response `message` is passed through when present, with `code` set to `payment_provider_rejected` when the failure comes from TL Pay.

**Expect (200):** `{ "transactionId": "...", "acknowledged": true }` when TL Pay accepts the confirm.

**Expect (400):** Wrong row type, missing `instanceId`, or TL Pay rejects; body may include **`code: "payment_provider_rejected"`** and TL Pay’s **`message`**.

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

### 6.14 List transactions (GET)

- **GET** `{{baseUrl}}/v1/transactions` — same HMAC key; filter by `rail: india` / `railLabel` on each item (no vendor names in the response).

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
| GET | `/v1/h2h/conversion-rates` | `payin:create` |
| GET | `/v1/transactions/:transactionId` | any key with access to that row |
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

## 8. `returnUrl` rules (merchant `returnUrl`)

Applies to **Tylt H2H** (`returnUrl` on create) and any other Tylt merchant route that accepts `returnUrl`.

- Must be a valid **absolute** URL.
- **HTTPS** required except **http** allowed for `localhost`, `127.0.0.1`, `[::1]`.
- No `username:password@` in the URL.
- Max **200** characters (shared validator across merchant routes that accept `returnUrl`).

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
5. [ ] Pick **one** product: **H2H UPI** *or* CPG pay-in *or* CPG payout *or* internal transfer
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
| **2** | GET | `/v1/supported/crypto-currencies` | discovery | Empty body signing. |
| **3** | GET | `/v1/supported/fiat-currencies` | discovery | |
| **4** | GET | `/v1/supported/crypto-networks` | discovery | |
| **5** | GET | `/v1/supported/base-currencies` | discovery | |
| **6** | GET | `/v1/account-balance` | `balance:read` | Add query params per Tylt if needed ([§6.2](#62-account-balance-get-query-passthrough)). |
| **7** | GET | `/v1/h2h/payment-methods` | `payin:create` | |
| **8** | GET | `/v1/h2h/crypto-currencies` | `payin:create` | |
| **9** | POST | `/v1/h2h/payin-instances` | `payin:create` | `Idempotency-Key` recommended. Example: [§6.4](#64-h2h-upi-pay-in--create-post). |
| **10** | POST | `/v1/h2h/buyer-confirms-payment` | `payin:create` | Example: [§6.5](#65-h2h--buyer-confirms-payment-post). No idempotency header. |
| **11** | POST | `/v1/cpg/payin-requests` | `payin:create` | Example body: [§6.6](#66-cpg-pay-in--create-post). |
| **12** | GET | `/v1/cpg/payin-information/:transactionId` | `payin:create` | Use `transactionId` from **11**. |
| **13** | GET | `/v1/cpg/payin-history?rows=20&page=1` | `payin:create` | |
| **14** | POST | `/v1/cpg/payout-requests` | `payout:create` | Needs **sufficient balance**. Example body: [§6.9](#69-cpg-payout--create-post). |
| **15** | GET | `/v1/cpg/payout-information/:transactionId` | `payout:create` | From **14**. |
| **16** | GET | `/v1/cpg/payout-history?rows=20&page=1` | `payout:create` | |
| **17** | GET | `/v1/merchant-details` | `internal_transfer:create` | Discover UUIDs for **18**. |
| **18** | POST | `/v1/internal-transfer` | `internal_transfer:create` | Example body: [§6.13](#613-internal-transfer-post). |
| **19** | GET | `/v1/transactions/:transactionId` | (same key) | `transactionId` from step **9** or **11**. |
| **20** | GET | `/v1/transactions?type=payin` | (same key) | India rows: `rail: india`, `railLabel` e.g. `India UPI (H2H)`. |

**Practical notes**

- Steps **9–10** (UPI H2H) or **11** (CPG pay-in) may create **real** upstream state; use **test** keys and small amounts.
- **14** debits the **merchant wallet** in **settled** currency — fund that pocket first (e.g. prior pay-in) or expect `Insufficient balance`.
- Steps you cannot complete without UPI app / chain (**9–10**) or full CPG flow (**11**) still validate **HTTP + auth + validation** if Tylt returns an error — capture status and body.
- **Webhook E2E** remains outside Postman unless you tunnel; see [§9](#9-webhooks--what-postman-does-not-cover).

---

## 12. Related docs

- `docs/TYLT_EUR_OPEN_BANKING.md` — **EU Open Banking only** (Postman §1–12, `/v1/eur/*`). Not duplicated here.
- `docs/POSTMAN_MERCHANT_API_GUIDE.md` — **Bangladesh domestic** pay-in/payout (`/v1/payins`, `/v1/payouts`, `/v1/balance`).
- `docs/PORTAL_FRONTEND_SPEC.md` — **Merchant dashboard UI** (`/portal/*`, JWT). Not a substitute for this Postman guide.
- `docs/MONEY_INVARIANTS.md` — wallet / ledger / payout debit semantics.
- `docs/WEBHOOK_DEDUPE_AND_IDEMPOTENCY.md` — provider callback dedupe and merchant `Idempotency-Key` behavior.
- `docs/HIGH_TRAFFIC_POSTURE.md` — outbound HTTP and rate limits (affects retries under load).

---

## Changelog

- **EU:** Full Postman flow moved to `docs/TYLT_EUR_OPEN_BANKING.md` (§1–12); this file remains India-only.
- **Scope:** Tylt-only; Bangladesh moved to `POSTMAN_MERCHANT_API_GUIDE.md`. TL Pay concepts, **`GET /v1/transactions/:transactionId`**, merchant-safe `rail` / `railLabel` on transaction list.
- **India UPI:** Merchant API is **H2H only** — `POST /v1/crossramp/payin-instances` is **not** registered. **`/v1/h2h/...`** + webhooks **`/webhooks/tylt/h2h/...`** for new flows.
- **Merchant paths:** **`/v1/h2h`**, **`/v1/cpg`**, **`/v1/supported`**, **`/v1/account-balance`**, **`/v1/merchant-details`**, **`/v1/internal-transfer`** (no processor segment). **`/v1/tylt/...`** remains a **legacy alias** where routes exist. Scope **`internal_transfer:create`** preferred; **`tylt:internal_transfer`** still accepted.
- **Postman cookbook (§6):** Copy-paste URLs, JSON bodies, query rules (`account-balance` passthrough, `rows`/`page`), idempotency table (`buyer-confirms` excluded), `Content-Type` / GET body note, path to Zod in repo.
- **Audience:** Clarified this guide is for **Postman / server-side `/v1` testing** (Transacty operators + merchant backend integrators), **not** for merchant portal frontend (`PORTAL_FRONTEND_SPEC.md`).
- **Regression (§11):** Links into cookbook examples; §6 cookbook added as the primary Postman reference.
- **Initial:** Merchant-facing Tylt route list, HMAC rules, Postman variables + pre-request script template, flows and webhook limitations.
