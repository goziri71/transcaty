# Postman guide — Brazil (PIX) Merchant API (`/v1/br/*`)

Test the **Brazil PIX** server-to-server endpoints in Postman. This covers **only** the **Merchant API** under **`/v1/*`**, authenticated with **HMAC** headers (`X-Transacty-Key`, `X-Transacty-Signature`, `X-Transacty-Timestamp`) — the same signing as `docs/POSTMAN_MERCHANT_API_GUIDE.md`, just the Brazil routes.

This guide does **not** cover the dashboard (`/portal/*`, JWT) — that's the merchant's UI, not the developer API.

| Surface | Not covered here |
|---------|------------------|
| `/portal/*` | Merchant dashboard (JWT) |
| `/provider/*` | Transacty internal admin |

---

## What you'll do

1. Create a test merchant (API key + secret)
2. **Ensure the `brazil` market is approved** (required, or `/v1/br/*` returns `403`)
3. Set up Postman signing (once)
4. `GET /v1/me` — confirm auth
5. `GET /v1/balance` — see the BRL wallet
6. `POST /v1/br/payins` — create a PIX pay-in
7. `GET /v1/payins/:id` — pay-in status
8. `POST /v1/br/payouts` — create a PIX payout
9. `GET /v1/payouts/:id` — payout status
10. `GET /v1/transactions` — list

---

## Before you start

- Server running: `npm run dev`
- DB migrated: `npm run db:migrate`
- `.env` has `ENCRYPTION_MASTER_KEY` and PayOK credentials

---

## Step 0: Create a test merchant

```bash
npm run db:seed-merchant
```

Copy the **API Key** (`transacty_…`) and the **Secret** — you'll paste them into Postman.

---

## Step 0.5: Approve the `brazil` market (required)

`/v1/br/*` is gated on the **`brazil`** market. Without it you get:

```json
{ "error": "Forbidden", "code": "market_not_enabled",
  "message": "Payment market \"brazil\" is not enabled. Request activation in the merchant portal." }
```

Approve it for your test merchant (Transacty **provider/admin** auth — separate from HMAC; see `docs/POSTMAN_PROVIDER_ADMIN_API_GUIDE.md`):

```
PATCH /provider/merchants/{merchantId}/markets/brazil
{ "entitlementStatus": "approved" }
```

Approval provisions the **BRL** wallet (`test` + `live`). Confirm with `GET /v1/balance` (Step 3) before creating payments.

> **Funding for payout tests:** a payout debits the BRL wallet, so it needs a balance. Either complete a BRL pay-in first (settles via the PayOK callback to `/webhooks/payok/payin`), or have the team credit the test BRL wallet. A freshly provisioned wallet is `0.00` and payouts will return `400 Insufficient balance`.

---

## Step 1: Set up Postman (once)

### 1.1 Collection
New → **Collection** → name it "Transacty Brazil PIX".

### 1.2 Environment variables

| Variable | Value |
|----------|-------|
| `baseUrl` | `http://localhost:3000` |
| `apiKey` | your API Key |
| `secret` | your Secret |

Select this environment (top-right).

### 1.3 Pre-request Script (signs every request)

Collection → **Edit** → **Pre-request Script**:

```javascript
// Transacty HMAC signing – runs before every request in this collection
const apiKey = pm.environment.get("apiKey");
const secret = pm.environment.get("secret");

if (!apiKey || !secret) {
  console.warn("Set apiKey and secret in your environment!");
  return;
}

const timestamp = Math.floor(Date.now() / 1000).toString();
const body = pm.request.body.raw || "";
const payload = timestamp + "." + body;

const signature = CryptoJS.HmacSHA256(payload, secret).toString(CryptoJS.enc.Hex);

pm.environment.set("timestamp", timestamp);
pm.environment.set("signature", signature);
```

**Must be on Pre-request Script**, not Tests — otherwise the server gets no headers and returns `401`.

### 1.4 Collection headers

| Key | Value |
|-----|-------|
| `X-Transacty-Key` | `{{apiKey}}` |
| `X-Transacty-Signature` | `{{signature}}` |
| `X-Transacty-Timestamp` | `{{timestamp}}` |
| `Content-Type` | `application/json` |

> The signature covers the **raw body**. Keep the body you send **identical** to what the pre-request script read — don't let Postman reformat it after signing.

---

## Step 2: Confirm auth

**`GET {{baseUrl}}/v1/me`** (no body)

```json
{ "merchantId": "…", "scopes": ["payin:create","payout:create","balance:read","*"], "environment": "test" }
```

`401` → check `apiKey`/`secret`. You need `payin:create` and `payout:create` scopes (or `*`).

---

## Step 3: Check the BRL wallet

**`GET {{baseUrl}}/v1/balance`**

Look for the **BRL** pocket. If it's missing, the `brazil` market isn't approved yet (Step 0.5).

