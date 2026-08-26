# Brazil (PIX) — merchant integration guide

How to add **Brazil PIX** pay-in and payout to a Transacty merchant. Two audiences:

| Audience | Surface | Auth |
|----------|---------|------|
| **Merchant backend engineers** | `/v1/br/*` (server-to-server) | **HMAC** (see §2) |
| **Merchant dashboard frontend** | `/portal/me/br/*` and `/portal/me/*` | **Portal JWT** |

> Brazil settles in **BRL** via **PIX**. It is a separate market/rail from Bangladesh (BDT), India (USDT), and Europe (USDC). Enabling or changing Brazil does not affect the other rails.

---

## 1. Model (read first)

| Concept | What it means |
|---------|---------------|
| **One merchant account** | One signup, KYC, API keys, `test`/`live`. Same account across all countries. |
| **One API key type** | Scopes (`payin:create`, `payout:create`, `balance:read`, …) control access — there is **no** separate "Brazil key". |
| **One auth method for the API** | **HMAC** signing on every `/v1/*` request (§2). The API secret is **server-side only** — never in the browser. |
| **Wallet pocket per currency** | Brazil money settles into a **BRL** ledger wallet. Do not sum BRL with other currencies. |
| **Rail** | Brazil transactions carry `rail: "brazil"`, `railLabel: "Brazil …"` on transaction list/detail. |
| **Market gate** | The merchant must have the **`brazil`** market **approved** before `/v1/br/*` works; otherwise `403 market_not_enabled`. |

**Limits (per transaction):** BRL **10.00 – 15,000.00** for both pay-in and payout.

---

## 2. Authentication — the ONE API method (`/v1/*`)

Every `/v1/*` call is signed with **HMAC-SHA256**. Send **three headers**:

| Header | Value |
|--------|-------|
| `X-Transacty-Key` | Your API key (starts with `transacty_`) |
| `X-Transacty-Timestamp` | Current unix time in **seconds** |
| `X-Transacty-Signature` | `HmacSHA256( "{timestamp}.{rawBody}", apiSecret )` as **lowercase hex** |
| `Content-Type` | `application/json` |

- **Signing payload** = the timestamp, a literal dot, then the **exact raw request body**. For a `GET` (no body) the payload is `"{timestamp}."` (trailing dot, empty body).
- **Replay window**: ±5 minutes — sign at request time, don't cache signatures.
- **Environment** (`test` / `live`) is bound to the key. There is no environment header.
- Optional **`Idempotency-Key`** header — safe to retry a create without double-charging.

```js
// Node example — sign and send a Brazil PIX pay-in
import crypto from "node:crypto";

const apiKey = process.env.TRANSACTY_KEY;      // transacty_...
const secret = process.env.TRANSACTY_SECRET;   // shown once at key creation
const base   = "https://<api-base>";           // your Transacty API base URL

const body = JSON.stringify({
  amount: "100.00",
  paymentMethodCode: "PIX",
  returnUrl: "https://yourapp.com/checkout/return",
  customer: { name: "Ana Souza", email: "ana@ex.com", phone: "+5511999999999", deviceId: "dev-123" },
  goodsInfo: { name: "Order #4821" },
});

const timestamp = Math.floor(Date.now() / 1000).toString();
const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

const res = await fetch(`${base}/v1/br/payins`, {
  method: "POST",
  headers: {
    "X-Transacty-Key": apiKey,
    "X-Transacty-Timestamp": timestamp,
    "X-Transacty-Signature": signature,
    "Content-Type": "application/json",
    "Idempotency-Key": "payin-4821",
  },
  body,
});
```

**Common auth failures:** `401 Unauthorized` (missing/invalid headers, expired timestamp, bad signature), `403 Forbidden` (missing scope, IP not allowlisted, or `market_not_enabled`).

---

## 3. Merchant backend API (`/v1/br/*`)

### 3.1 Create a PIX pay-in (customer pays the merchant)

`POST /v1/br/payins` — scope `payin:create`.

**Request body**

| Field | Type | Notes |
|-------|------|-------|
| `amount` | string | Decimal, 2 dp, in **BRL**. `10.00`–`15000.00`. |
| `paymentMethodCode` | string | `"PIX"` (default). |
| `returnUrl` | string | Where the customer returns after payment. Forwarded to the provider. |
| `customer` | object | `{ name, email, phone, deviceId }` — all required. |
| `goodsInfo` | object | `{ name, id?, price? }` — `name` required. |

