# EU Open Banking (EUR/GBP ↔ USDC) — Postman guide & operator reference

## Who this guide is for

- **Transacty operators / you** — Postman (or similar) against **`/v1/eur/*`** only. Use a **separate collection or folder** from India (`/v1/h2h`, `/v1/cpg`) so paths and webhook expectations do not mix.
- **Merchant backend engineers** — Server-to-server HMAC; never put the API secret in a browser or mobile app.

**India + CPG Postman (different product):** `docs/TYLT_MERCHANT_API_TESTING.md` — do **not** use H2H or UTR flows for EUR.

## Status

**Implemented.** Merchant API: `/v1/eur/*` (legacy alias `/v1/tylt/eur/*`). Webhooks: `/webhooks/tylt/eur-payin|eur-payout/:environment`. Settlement wallet currency: **USDC**. Requires TL Pay **Prime Fiat** on your account plus **`merchantUrl`** (HTTPS) or full **`merchantDetails`** on create.

---

## Start here (simple Postman flow)

If you only want to test quickly, use this section only.

### What you need first

1. `baseUrl` (your API URL), example: `https://api.transacty.ai`
2. Merchant API key + secret (HMAC)
3. Scope on key: `payin:create,payout:create,balance:read` (or `*` in test)
4. Merchant KYC verified if `KYC_REQUIRED=true`
5. TL Pay Prime Fiat enabled on your account
6. For payout testing: enough **USDC** in merchant wallet

### Collection variables (Postman)

- `baseUrl`
- `merchantKey`
- `merchantSecret`
- `transactionId` (empty at start)
- `payoutTransactionId` (empty at start)

### Pre-request script (HMAC) — add once to collection

```javascript
const ts = Math.floor(Date.now() / 1000).toString();
let rawBody = "";
if (["POST", "PUT", "PATCH", "DELETE"].includes(pm.request.method)) {
  rawBody = pm.request.body && pm.request.body.raw ? pm.request.body.raw : "";
}
const payload = ts + "." + rawBody;
const secret = pm.collectionVariables.get("merchantSecret");
const sig = CryptoJS.HmacSHA256(payload, secret).toString(CryptoJS.enc.Hex);
pm.request.headers.upsert({ key: "X-Transacty-Key", value: pm.collectionVariables.get("merchantKey") });
pm.request.headers.upsert({ key: "X-Transacty-Timestamp", value: ts });
pm.request.headers.upsert({ key: "X-Transacty-Signature", value: sig });
pm.request.headers.upsert({ key: "Content-Type", value: "application/json" });
```

### Simple test order (6 steps)

1. **Create EU pay-in**  
   `POST {{baseUrl}}/v1/eur/payin-instances`
2. **Open checkoutUrl** from response in browser and complete bank flow
3. **Check pay-in status**  
   `GET {{baseUrl}}/v1/eur/payin-instances/{{transactionId}}`
4. **Create EU payout**  
   `POST {{baseUrl}}/v1/eur/payout-instances`
5. **Approve payout** (if required)  
   `POST {{baseUrl}}/v1/eur/payout-instances/{{payoutTransactionId}}/approve`
6. **Check payout status**  
   `GET {{baseUrl}}/v1/eur/payout-instances/{{payoutTransactionId}}`

### Copy-paste bodies

#### 1) Create EU pay-in (EUR)

`POST {{baseUrl}}/v1/eur/payin-instances`

```json
{
  "amount": "100",
  "currencySymbol": "EUR",
  "returnUrl": "https://merchant.example.com/eur-return",
  "merchantUrl": "https://merchant.example.com",
  "userDetails": {
    "email": "payer@example.com"
  }
}
```

Expected: `transactionId`, `instanceId`, `checkoutUrl`, `settlementCurrency: "USDC"`.

#### 2) Create EU pay-in (GBP)

Same body, only change:

```json
{
  "amount": "100",
  "currencySymbol": "GBP",
  "returnUrl": "https://merchant.example.com/eur-return",
  "merchantUrl": "https://merchant.example.com",
  "userDetails": {
    "email": "payer@example.com"
  }
}
```

#### 3) Create EU payout

`POST {{baseUrl}}/v1/eur/payout-instances`

```json
{
  "amount": "50",
  "currencySymbol": "EUR",
  "returnUrl": "https://merchant.example.com/eur-payout-return",
  "merchantUrl": "https://merchant.example.com",
  "userDetails": {
    "email": "merchant-ops@example.com"
  },
  "payeeDetails": {
    "name": "Jane Doe",
    "iban": "DE89370400440532013000",
    "country": "DE"
  },
  "autoMerchantApproval": 0
}
```