---

## Step 4: Create a PIX pay-in

**`POST {{baseUrl}}/v1/br/payins`**

Body (raw JSON):

```json
{
  "amount": "100.00",
  "paymentMethodCode": "PIX",
  "returnUrl": "https://example.com/checkout/return",
  "customer": {
    "name": "Ana Souza",
    "email": "ana@example.com",
    "phone": "+5511999999999",
    "deviceId": "postman-device-1"
  },
  "goodsInfo": { "name": "Test order 4821" }
}
```

**Expected `200`:**

```json
{
  "transactionId": "…uuid…",
  "status": "pending",
  "amount": "100.00",
  "platformOrderId": "…",
  "paymentInfo": { "content": "…", "type": "url | code | html | json" },
  "expiresAt": "…",
  "currency": "BRL",
  "fees": { "platformFee": "…", "feeType": "payin", "feeStatus": "estimated" },
  "netAmount": "…"
}
```

- Save `transactionId` for Step 5.
- `paymentInfo` is what a real customer would use to pay (PIX code/QR). It stays **`pending`** until PayOK confirms via webhook.
- **Amount bounds:** `10.00`–`15000.00` BRL. Outside → `400 "Amount must be between 10 and 15000 BRL"`.

**Optional idempotency:** add header `Idempotency-Key: <unique>` to make retries safe.

---

## Step 5: Pay-in status

**`GET {{baseUrl}}/v1/payins/{{transactionId}}`**

```json
{ "id":"…","status":"pending|success|failed","amount":"100.00","paidAmount":"…",
  "paymentMethod":"PIX","currency":"BRL","fees":{…}, "createdAt":"…","completedAt":"…" }
```

Status flips to `success` only after the PayOK callback settles it.

---

## Step 6: Create a PIX payout

Requires a funded BRL wallet (see Step 0.5 note).

**`POST {{baseUrl}}/v1/br/payouts`**

```json
{
  "amount": "50.00",
  "benificiaryAccountInfo": {
    "number": "ana@example.com",
    "orgId": "<bank/institution id>",
    "orgCode": "<bank/institution code>",
    "orgName": "<bank/institution name>",
    "holderName": "Ana Souza"
  },
  "cardHolderInfo": {
    "firstName": "Ana",
    "lastName": "Souza",
    "email": "ana@example.com",
    "phone": "+5511999999999"
  }
}
```

- For PIX, `number` = the **PIX key**; `orgId/orgCode/orgName` identify the destination bank/institution (get the valid codes from the Transacty team — see `docs/MERCHANT_BRAZIL_PIX_INTEGRATION.md` §7).
- `cardHolderInfo` is the originator (Travel Rule).

**Expected `200`:**

```json
{
  "transactionId": "…", "status": "pending", "amount": "50.00",
  "platformOrderId": "…", "estimatedCompletion": "…",
  "recipient": { "benificiaryAccountInfo": {…}, "cardHolderInfo": {…} },
  "currency": "BRL",
  "fees": { "platformFee": "…", "feeType": "payout", "feeStatus": "estimated" },
  "totalWalletDebit": "…"
}
```

**Failure cases to test:**
- Empty wallet → `400 "Insufficient balance"`.
- Provider rejects the request → `400` with `"code": "payment_provider_rejected"` and the provider's reason in `message` (the debit is auto-refunded, transaction `failed`).

---

## Step 7: Payout status

**`GET {{baseUrl}}/v1/payouts/{{transactionId}}`** — same shape as pay-in status; `status` settles via the PayOK payout callback.

---

## Step 8: List transactions

**`GET {{baseUrl}}/v1/transactions`** (optionally `?type=payin` or `?type=payout`)

Brazil rows carry `currency: "BRL"`, `rail: "brazil"`, `railLabel: "Brazil …"`.

---

## Quick reference

| Step | Request |
|------|---------|
| Who am I | `GET /v1/me` |
| Balance (BRL) | `GET /v1/balance` |
| Create PIX pay-in | `POST /v1/br/payins` |
| Pay-in status | `GET /v1/payins/:id` |
| Create PIX payout | `POST /v1/br/payouts` |
| Payout status | `GET /v1/payouts/:id` |
| List | `GET /v1/transactions` |

**Troubleshooting**

| Symptom | Cause |
|---------|-------|
| `401 Missing X-Transacty-*` | Pre-request script not on the right tab, or headers not set. |
| `401 Invalid signature` | Body changed after signing, or wrong `secret`. |
| `401 timestamp expired` | Clock skew > ±5 min. |
| `403 market_not_enabled` | `brazil` market not approved (Step 0.5). |
| `403 Missing scope` | Key lacks `payin:create` / `payout:create`. |
| `400 Insufficient balance` | BRL wallet not funded (payout). |