**Response `200`**

```json
{
  "transactionId": "…uuid…",
  "status": "pending",
  "amount": "100.00",
  "platformOrderId": "…provider ref…",
  "paymentInfo": { "content": "…", "type": "url | code | html | json" },
  "expiresAt": "2026-07-01T12:15:00.000Z",
  "currency": "BRL",
  "fees": { "platformFee": "…", "feeType": "payin", "feeStatus": "estimated" },
  "netAmount": "…",
  "totalWalletDebit": null
}
```

- **`paymentInfo`** is what you render to the payer. For PIX, `type` indicates how to present `content` (e.g. a PIX copy-and-paste code / QR string). Show it and/or the QR to the customer.
- Money is **not** credited until the pay-in is confirmed (webhook / status). Treat `status: "pending"` as "awaiting payment".

### 3.2 Get pay-in status

`GET /v1/payins/:id` (generic — same endpoint for all rails).

```json
{
  "id": "…", "transactionId": "…", "status": "pending | success | failed",
  "amount": "100.00", "paidAmount": "100.00", "platformOrderId": "…",
  "paymentMethod": "PIX", "createdAt": "…", "completedAt": "…",
  "currency": "BRL", "fees": { … }, "netAmount": "…"
}
```

### 3.3 Create a PIX payout (merchant sends money out)

`POST /v1/br/payouts` — scope `payout:create`.

Debits the merchant **BRL** wallet up front, then disburses via PIX. On provider rejection the debit is auto-refunded and the transaction is marked `failed`.

**Request body**

| Field | Type | Notes |
|-------|------|-------|
| `amount` | string | BRL, 2 dp, `10.00`–`15000.00`. |
| `benificiaryAccountInfo` | object | Recipient. `{ number, orgId, orgCode, orgName, holderName }` — all required. For PIX, `number` carries the **PIX key**; `orgId/orgCode/orgName` identify the bank/institution; `holderName` is the account holder. |
| `cardHolderInfo` | object | Payer/originator (Travel Rule). `{ firstName, lastName, email, phone }` — all required. |

> ⚠️ The exact **bank/institution codes** for `orgId/orgCode/orgName` come from Transacty's Brazil provider list (see §7). Confirm the valid values before going live.

**Response `200`**

```json
{
  "transactionId": "…", "status": "pending", "amount": "500.00",
  "platformOrderId": "…", "estimatedCompletion": "2026-07-01T12:05:00.000Z",
  "recipient": { "benificiaryAccountInfo": { … }, "cardHolderInfo": { … } },
  "currency": "BRL",
  "fees": { "platformFee": "…", "feeType": "payout", "feeStatus": "estimated" },
  "netAmount": null,
  "totalWalletDebit": "…"
}
```

Insufficient wallet balance → `400` (`Insufficient balance`). Provider validation failure → `400 payment_provider_rejected` with the provider's reason in `message`.

### 3.4 Get payout status

`GET /v1/payouts/:id` (generic).

---

## 4. Merchant webhooks (Transacty → your server)

Set your outbound webhook URL in the dashboard (`PATCH /portal/me/webhook`). Transacty POSTs these events for Brazil (identical shape to other rails, `currency: "BRL"`):

| Event `type` | When |
|--------------|------|
| `payin.completed` | PIX pay-in settled — BRL wallet credited. |
| `payin.failed` | Pay-in failed/expired. |
| `payout.completed` | PIX payout settled. |
| `payout.failed` | Payout failed — BRL debit refunded. |

Example (`payin.completed`):

```json
{
  "type": "payin.completed",
  "transactionId": "…",
  "status": "success",
  "amount": "100.00",
  "paidAmount": "100.00",
  "platformOrderId": "…",
  "currency": "BRL",
  "fees": { "platformFee": "…", "feeType": "payin", "feeStatus": "applied" },
  "netAmount": "…"
}
```

Reconcile on the **webhook** (or by polling `GET /v1/payins/:id`); do not treat the create-response `pending` as final.

---

## 5. Dashboard frontend (`/portal/*`, JWT)