Expected: `transactionId`, `status` (often pending/awaiting approval), quote fields.

#### 4) Approve payout (if required)

`POST {{baseUrl}}/v1/eur/payout-instances/{{payoutTransactionId}}/approve`

Body: empty

---

**If this quick flow works, stop here.**  
Use sections below only for advanced mapping, webhook details, and implementation checklist.

**Official TL Pay references:**

- [EU Open Banking overview](https://docs.tylt.money/introduction/tylt-crossramp-fiat-crypto-solutions/eu-open-banking)
- [Pay-in EUR/GBP → USDC](https://docs.tylt.money/introduction/tylt-crossramp-fiat-crypto-solutions/eu-open-banking/open-banking-payin-eur-gbp-usdc)
- [Create pay-in instance](https://docs.tylt.money/introduction/tylt-crossramp-fiat-crypto-solutions/eu-open-banking/open-banking-payin-eur-gbp-usdc/create-a-pay-in-instance)
- [Pay-in webhook](https://docs.tylt.money/introduction/tylt-crossramp-fiat-crypto-solutions/eu-open-banking/open-banking-payin-eur-gbp-usdc/webhook-for-tylt-crossramp-pay-in)
- [Get instance information (pay-in)](https://docs.tylt.money/introduction/tylt-crossramp-fiat-crypto-solutions/eu-open-banking/open-banking-payin-eur-gbp-usdc/get-instance-informatio)
- [Payout USDC → EUR](https://docs.tylt.money/introduction/tylt-crossramp-fiat-crypto-solutions/eu-open-banking/open-banking-payout-usdc-eur)
- [Create pay-out instance](https://docs.tylt.money/introduction/tylt-crossramp-fiat-crypto-solutions/eu-open-banking/open-banking-payout-usdc-eur/create-a-pay-out-instance)
- [Approve payout](https://docs.tylt.money/introduction/tylt-crossramp-fiat-crypto-solutions/eu-open-banking/open-banking-payout-usdc-eur/approve-payout)
- [Pay-out webhook](https://docs.tylt.money/introduction/tylt-crossramp-fiat-crypto-solutions/eu-open-banking/open-banking-payout-usdc-eur/webhook-for-tylt-crossramp-pay-out)
- [Get instance information (payout)](https://docs.tylt.money/introduction/tylt-crossramp-fiat-crypto-solutions/eu-open-banking/open-banking-payout-usdc-eur/get-instance-information)

**India testing (existing):** `docs/TYLT_MERCHANT_API_TESTING.md`

---

## Who this guide is for

- **Transacty operators** — What to build, configure, and verify before merchants get EU Open Banking.
- **Merchant backend engineers** — How EU will appear on **`/v1/eur/*`** (HMAC), once shipped. Merchants never call TL Pay directly.

**Not for:** Merchant portal UI (`/portal/*`) — see **`docs/MERCHANT_INDIA_EUR_INTEGRATION.md`** (dashboard + merchant docs for India & EU) and `docs/PORTAL_FRONTEND_SPEC.md`.

---

## Product summary (TL Pay vs India)

| Topic | EU Open Banking (Prime Fiat v2) | India (what you ship today) |
|--------|----------------------------------|-----------------------------|
| **Upstream API** | `POST/GET https://api.tylt.money/v2/prime-fiat/instance/...` | `POST /h2h/in/upi/...`, CPG `/transactions/merchant/...` |
| **Checkout** | Hosted widget URL (`app.tylt.money/prime-eur-instance/...`) | H2H: UPI/QR in **your** UI + `buyer-confirms-payment` |
| **Fiat** | EUR, GBP (pay-in); EUR (pay-out) | INR (+ USDT quote side) |
| **Merchant settlement** | **USDC** credited/debited on TL Pay | INR or USDT in Transacty wallet |
| **Webhook shape** | `data.eventDetails.eventId`, `data.accounts`, `isBuying` | India UPI: `data.trade.event.id` (and related) |
| **Pay-in success event** | **`eventId` 5** — Payment Completed | India: trade events **4** / **6** (different semantics) |
| **Extra payout step** | `POST .../payout/approve` when `autoMerchantApproval = 0` | N/A (Bangladesh Payok is separate) |
| **Mandatory create fields** | `merchantDetails` (legal name, HTTPS url, internal id) | H2H: `userDetails`, amount, `currencySymbol` |

**Isolation rule:** Do **not** route EU webhooks through `applyTyltCrossRampWebhookPayload` / India `eventId` classifiers in `crossramp-payin.ts`. Use a dedicated module and `metadata.tyltProduct` ∈ `{ eur_payin, eur_payout }`.

---

## Part A — Implementation checklist

Use this as the engineering backlog. Check items off in PR order; each phase should be deployable without breaking India.

### A.0 — Prerequisites (before code)

- [ ] TL Pay enables **Prime Fiat / EU Open Banking** on your merchant account (test + live).
- [ ] Set **EU-specific** keys: `TYLT_{TEST|LIVE}_EUR_PAYIN_*` and `TYLT_{TEST|LIVE}_EUR_PAYOUT_*` (see `.env.example`). India uses `TYLT_*_INDIA_PAYIN_*` / `INDIA_PAYOUT_*`.
- [ ] **`APP_BASE_URL`** is the public origin that will receive **`/webhooks/tylt/eur-payin/{test|live}`** and **`/webhooks/tylt/eur-payout/{test|live}`** (same discipline as India — see India doc § deploy check).
- [ ] Merchant profile can supply **`merchantDetails`** (name, HTTPS website, stable internal id) for TL Pay create calls — from DB or onboarding, not free-text per request in production unless required.
- [ ] **USDC** wallet pocket exists per merchant + environment (limits, billing fees, portal display).

### A.1 — Core module (new files, no India edits)

Suggested layout (names can match your conventions):

| File / symbol | Responsibility |
|---------------|----------------|
| `services/integrations/tylt/eur-payin.ts` | Create pay-in → TL Pay `POST /v2/prime-fiat/instance/payin`; parse `instanceId`, `url`, quote fields; webhook apply pay-in |
| `services/integrations/tylt/eur-payout.ts` | Create payout, approve, webhook apply payout |
| `TYLT_PRODUCT_EUR_PAYIN = "eur_payin"` | Stored in `transactions.metadata` |
| `TYLT_PRODUCT_EUR_PAYOUT = "eur_payout"` | Stored in `transactions.metadata` |
| `provider` values | `tylt-eur-payin`, `tylt-eur-payout` (matches `transaction-rail-label.ts` prefixes) |

**Create pay-in (upstream body mapping):**

| TL Pay field | Transacty source |
|--------------|------------------|
| `merchantOrderId` | `transactions.id` (UUID) |
| `callBackUrl` | `{APP_BASE_URL}/webhooks/tylt/eur-payin/{environment}` |
| `redirectUrl` | Merchant `returnUrl` (same validation as H2H — HTTPS, max length) |
| `amount` | Merchant amount (number upstream; string in DB) |
| `currencySymbol` | `EUR` or `GBP` |
| `merchantDetails` | Merchant record / MoR fields |
| `userDetails` | Merchant-supplied object (may be `{}`) |
| `cryptoUi` | Optional; default `1` per TL Pay docs |

**Persist on success:** `externalId` = `instanceId`; metadata includes `checkoutUrl` (widget `url`), `fiatCurrency`, `cryptoCurrency: USDC`, quote snapshot if useful.

**Credit amount on success:** Use **`cryptoAmount`** from webhook `data.accounts` (normalize to 2 dp — same `normalizeMoneyAmountToTwoDecimals` as India). Ledger currency = **`USDC`**, not EUR.

### A.2 — Webhooks

- [ ] Register routes in `app.ts`:
  - `POST /webhooks/tylt/eur-payin/:environment`
  - `POST /webhooks/tylt/eur-payout/:environment`
- [ ] Verify **`X-TLP-SIGNATURE`** with pay-in vs pay-out secret (same pattern as existing `handleTyltWebhookPost`).
- [ ] Handler calls **`applyTyltWebhookByStoredRailProduct`** extension **or** dedicated apply functions that only accept `eur_payin` / `eur_payout`.
- [ ] Respond **`200`** + body **`ok`** on accepted callbacks (TL Pay does not auto-retry missed acks).
- [ ] Idempotency: terminal webhook must not double-credit USDC (same pending → success guard as CPG/CrossRamp).

**Pay-in terminal mapping (EU — do not reuse India sets):**

| `eventDetails.eventId` | Transacty action |
|------------------------|------------------|
| 1–4 | Non-terminal; optional snapshot in metadata |
| **5** | **Success** — credit USDC wallet |
| **8** | Failed |
| **9** | Failed (cancelled/expired) |
| **10** | Failed (KYC) |
| 6–7 | Refund path (pay-in doc); treat per TL Pay ops guidance |

**Pay-out terminal mapping:**

| `eventId` | Transacty action |
|-----------|------------------|
| 1–4, **11** | Non-terminal / awaiting merchant approve |
| **5** | Success — finalize payout debit |
| **8**, **9**, **10** | Failed — release hold if any |

Also honor **`isBuying`**: `1` = pay-in, `0` = pay-out when routing ambiguous payloads.

### A.3 — Merchant API (`/v1/eur/*`)

Planned surface (HMAC + scopes mirror India):

| Method | Path | Scope | Upstream |
|--------|------|--------|----------|
| POST | `/v1/eur/payin-instances` | `payin:create` | `POST /v2/prime-fiat/instance/payin` |
| GET | `/v1/eur/payin-instances/:transactionId` | `payin:create` | `GET /v2/prime-fiat/instance/details?merchantOrderId=` |
| POST | `/v1/eur/payout-instances` | `payout:create` | `POST /v2/prime-fiat/instance/payout` |
| POST | `/v1/eur/payout-instances/:transactionId/approve` | `payout:create` | `POST /v2/prime-fiat/instance/payout/approve` |
| GET | `/v1/eur/payout-instances/:transactionId` | `payout:create` | Same details GET |

Legacy aliases: `/v1/tylt/eur/...` mirror the same handlers.

**Response fields (merchant-safe):**

- `transactionId`, `status`, `instanceId`, **`checkoutUrl`** (widget — redirect end user here)
- `amount`, `fiatCurrency`, `settlementCurrency: USDC`, optional `cryptoAmount`, `rate`
- **No** TL Pay / Ivy / vendor names in JSON
- List/detail: `rail: europe`, `railLabel` e.g. `Europe pay-in` / `Europe payout` (already supported in `transaction-rail-label.ts`)

**Do not register** EU on `/v1/h2h/*` or reuse `buyer-confirms-payment`.

### A.4 — Payout approve & balance

- [ ] Create payout debits **USDC** (or holds pending) per TL Pay `cryptoAmount` at initiate/complete per their model.
- [ ] Expose approve only when metadata indicates `autoMerchantApproval === 0` and TL Pay event **11** (awaiting approval) if you surface state.
- [ ] `GET /v1/account-balance` / portal wallets show **USDC** pocket for EU settlement.

### A.5 — Reconciliation & polling

- [ ] `GET /v2/prime-fiat/instance/details` — sign query JSON as `{ merchantOrderId }` (same as TL Pay doc).
- [ ] Use when webhooks missed; optional provider-admin reconcile route later.
- [ ] Document daily TL Pay reconciliation (~2:00–2:30 UTC) — merchant balance may lag until batch; webhooks still drive per-tx `success` in Transacty.

### A.6 — Merchant outbound webhooks (optional)

- [ ] On terminal pay-in/payout, emit Transacty → merchant events (`payin.completed`, `payout.completed`, etc.) via existing `PATCH /v1/me/webhook` machinery.

### A.7 — Tests & docs

- [ ] Unit tests: EU `eventId` classifier, webhook payload extractors, `merchantOrderId` resolution.
- [ ] No regression on `tests/lib/transaction-rail-label.test.ts` (europe cases already present).
- [ ] Update this doc’s **Status** section when routes go live.
- [ ] Add EU rows to portal spec when UI shows USDC / Europe rail.

### A.8 — Explicit non-goals (first slice)

- India H2H UTR / `paymentInstructions` / QR flows
- CPG travel-rule endpoints
- GBP payout (TL Pay: “shortly” — pay-in GBP only until confirmed)
- Reusing `/webhooks/tylt/h2h/` or `/webhooks/tylt/crossramp/` for EU traffic

---

## 1. Prerequisites

| Requirement | Notes |
|-------------|--------|
| Transacty base URL | e.g. `https://api.example.com` or ngrok URL for local dev. |
| **`APP_BASE_URL`** on server | Must be the **same public origin** that receives `POST /webhooks/tylt/eur-payin/test` (and payout). Sent to TL Pay as `callBackUrl` prefix. |
| TL Pay credentials | `TYLT_TEST_EUR_PAYIN_*` / `TYLT_TEST_EUR_PAYOUT_*` (falls back to `TYLT_TEST_PAYIN_*` / `PAYOUT_*` then legacy). See `.env.example`. |
| Prime Fiat / EU enabled | Ask TL Pay if `POST /v2/prime-fiat/instance/payin` returns 403/404 on your keys. |
| Merchant API key | Portal → API keys; environment **`test`** until you intend live. |
| Scopes | `payin:create`, `payout:create`, `balance:read` — or `*` in sandbox only. |
| KYC | If `KYC_REQUIRED=true`, merchant must be **`verified`**. |
| **`merchantUrl`** | **HTTPS** URL of the merchant site, **or** pass full **`merchantDetails`** in the JSON body (see [§8.2](#82-eu-pay-in--create-post)). |
| USDC balance (payout) | Payout debits the merchant **USDC** wallet after create (from quote `cryptoAmount`). Fund via a successful EU pay-in first. |

---

## 2. Authentication (every `/v1/*` request)

Same as India doc: headers **`X-Transacty-Key`**, **`X-Transacty-Timestamp`**, **`X-Transacty-Signature`**.

Signing payload: `{timestamp}.{rawBody}` — for GET with no body, sign `1730000000.` (timestamp + dot only).

| Header | Value |
|--------|--------|
| `X-Transacty-Key` | Public API key |
| `X-Transacty-Timestamp` | Unix seconds |
| `X-Transacty-Signature` | HMAC-SHA256 hex (lowercase) of `timestamp + "." + rawBody` |

Full algorithm and idempotency table: `docs/TYLT_MERCHANT_API_TESTING.md` §2.

---

## 3. Postman setup (EU collection)

Create a collection **“Transacty — EU Open Banking”** (separate from **“Transacty — India Tylt”**).

### 3.1 Collection variables

| Variable | Example | Notes |
|----------|---------|--------|
| `baseUrl` | `https://api.example.com` | Your Transacty API |
| `merchantKey` | From portal | Public key |
| `merchantSecret` | From portal | **Secret** type in Postman |
| `transactionId` | *(empty)* | Set from Tests script or manually after create |
| `instanceId` | *(empty)* | From create response |
| `checkoutUrl` | *(empty)* | Open in browser for payer |
| `merchantWebsite` | `https://merchant.example.com` | HTTPS; used in create body as `merchantUrl` |
| `idempotencyKey` | `{{$guid}}` | New UUID per **new** create; reuse only when retrying same body |

### 3.2 Pre-request script (HMAC)

Add to the **EU collection** (or folder) **Pre-request Script** — same as India:

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

### 3.3 Tests script (optional — save IDs after create)

On **POST** `/v1/eur/payin-instances` and **POST** `/v1/eur/payout-instances`, under **Tests**:

```javascript
if (pm.response.code === 200) {
  const j = pm.response.json();
  if (j.transactionId) pm.collectionVariables.set("transactionId", j.transactionId);
  if (j.instanceId) pm.collectionVariables.set("instanceId", j.instanceId);
  if (j.checkoutUrl) pm.collectionVariables.set("checkoutUrl", j.checkoutUrl);
}
```

### 3.4 Idempotency (create only)

| Route | `Idempotency-Key` header |
|-------|---------------------------|
| `POST /v1/eur/payin-instances` | **Recommended** |
| `POST /v1/eur/payout-instances` | **Recommended** |
| `POST /v1/eur/payout-instances/:id/approve` | Optional |
| All GETs | No |

---

## 4. Smoke tests (do this first)

| Step | Method | Path | Expect |
|------|--------|------|--------|
| A | GET | `{{baseUrl}}/health` | No HMAC. `200`. |
| B | GET | `{{baseUrl}}/v1/me` | Empty body signing. `200` → `environment`, `scopes`. |
| C | GET | `{{baseUrl}}/v1/account-balance` | Scope `balance:read`. Confirm a **USDC** row when you have EU traffic. |

---

## 5. Amount limits (app-level)

| Flow | Field | Bounds |
|------|--------|--------|
| EU pay-in | `amount` + `currencySymbol` | **EUR:** 1 … 50_000. **GBP:** 1 … 50_000. |
| EU payout | `amount` + `currencySymbol` | **EUR** only: 1 … 50_000. |

---

## 6. Merchant quick test — EU pay-in (widget)

**Not India:** no UPI, no `buyer-confirms-payment`, no `/v1/h2h/*`.

Aligned with TL Pay: [Create pay-in instance](https://docs.tylt.money/introduction/tylt-crossramp-fiat-crypto-solutions/eu-open-banking/open-banking-payin-eur-gbp-usdc/create-a-pay-in-instance) → [webhooks](https://docs.tylt.money/introduction/tylt-crossramp-fiat-crypto-solutions/eu-open-banking/open-banking-payin-eur-gbp-usdc/webhook-for-tylt-crossramp-pay-in) (`eventId` **5** = completed) → USDC credited.

| Step | Action | Method & path | Notes |
|------|--------|---------------|-------|
| **0** | Postman + HMAC | — | [§3](#3-postman-setup-eu-collection) |
| **1** | Create pay-in | `POST /v1/eur/payin-instances` | [§8.2](#82-eu-pay-in--create-post). Save `transactionId`, `checkoutUrl`. |
| **2** | Open widget | **Browser** | Paste `{{checkoutUrl}}` — TL Pay hosted Open Banking UI. |
| **3** | Customer pays | TL Pay sandbox | Per TL Pay EU checklist (bank auth). |
| **4** | Webhooks | Server logs | `POST {APP_BASE_URL}/webhooks/tylt/eur-payin/test` → respond `ok`. Terminal **`eventId: 5`**. |
| **5** | Check transaction | `GET /v1/transactions/{{transactionId}}` | `status: success`, `rail: europe`, `paidAmount` in USDC. |
| **6** | (Optional) Poll instance | `GET /v1/eur/payin-instances/{{transactionId}}` | `eventId`, `upstream` from TL Pay details API. |

**Deploy check:** If create works but status stays `pending`, `APP_BASE_URL` on the server probably does not match the host receiving **`/webhooks/tylt/eur-payin/test`**.

---

## 7. Merchant quick test — EU payout (+ optional approve)

| Step | Action | Method & path | Notes |
|------|--------|---------------|-------|
| **1** | USDC balance | `GET /v1/account-balance` | Need USDC from pay-in or ops credit. |
| **2** | Create payout | `POST /v1/eur/payout-instances` | [§8.4](#84-eu-payout--create-post). Debits USDC on success. |
| **3** | Widget | Browser | `checkoutUrl` for end user off-ramp. |
| **4** | Approve (if needed) | `POST /v1/eur/payout-instances/{{transactionId}}/approve` | Only if `autoMerchantApproval: 0` and TL Pay shows event **11**. |
| **5** | Webhooks | Server | `/webhooks/tylt/eur-payout/test` → **`eventId: 5`**. |
| **6** | Verify | `GET /v1/transactions/{{transactionId}}` | `type: payout`, `rail: europe`. |

---

## 8. Postman request cookbook (copy-paste)

Use **`{{baseUrl}}`** and the EU collection **Pre-request Script** on every row.

**GET:** empty body; sign `timestamp.` only.

**POST:** Body → raw → JSON; `Content-Type: application/json`.

### 8.1 Account balance (GET)

- **URL:** `{{baseUrl}}/v1/account-balance`
- **Scope:** `balance:read` or `*`
- **Expect:** Rows per currency; look for **`USDC`** after EU pay-in.

### 8.2 EU pay-in — create (POST)

- **URL:** `{{baseUrl}}/v1/eur/payin-instances`
- **Scope:** `payin:create` or `*`
- **Header:** `Idempotency-Key: {{$guid}}`

**Body (minimal — requires `returnUrl` + `merchantUrl` or `merchantDetails`):**

```json
{
  "amount": "30.00",
  "currencySymbol": "EUR",
  "returnUrl": "https://merchant.example.com/checkout/return",
  "merchantUrl": "{{merchantWebsite}}",
  "userDetails": {
    "firstName": "Test",
    "lastName": "User",
    "email": "payer@example.com",
    "country": "Poland",
    "dob": "1990-01-01"
  }
}
```

**Body (GBP pay-in):** set `"currencySymbol": "GBP"`.

**Body (explicit merchantDetails — overrides auto-build from KYC):**

```json
{
  "amount": "50.00",
  "currencySymbol": "EUR",
  "returnUrl": "https://merchant.example.com/checkout/return",
  "merchantDetails": {
    "merchantName": "Example Merchant Ltd",
    "merchantUrl": "https://www.examplemerchant.com",
    "merchantInternalId": "merchant-12345"
  },
  "userDetails": {}
}
```

| Field | Required | Notes |
|-------|----------|--------|
| `amount` | yes | Decimal string; bounds [§5](#5-amount-limits-app-level). |
| `currencySymbol` | yes | `EUR` or `GBP`. |
| `returnUrl` | yes | Absolute URL; HTTPS except localhost. Max 200 chars. |
| `merchantUrl` | conditional | HTTPS if `merchantDetails` omitted; or use KYC + env on server. |
| `merchantDetails` | optional | All three subfields if sent. |
| `userDetails` | optional | `{}` allowed; pre-fills widget per TL Pay. |
| `cryptoUi` | optional | `0` fiat UI, `1` crypto UI (default). |

**Expect (200):**

```json
{
  "transactionId": "uuid",
  "status": "pending",
  "amount": "30.00",
  "fiatCurrency": "EUR",
  "settlementCurrency": "USDC",
  "instanceId": "uuid",
  "checkoutUrl": "https://app.tylt.money/prime-eur-instance/...",
  "cryptoAmount": "35.12",
  "rate": 0.85
}
```

**Common 400:** `invalid_merchant_details` — missing KYC legal name or non-HTTPS `merchantUrl`. **`payment_provider_rejected`** — TL Pay message in `message`.

### 8.3 EU pay-in — status (GET)

- **URL:** `{{baseUrl}}/v1/eur/payin-instances/{{transactionId}}`
- **Scope:** `payin:create` or `*`
- **Expect:** `eventId`, `checkoutUrl`, `detailsSource: live|local`, optional `upstream` object.

### 8.4 EU payout — create (POST)

- **URL:** `{{baseUrl}}/v1/eur/payout-instances`
- **Scope:** `payout:create` or `*`
- **Header:** `Idempotency-Key: {{$guid}}`

**Body:**

```json
{
  "amount": "25.00",
  "currencySymbol": "EUR",
  "returnUrl": "https://merchant.example.com/payout/return",
  "merchantUrl": "{{merchantWebsite}}",
  "autoMerchantApproval": 1,
  "userDetails": {
    "firstName": "Test",
    "lastName": "User",
    "email": "beneficiary@example.com",
    "country": "France",
    "dob": "1990-01-01"
  },
  "payeeDetails": {
    "iban": "FR7630006000011234567890185"
  }
}
```

| Field | Required | Notes |
|-------|----------|--------|
| `payeeDetails` | yes | At least `iban` for pre-fill; object can include other TL Pay keys. |
| `autoMerchantApproval` | optional | `1` auto (default), `0` requires [§8.5](#85-eu-payout--approve-post). |
| `currencySymbol` | yes | **`EUR` only** for payout today. |

**Expect (200):** Same shape as pay-in create (`checkoutUrl`, `instanceId`, etc.). Server debits **USDC** using quoted `cryptoAmount` when present.

**Common 400:** `payout_failed` / insufficient USDC — fund wallet first.

### 8.5 EU payout — approve (POST)

- **URL:** `{{baseUrl}}/v1/eur/payout-instances/{{transactionId}}/approve`
- **Scope:** `payout:create` or `*`
- **Body:** none (empty raw body → sign `timestamp.`)

**Expect (200):** `{ "transactionId": "...", "acknowledged": true }`

Call when create used `"autoMerchantApproval": 0` and TL Pay webhook showed **`eventId: 11`**.

### 8.6 EU payout — status (GET)

- **URL:** `{{baseUrl}}/v1/eur/payout-instances/{{transactionId}}`
- **Scope:** `payout:create` or `*`

### 8.7 Transactions list / detail (GET)

- **Detail:** `GET {{baseUrl}}/v1/transactions/{{transactionId}}`
- **List:** `GET {{baseUrl}}/v1/transactions?type=payin` or `type=payout`

**Expect on EU rows:** `rail: europe`, `railLabel: Europe pay-in` or `Europe payout`, `currency: USDC` (settlement), no vendor names.

---

## 9. Webhooks — what Postman does *not* cover

| Direction | URL |
|-----------|-----|
| **TL Pay → Transacty** | `POST {APP_BASE_URL}/webhooks/tylt/eur-payin/{test\|live}` |
| **TL Pay → Transacty** | `POST {APP_BASE_URL}/webhooks/tylt/eur-payout/{test\|live}` |
| **Transacty → merchant** | Optional: `PATCH /v1/me/webhook` → your URL gets `payin.completed` / `payout.failed` etc. |

You can test **create** in Postman without webhooks; rows stay **`pending`** until TL Pay POSTs to your server (use **ngrok** locally).

**Do not** point TL Pay EU callbacks at `/webhooks/tylt/h2h/` — India handler will ignore them.

---

## 10. EU `eventId` reference (TL Pay → webhook logs)

**Pay-in (`isBuying: 1`):**

| eventId | Description |
|---------|-------------|
| 1 | Instance created |
| 2 | Order created |
| 3 | Order processing |
| 4 | Payment processing |
| **5** | **Payment completed** → credit USDC |
| 6 | Refund processing |
| 7 | Payment refunded |
| 8 | Payment failed |
| 9 | Order cancelled or expired |
| 10 | KYC failed |

**Pay-out (`isBuying: 0`):**

| eventId | Description |
|---------|-------------|
| 1–5 | Same progression as pay-in doc |
| 8 | Payment failed |
| 9 | Cancelled / expired |
| 10 | KYC failed |
| **11** | Pending merchant final approval |

### 10.1 Upstream ↔ Transacty mapping

| TL Pay | Transacty merchant API |
|--------|-------------------------|
| `POST /v2/prime-fiat/instance/payin` | `POST /v1/eur/payin-instances` |
| `POST /v2/prime-fiat/instance/payout` | `POST /v1/eur/payout-instances` |
| `POST /v2/prime-fiat/instance/payout/approve` | `POST /v1/eur/payout-instances/:transactionId/approve` |
| `GET /v2/prime-fiat/instance/details?merchantOrderId=` | `GET /v1/eur/payin-instances/:id` or payout variant |
| Webhook `data.merchantOrderId` | `transactions.id` |
| `data.instanceId` | `transactions.externalId` / `instanceId` in API |

---

## 11. Full Postman regression order (EU only)

Run in order after [§4](#4-smoke-tests-do-this-first). Use **test** API key until you intentionally test live.

| # | Method | Path | Scope | Notes |
|---|--------|------|--------|--------|
| **0** | GET | `/health` | — | |
| **1** | GET | `/v1/me` | any | |
| **2** | GET | `/v1/account-balance` | `balance:read` | USDC row |
| **3** | POST | `/v1/eur/payin-instances` | `payin:create` | [§8.2](#82-eu-pay-in--create-post); `Idempotency-Key` |
| **4** | GET | `/v1/eur/payin-instances/:transactionId` | `payin:create` | From **3** |
| **5** | GET | `/v1/transactions/:transactionId` | — | `rail: europe` |
| **6** | POST | `/v1/eur/payout-instances` | `payout:create` | Needs USDC; [§8.4](#84-eu-payout--create-post) |
| **7** | POST | `/v1/eur/payout-instances/:transactionId/approve` | `payout:create` | Skip if `autoMerchantApproval: 1` |
| **8** | GET | `/v1/eur/payout-instances/:transactionId` | `payout:create` | From **6** |
| **9** | GET | `/v1/transactions?type=payout` | — | Europe payout rows |

Steps **3–5** need browser + webhooks for true `success`; without ngrok, **3** still validates auth, limits, and TL Pay create.

---

## 12. EU vs India — do not mix in Postman

| | **EU (this doc)** | **India (`TYLT_MERCHANT_API_TESTING.md`)** |
|--|-------------------|-------------------------------------------|
| Create pay-in | `POST /v1/eur/payin-instances` | `POST /v1/h2h/payin-instances` |
| Checkout | `checkoutUrl` widget | UPI / QR in your UI |
| Confirm payment | *(none)* | `POST /v1/h2h/buyer-confirms-payment` + UTR |
| Webhook path | `/webhooks/tylt/eur-payin/...` | `/webhooks/tylt/h2h/...` |
| Success signal | `eventDetails.eventId` **5** | `trade.event.id` **4** / **6** |
| Settlement | **USDC** | INR or USDT |

---

## Part C — Environment variables

| Variable | Purpose |
|----------|---------|
| `TYLT_TEST_EUR_PAYIN_API_KEY` / `SECRET` | EU pay-in create + `/webhooks/tylt/eur-payin/*` HMAC |
| `TYLT_TEST_EUR_PAYOUT_API_KEY` / `SECRET` | EU payout + `/webhooks/tylt/eur-payout/*` HMAC |
| Optional `TYLT_*_EUR_*_BASE_URL` | Default `https://api.tylt.money` |
| `TYLT_TEST_PAYIN_*` / `PAYOUT_*` | Fallback if EUR_* unset (shared with India lane) |
| `APP_BASE_URL` | Webhook + `callBackUrl` host |

Optional: `TYLT_EUR_DEFAULT_CRYPTO_UI=1`, feature flag `TYLT_EUR_ENABLED=true` for staged rollout.

---

## Related docs

- `docs/TYLT_MERCHANT_API_TESTING.md` — India H2H + CPG Postman (HMAC template, webhooks §9)
- `docs/POSTMAN_MERCHANT_API_GUIDE.md` — Bangladesh domestic
- `docs/MONEY_INVARIANTS.md` — ledger / wallet semantics
- `docs/WEBHOOK_DEDUPE_AND_IDEMPOTENCY.md` — callback dedupe
- `src/lib/transaction-rail-label.ts` — `europe` rail already defined

---

## Changelog

- **Postman:** Full EU-only flow (§1–12): setup, cookbook, quick tests, regression order, India comparison table.
- **Shipped:** `/v1/eur/*`, webhooks `/webhooks/tylt/eur-payin|eur-payout`, modules `eur-payin.ts` / `eur-payout.ts`, USDC ledger credit/debit.
- **Initial:** Implementation checklist (Part A), EU `eventId` tables, env draft.
