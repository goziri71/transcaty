# Public merchant docs — source of truth

Hand this to the **docs.transacty.ai** frontend. Copy the samples and flows as written. Do not keep older wording that contradicts this file.

Audience: a merchant engineer integrating **HMAC `/v1/*`** against `https://api.transacty.ai`. Portal JWT (`/portal/*`) and provider admin (`/provider/*`) are a different product — do not mix them into these pages.

Checked against the Transacty API as of 31 August 2026.

---

## How to use this file

| Live page | What to do |
|-----------|------------|
| [Home](https://docs.transacty.ai/) | Fix the PYUSD card: settle **PYUSD USDC**, not Europe USDC |
| [Merchant Onboarding](https://docs.transacty.ai/get-started) | HMAC formula, idempotency, test vs live, Bangladesh pause, wallet table |
| [Supported Methods](https://docs.transacty.ai/about) | Same wallet table; PYUSD row |
| [CORE Identity](https://docs.transacty.ai/core/identity) | Extra identity fields |
| [CORE Balance](https://docs.transacty.ai/core/balance) | `items[]`, `PYUSD-USDC` vs `USDC` |
| [CORE Transactions](https://docs.transacty.ai/core/transactions) | Drop `rail` / `status` query filters |
| [Webhooks](https://docs.transacty.ai/webhooks) | PYUSD `currency` |
| Bangladesh / Brazil create pages | Required `Idempotency-Key`; BD `goodsInfo` optional fields |
| [Europe payout](https://docs.transacty.ai/europe/payout/payout) | Body is `payeeDetails`, not `beneficiary` |
| All PYUSD pages | Full rewrite of settlement |

Do **not** invent a second test API host. Test and live use the **same** base URL and paths. The **API key** chooses the environment.

---

## 1. Global rules (print on Getting Started)

### Base URL

`https://api.transacty.ai`

There is **no** separate sandbox hostname. Create a **test** key or a **live** key in the dashboard. Every `/v1` call runs in that key’s environment (separate wallets and transactions).

### Headers (every `/v1/*` request)

| Header | Value |
|--------|--------|
| `X-Transacty-Key` | API key (`transacty_…`) |
| `X-Transacty-Timestamp` | Unix time in **seconds** (not ms) |
| `X-Transacty-Signature` | HMAC-SHA256 of `{timestamp}.{rawBody}`, **lowercase hex** |
| `Content-Type` | `application/json` on POST/PATCH |
| `Idempotency-Key` | **Required** on money writes (create pay-in / payout / payment intent). Unique per create. Replaying the same key + same body returns the first response. |

Signing payload = timestamp + a literal `.` + the **exact raw body bytes**.

- POST/PATCH: sign the JSON string you send (no re-serialize after signing).
- GET: body is empty → payload is `{timestamp}.` (trailing dot).
- Replay window: **±5 minutes**. Sign at send time; do not cache signatures.

```js
import crypto from "node:crypto";

function sign(secret, timestamp, rawBody) {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

const timestamp = Math.floor(Date.now() / 1000).toString();
const rawBody = JSON.stringify({ amount: "500.00", paymentMethodCode: "BKASH" /* … */ });
const signature = sign(process.env.TRANSACTY_SECRET, timestamp, rawBody);

await fetch("https://api.transacty.ai/v1/payins", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Transacty-Key": process.env.TRANSACTY_KEY,
    "X-Transacty-Timestamp": timestamp,
    "X-Transacty-Signature": signature,
    "Idempotency-Key": crypto.randomUUID(),
  },
  body: rawBody,
});
```

Missing `Idempotency-Key` on a create → `400` `{ "error": "Bad Request", "message": "Idempotency-Key header is required" }`.

### Scopes

Typical live key: `payin:create`, `payout:create`, `balance:read`. `*` is for non-production only.

### Markets

Each region is a separate KYB market (`bangladesh`, `brazil`, `india`, `europe`, `pyusd`). Until that market is **approved**, those `/v1` routes return `403` with `code: "market_not_enabled"`.

### Status values

Use lowercase: `pending`, `success`, `failed`. Do not document `PENDING` / `SUCCESS` as Transacty statuses.

### Settlement wallets (never mix)

| Region | Collect | Merchant pocket (`currency`) | Display |
|--------|---------|------------------------------|---------|
| Bangladesh | BDT e-wallets | `BDT` | BDT |
| Brazil | PIX | `BRL` | BRL |
| India H2H | INR via UPI | `USDT` | USDT |
| Europe | EUR/GBP Open Banking | `USDC` | USDC |
| PYUSD | PYUSD on Ethereum | `PYUSD-USDC` | **PYUSD USDC** |

**PYUSD USDC is not Europe USDC.** EUR payouts and Europe spend debit `USDC` only. They cannot spend `PYUSD-USDC`. Do not tell merchants “PYUSD settles to your USDC wallet.”

Never sum unlike currencies into one headline number.

### Test vs live

| | test | live |
|--|------|------|
| How you choose | Test API key | Live API key |
| Portal | `environment: "test"` | `environment: "live"` |
| Money | Isolated ledger | Production money |
| PYUSD | **Not available** (`503` `payment_unavailable`) | Only supported mode |

### Bangladesh availability

`POST /v1/payins` and `POST /v1/payouts` may return `503` `{ "code": "payment_unavailable" }` while the Bangladesh rail is paused. Brazil, India, Europe, and PYUSD are independent. Do not use Bangladesh as the only “super quick test” while that pause is on.

### Common errors

| HTTP | `code` | Meaning |
|------|--------|---------|
| 400 | — | Validation, or missing `Idempotency-Key` |
| 401 | — | Bad key, signature, or timestamp outside ±5 min |
| 403 | `market_not_enabled` | That region is not approved |
| 403 | — | Missing scope |
| 503 | `payment_unavailable` | Rail paused, upstream down, or PYUSD `test` key |
| 409 | — | Same `Idempotency-Key` with a **different** body |

---

## 2. CORE — Identity

**Page:** [CORE Identity](https://docs.transacty.ai/core/identity)

`GET /v1/me` — no body. Sign with `{timestamp}.`

```json
{
  "merchantId": "your-merchant-uuid",
  "merchantSlug": "acme",
  "slug": "acme",
  "businessName": "Acme Ltd",
  "scopes": ["payin:create", "payout:create", "balance:read"],
  "environment": "test"
}
```

`environment` is the **key’s** mode (`test` or `live`), not a query parameter.

---

## 3. CORE — Balance

**Page:** [CORE Balance](https://docs.transacty.ai/core/balance)

`GET /v1/balance` — no query. Returns the key’s environment.

Top-level `balance` / `availableBalance` / `pendingBalance` / `currency` / `limits` are the **primary** pocket (BDT first when it exists). Also read **`items`**: one card per currency.

```json
{
  "environment": "live",
  "balance": "1200.50",
  "availableBalance": "1200.50",
  "pendingBalance": "0.00",
  "currency": "BDT",
  "lastUpdated": "2026-08-31T10:00:00.000Z",
  "limits": {
    "payin": { "min": 200, "max": 25000 },
    "payout": { "min": 100, "max": 25000 }
  },
  "items": [
    {
      "currency": "BDT",
      "availableBalance": "1200.50",
      "pendingBalance": "0.00",
      "region": "bangladesh",
      "displayLabel": "Bangladesh"
    },
    {
      "currency": "USDC",
      "availableBalance": "80.00",
      "pendingBalance": "0.00",
      "region": "europe",
      "displayLabel": "Europe (USDC)"
    },
    {
      "currency": "PYUSD-USDC",
      "availableBalance": "25.00",
      "pendingBalance": "0.00",
      "region": "pyusd",
      "displayLabel": "PYUSD USDC"
    }
  ]
}
```

- `availableBalance` = spendable settled funds for that pocket.
- `pendingBalance` = in-flight pay-ins in that currency (not spendable).
- `GET /v1/account-balance` is **upstream operator crypto**, not the merchant ledger. Do not document it as “your balance.”

Replace any sentence that says Europe and PYUSD share one USDC pocket.

---

## 4. CORE — Transactions

**Page:** [CORE Transactions](https://docs.transacty.ai/core/transactions)

`GET /v1/transactions`

**Query params that exist**

| Param | Required | Notes |
|-------|----------|--------|
| `type` | no | `payin` or `payout` |
| `limit` | no | 1–100, default 20 |
| `offset` | no | default 0 |

**Do not document `rail` or `status` as query filters.** They are not accepted. Filter in your own code using fields on each item.

Each item includes `rail` (`bangladesh` \| `brazil` \| `india` \| `europe` \| `pyusd` \| `internal` \| `unknown`) and `railLabel`.

`GET /v1/transactions/:transactionId` — single row, same item shape. India flow tables should use this path (not `/v1/transactions/:id`).

---

## 5. Webhooks

**Page:** [Webhooks](https://docs.transacty.ai/webhooks)

`PATCH /v1/me/webhook`

```json
{ "webhookUrl": "https://merchant.example.com/webhooks/transacty" }
```

Production URLs must be **HTTPS**. Response includes `webhookSecret` **once** — store it.

Events (same URL for every rail):

- `payin.completed` / `payin.failed`
- `payout.completed` / `payout.failed`

Headers: `X-Transacty-Webhook-Signature` (HMAC-SHA256 of **raw body** with `webhookSecret`), `X-Transacty-Event`.

```json
{
  "event": "payin.completed",
  "transactionId": "uuid",
  "status": "success",
  "amount": "25.00",
  "paidAmount": "24.50",
  "currency": "PYUSD-USDC",
  "platformOrderId": "…",
  "timestamp": "2026-08-31T10:00:00.000Z"
}
```

For PYUSD completed: `currency` is **`PYUSD-USDC`**, not `USDC`. `paidAmount` is the net credited to that pocket.

Verify signature on the raw body. Process idempotently on `transactionId`. Poll status if a webhook is delayed.

---

## 6. Bangladesh

**Pages:** [Create pay-in](https://docs.transacty.ai/bangladesh/payin/create-payin), [Create payout](https://docs.transacty.ai/bangladesh/payout/create-payout)

Market: `bangladesh`. Settlement: **BDT**. Methods: `BKASH`, `NAGAD`, `UPAY`. Pay-in 200–25,000 BDT. Payout 100–25,000 BDT.

If create returns `503` `payment_unavailable`, the rail is paused — do not retry as a client bug.

### Merchant flow (pay-in)

1. `POST /v1/payins` with `Idempotency-Key`.
2. Redirect the customer to `paymentInfo.content` (hosted checkout).
3. Wait for webhook or poll `GET /v1/payins/:id` until `success` or `failed`.
4. Credit your order only on `success` / `payin.completed`.

### Create pay-in

`POST /v1/payins` — scope `payin:create`. **`Idempotency-Key` required.**

`goodsInfo.name` is required. `goodsInfo.id` and `goodsInfo.price` are **optional**.

```json
{
  "amount": "500.00",
  "paymentMethodCode": "BKASH",
  "returnUrl": "https://merchant.example.com/checkout/success",
  "customer": {
    "name": "Rahim",
    "email": "rahim@example.com",
    "phone": "01712345678",
    "deviceId": "device-123"
  },
  "goodsInfo": {
    "name": "Order #1001",
    "id": "1001",
    "price": "500.00"
  }
}
```

Response (shape): `transactionId`, `status` (`pending`), `amount`, `platformOrderId`, `paymentInfo`, `expiresAt`, plus fee fields `currency` (`BDT`), `fees`, `netAmount`, `totalWalletDebit` (null on pay-in create).

### Create payout

`POST /v1/payouts` — scope `payout:create`. **`Idempotency-Key` required.**

Keep the spelling **`benificiaryAccountInfo`**.

```json
{
  "amount": "300.00",
  "benificiaryAccountInfo": {
    "number": "01712345678",
    "orgId": "BKASH",
    "orgCode": "BKASH",
    "orgName": "BKASH",
    "holderName": "John Doe"
  },
  "cardHolderInfo": {
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "phone": "01712345678"
  }
}
```

`status` is `pending` (not `PENDING`). `totalWalletDebit` is amount + platform fee taken from the BDT wallet.

Status: `GET /v1/payouts/:id`.

---

## 7. Brazil PIX

**Pages:** [Create pay-in](https://docs.transacty.ai/brazil/payin/create-payin), payout siblings

Market: `brazil`. Settlement: **BRL**. Method: `PIX`. Limits: **10.00–15,000.00** BRL pay-in and payout. **`Idempotency-Key` required** on creates.

### Merchant flow (pay-in)

1. `POST /v1/br/payins`.
2. Render `paymentInfo` by `type` (`code` → PIX copy/QR; `url` → open link).
3. Poll `GET /v1/payins/:id` (shared status URL) or wait for webhook.
4. Treat `pending` as unpaid.

```json
{
  "amount": "100.00",
  "paymentMethodCode": "PIX",
  "returnUrl": "https://merchant.example.com/checkout/return",
  "customer": {
    "name": "Ana Souza",
    "email": "ana@example.com",
    "phone": "+5511999999999",
    "deviceId": "dev-123"
  },
  "goodsInfo": { "name": "Order #4821" }
}
```

Payout: `POST /v1/br/payouts` with the same `benificiaryAccountInfo` + `cardHolderInfo` shape as Bangladesh (PIX key in `number`). Status: `GET /v1/payouts/:id`.

---

## 8. India UPI (H2H)

**Pages:** [Overview](https://docs.transacty.ai/india/payin), [Create](https://docs.transacty.ai/india/payin/create-payin), confirm, status

Market: `india`. Customer always pays **INR** on UPI. Merchant wallet is always **USDT**. **`Idempotency-Key` required** on create.

You build the UPI UI. There is no hosted checkout on `/v1`.

### Merchant flow

1. `POST /v1/h2h/payin-instances`.
2. Show `paymentDetails` / `paymentInstructions` (QR / VPA).
3. Customer pays in their UPI app.
4. Collect bank **UTR**.
5. `POST /v1/h2h/buyer-confirms-payment`.
6. Poll `GET /v1/h2h/payin-instances/:transactionId` or wait for webhook.
7. Credit your order on `success` / `payin.completed`.

### Create

```json
{
  "amount": "500",
  "currencySymbol": "INR",
  "userDetails": { "email": "payer@example.com" }
}
```

| `currencySymbol` | You send | Customer pays | You receive |
|------------------|----------|---------------|-------------|
| `INR` | rupees | that INR | USDT equivalent |
| `USDT` | USDT | INR equivalent | that USDT |

Limits: INR **200–500,000**; USDT **1–500,000**. Optional `returnUrl`. Prefer `userDetails`; `userEmail` is accepted as a legacy alias.

Optional quote helper: `GET /v1/h2h/conversion-rates`.

### Confirm UTR

```json
{
  "transactionId": "a9b8c7d6-e5f4-43a2-9b1c-0d1e2f3a4b5c",
  "utr": "123456789012"
}
```

`200`: `{ "transactionId": "…", "acknowledged": true }`. Confirmation is not final settlement — still wait for status/webhook.

Public docs may mention `/v1/cpg/*` as optional crypto. Leave that off the H2H happy path.

---

## 9. Europe Open Banking

**Pages:** [Create pay-in](https://docs.transacty.ai/europe/payin/create-payin), [Payout](https://docs.transacty.ai/europe/payout/payout)

Market: `europe`. Pay-in currencies **EUR** or **GBP**. Settlement pocket **`USDC`**. Payouts debit **`USDC`** and send **EUR**. Amount 1–50,000. **`Idempotency-Key` required.**

### Pay-in flow

1. `POST /v1/eur/payin-instances`.
2. Redirect the customer to `checkoutUrl`.
3. Poll `GET /v1/eur/payin-instances/:transactionId` or webhook.
4. On success, **USDC** is credited (not PYUSD-USDC).

```json
{
  "amount": "100",
  "currencySymbol": "EUR",
  "returnUrl": "https://merchant.com/payment/return",
  "merchantUrl": "https://merchant.com",
  "userDetails": { "email": "payer@example.com" }
}
```

Provide `merchantUrl` **or** full `merchantDetails` (`merchantName`, `merchantUrl`, `merchantInternalId`).

Create response includes `transactionId`, `status` (`pending`), `amount`, `fiatCurrency`, `settlementCurrency` (`USDC`), `instanceId`, `checkoutUrl`, optional `cryptoAmount` / `rate`, plus fees.

### Payout flow (do not use `beneficiary`)

The live docs `beneficiary.name` / `iban` / `bic` body **will fail**. Use `payeeDetails` and `returnUrl`.

1. `POST /v1/eur/payout-instances` with `Idempotency-Key`.
2. If `requiresApproval` / `awaiting_approval`, call `POST /v1/eur/payout-instances/:transactionId/approve` (empty body).
3. Poll `GET /v1/eur/payout-instances/:transactionId`.
4. Debit is **Europe USDC** only. A PYUSD USDC balance cannot fund this.

```json
{
  "amount": "100",
  "currencySymbol": "EUR",
  "returnUrl": "https://merchant.com/payout/return",
  "merchantUrl": "https://merchant.com",
  "payeeDetails": {
    "name": "Jane Doe",
    "iban": "DE89370400440532013000",
    "country": "DE"
  }
}
```

`payeeDetails` is an object; at least `iban` is required for pre-fill. Optional `autoMerchantApproval`: `0` forces the approve step (`1` may auto-approve).

`400` `insufficient_balance` / `wallet_not_found` means the **USDC** pocket, not PYUSD-USDC.

Legacy paths `/v1/tylt/eur/...` still work; document `/v1/eur/...` as canonical.

---

## 10. PYUSD (rewrite these pages)

**Pages:** [Home PYUSD card](https://docs.transacty.ai/), [Overview](https://docs.transacty.ai/pyusd), [Create](https://docs.transacty.ai/pyusd/create-payment-intent), [Status](https://docs.transacty.ai/pyusd/payment-status), [Supported methods](https://docs.transacty.ai/about)

Delete: “settle to your USDC wallet”, “same USDC pocket as Europe”, `settlementCurrency: "USDC"`, webhook `currency: "USDC"`.

### Model

| | |
|--|--|
| Collect | Payer sends **PYUSD** on **Ethereum** to `depositAddress` |
| Settle | When `settlementStatus` is **`settled`**, Transacty credits **`PYUSD-USDC`** once (display **PYUSD USDC**) |
| Spend | No merchant PYUSD / PYUSD-USDC withdraw in this phase. EUR payouts cannot debit this pocket |
| Live only | Tekko has no sandbox. Use a **live** API key. `test` → `503` `payment_unavailable` |
| Market | `pyusd` must be approved |

Limits: **1–500,000** PYUSD per intent. Scope: `payin:create`. **`Idempotency-Key` required.**

### Merchant flow

1. `POST /v1/pyusd/payment-intents`.
2. Show `depositAddress` + `amount` (QR / copy). Network is always Ethereum.
3. Payer sends PYUSD.
4. Poll `GET /v1/pyusd/payment-intents/:transactionId` or wait for webhook.
5. Mark the order paid only when `settled` is `true` (or `settlementStatus` is `settled`). Do not treat “customer sent crypto” as credited.

### Create

```json
{
  "amount": "25.00",
  "merchantReference": "order-4821",
  "expiresInMinutes": 30,
  "metadata": { "orderId": "4821" }
}
```

```json
{
  "transactionId": "…",
  "paymentIntentId": "…",
  "status": "awaiting_payment",
  "settlementStatus": "awaiting_payment",
  "amount": "25.00",
  "currency": "PYUSD",
  "settlementCurrency": "PYUSD-USDC",
  "settlementCurrencyLabel": "PYUSD USDC",
  "network": "ethereum",
  "depositAddress": "0x…",
  "expiresAt": "2026-08-31T12:00:00.000Z",
  "environment": "live"
}
```

### Status poll

Same path. Extra fields: `paidAmount`, `settled` (boolean). `settled: true` means the **PYUSD-USDC** credit succeeded. Polling can settle a missed webhook.

List: `GET /v1/transactions?type=payin` then filter `rail === "pyusd"` in your app (no `rail=` query).

### Webhooks

- `payin.completed` — PYUSD-USDC credited (`currency: "PYUSD-USDC"`)
- `payin.failed` — expired or failed

---

## 11. Homepage / onboarding copy to replace

**Home PYUSD tile**

> One-time PYUSD on Ethereum. Show the deposit address. Settle to a dedicated **PYUSD USDC** wallet (`PYUSD-USDC`), separate from Europe USDC. Live only.

**Go-live checklist**

1. Complete KYC in the portal.
2. Get each region **approved** (markets).
3. Create a **test** key, then a **live** key when ready.
4. Sign every `/v1` call; send **`Idempotency-Key`** on creates.
5. `PATCH /v1/me/webhook` (HTTPS).
6. For PYUSD use the **live** key only.

**Do not** tell merchants to “test with `environment=test` then switch keys” on PYUSD — test always fails closed.

---

## 12. Keep as-is (already matches)

- Paths: `/v1/payins`, `/v1/payouts`, `/v1/br/*`, `/v1/h2h/*`, `/v1/eur/*`, `/v1/pyusd/payment-intents`
- Brazil status via shared `GET /v1/payins/:id` and `GET /v1/payouts/:id`
- India: merchant-built UPI UI; UTR confirm; USDT settlement
- Europe: redirect to `checkoutUrl`; USDC settlement for **that** rail
- Webhook event names and HMAC headers
- `benificiaryAccountInfo` spelling on BD/BR payouts
- One webhook URL for all rails

---

## 13. Leave off the public happy path (unless you add new pages)

These exist on the API but are not the regional onboarding story:

- `/v1/cpg/*` (optional India crypto)
- `/v1/internal-transfer`
- `/v1/h2h/payment-methods`, `/v1/supported/*`
- HMAC KYC (`/v1/me/kyc…`) — merchants complete KYC in the **portal**
- Dashboard `/portal/*` and admin `/provider/*`