Portal routes use `Authorization: Bearer <portal_jwt>` (or `X-Portal-Token`) and take `environment` in the body/query. These let the merchant operate Brazil from the dashboard UI (no HMAC).

### 5.1 Enable the Brazil market

| Endpoint | Use |
|----------|-----|
| `GET /portal/me/markets` | Show market entitlements incl. **`brazil`** (status: `disabled` / `requested` / `kyb_in_review` / `approved` / `suspended`). |
| `POST /portal/me/markets/brazil/request` | Merchant requests Brazil activation (triggers KYB). |

Until Brazil is **`approved`**, `/v1/br/*` returns `403 market_not_enabled`. Approval provisions the **BRL** wallet.

### 5.2 Balances

`GET /portal/me/wallets?environment=` → one card per pocket. The Brazil card:

| Field | Value |
|-------|-------|
| `currency` | `BRL` |
| `region` | `brazil` |
| `regionLabel` / `displayLabel` | `Brazil (PIX)` |
| `market` | `brazil` |
| `activationStatus` | `active` once approved + KYB verified |
| `limits` | `{ payin: {min:10, max:15000}, payout: {min:10, max:15000} }` |

### 5.3 Transactions

`GET /portal/me/transactions?environment=&rail=brazil` — add a **Brazil** filter chip (`rail=brazil`). Rows/detail include `rail: "brazil"`, `railLabel`, `currency: "BRL"`.

### 5.4 Dashboard-initiated PIX (optional)

If the dashboard itself creates payments (not the merchant's backend):

| Endpoint | Body |
|----------|------|
| `POST /portal/me/br/payins` | `{ environment, amount, paymentMethodCode?: "PIX", returnUrl, customer, goodsInfo }` → `201` |
| `POST /portal/me/br/payouts` | `{ environment, amount, benificiaryAccountInfo, cardHolderInfo }` → `201` with `reference`, `recipient.masked`. Requires **`Idempotency-Key`**. |

Both gate on the `brazil` market and BRL limits, same as `/v1/br/*`.

---

## 6. Frontend UI checklist

- [ ] **Brazil market card** on the markets page with Request / KYB / Approved states (`GET /portal/me/markets`, `POST /portal/me/markets/brazil/request`).
- [ ] **BRL balance card** (`region: "brazil"`, label "Brazil (PIX)"), never summed with other currencies.
- [ ] **Brazil chip** on the transactions filter (`rail=brazil`).
- [ ] **PIX pay-in form**: amount (BRL, 10–15,000), customer (name/email/phone/deviceId), goods name, returnUrl. Render `paymentInfo` (PIX code / QR) from the response.
- [ ] **PIX payout form**: amount, recipient PIX key + bank org fields, originator (first/last/email/phone). Show masked recipient on success.
- [ ] Handle `403 market_not_enabled` → prompt "Enable Brazil".
- [ ] Surface `payment_provider_rejected` `message` to the operator (it carries the provider's real reason).

---

## 7. Operational prerequisites (before live money)

These are **not** frontend work but block real transactions — confirm with the Transacty team:

1. **Brazil market approved** for the merchant (provider approves the request from §5.1) → provisions the BRL wallet.
2. **A Brazil (BRL) fee schedule** configured internally — otherwise payments succeed but collect **no platform fee**.
3. **Brazil bank/institution codes** for payout `benificiaryAccountInfo` (`orgId/orgCode/orgName`) — the valid PIX destination values. Use these in the payout form.

---

## 8. Quick reference

| Action | Method + path | Auth |
|--------|---------------|------|
| Create PIX pay-in | `POST /v1/br/payins` | HMAC |
| Pay-in status | `GET /v1/payins/:id` | HMAC |
| Create PIX payout | `POST /v1/br/payouts` | HMAC |
| Payout status | `GET /v1/payouts/:id` | HMAC |
| Request Brazil market | `POST /portal/me/markets/brazil/request` | Portal JWT |
| Balances (BRL card) | `GET /portal/me/wallets?environment=` | Portal JWT |
| Transactions (Brazil) | `GET /portal/me/transactions?rail=brazil` | Portal JWT |
| Dashboard PIX pay-in | `POST /portal/me/br/payins` | Portal JWT |
| Dashboard PIX payout | `POST /portal/me/br/payouts` | Portal JWT |
