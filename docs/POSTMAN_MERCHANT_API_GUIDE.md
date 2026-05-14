# Merchant API – Postman Testing Guide (Step by Step)

> A simple, step-by-step guide to test the full merchant flow in Postman. Written for beginners.

## Scope (important)

This guide covers **only** the **Merchant API** under **`/v1/*`**, authenticated with **HMAC** headers (`X-Transacty-Key`, `X-Transacty-Signature`, `X-Transacty-Timestamp`).

The following **do not change** merchant API contracts, signing, or routes:

| Surface | Purpose |
| --- | --- |
| **`/portal/*`** | Merchant **dashboard** (JWT login, MFA, password reset, KYC uploads) |
| **`/provider/*`** | Transacty **internal admin** (provider JWT / API key) |
| **`GET /metrics`** | Prometheus metrics (ops; optional `METRICS_TOKEN` in production) |

Your **merchant integration** (server-to-server `/v1/*`) uses these routes and HMAC signing; new API keys use the `transacty_` prefix.

**Cross-border / crypto rails (`/v1/h2h`, `/v1/cpg`, `/v1/supported`, etc.):** Uses the **same** HMAC headers and Postman pre-request pattern as this guide. Legacy **`/v1/tylt/...`** paths still work. For a **full ordered regression**, use **`docs/TYLT_MERCHANT_API_TESTING.md`** (see §11).

---

## What You'll Do

1. Create a test merchant (get API key + secret)
2. Set up Postman so every request is signed correctly
3. Check who you are (`/v1/me`)
4. Check your balance (`/v1/balance`)
5. Create a pay-in (customer pays you)
6. Check pay-in status
7. Create a payout (you send money to someone)
8. Check payout status
9. List all transactions

---

## Before You Start

- Server running: `npm run dev`
- Database migrated: `npm run db:migrate`
- `.env` has `ENCRYPTION_MASTER_KEY` and Payok credentials

---

## Step 0: Create a Test Merchant

Run this in your terminal:

```bash
npm run db:seed-merchant
```

You'll see something like:

```
Test merchant created:

  Merchant ID: abc123-uuid-here
  API Key: transacty_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  Secret: yyyy...64 hex chars...
```

**Copy both the API Key and the Secret.** You'll need them in Postman.

---

## Step 1: Set Up Postman

### 1.1 Create a new collection

1. Open Postman
2. Click **New** → **Collection**
3. Name it "Transacty Merchant API"

### 1.2 Set environment variables

1. Click **Environments** (left sidebar) → **Create Environment**
2. Name it "Transacty Local"
3. Add these variables:

| Variable   | Initial Value | Current Value |
|-----------|---------------|---------------|
| baseUrl   | http://localhost:3000 | (same) |
| apiKey    | (paste your API Key)  | (same) |
| secret    | (paste your Secret)   | (same) |

4. Save and select this environment (top-right dropdown)

### 1.3 Add a Pre-request Script for signing

Every `/v1/*` request needs 3 headers. We'll auto-generate them.

1. Click your **Collection** → **Edit** (or right-click → Edit)
2. Go to the **Pre-request Script** tab
3. Paste this:

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

4. Save

**Important:** The script must live on **Pre-request Script**, not **Tests** or **Post-response**. If it runs after the response, the server never receives the headers and returns `401` “Missing X-Transacty-Key…”.

### 1.4 Set collection-level headers

1. In the collection, go to **Headers**
2. Add:

| Key                    | Value              |
|------------------------|--------------------|
| X-Transacty-Key        | `{{apiKey}}`       |
| X-Transacty-Signature  | `{{signature}}`    |
| X-Transacty-Timestamp | `{{timestamp}}`    |
| Content-Type           | application/json   |

These will be sent with every request. The Pre-request Script fills in `signature` and `timestamp` before each call.

---

## Step 2: Check Who You Are

**Request:** `GET {{baseUrl}}/v1/me`

1. New request → GET
2. URL: `{{baseUrl}}/v1/me`
3. No body
4. Send

**Expected response (200):**

```json
{
  "merchantId": "your-merchant-uuid",
  "scopes": ["payin:create", "payout:create", "balance:read", "*"],
  "environment": "test"
}
```

If you get 401, check that `apiKey` and `secret` are set in your environment.

---

## Step 3: Check Your Balance

**Request:** `GET {{baseUrl}}/v1/balance`

1. New request → GET
2. URL: `{{baseUrl}}/v1/balance`
3. Send

**Expected response (200):**

```json
{
  "balance": "0",
  "availableBalance": "0",
  "pendingBalance": "0",
  "currency": "BDT",
  "lastUpdated": null,
  "limits": {
    "payin": { "min": 200, "max": 25000 },
    "payout": { "min": 100, "max": 25000 }
  }
}
```

At first, balance is 0. To test payouts, you can add balance in the DB (see "Quick Test: Add Balance" below).

---

## Step 4: Create a Pay-in (Customer Pays You)

**Request:** `POST {{baseUrl}}/v1/payins`

1. New request → POST
2. URL: `{{baseUrl}}/v1/payins`
3. Body → **raw** → **JSON**
4. Paste:

```json
{
  "amount": "500",
  "paymentMethodCode": "BKASH",
  "returnUrl": "https://your-site.com/payment/complete",
  "customer": {
    "name": "Test Customer",
    "email": "customer@example.com",
    "phone": "01712345678",
    "deviceId": "device-123"
  },
  "goodsInfo": {
    "name": "Test Product",
    "id": "prod-1",
    "price": "500"
  }
}
```

5. (Optional) Add header: `Idempotency-Key` = `payin-test-1` to avoid duplicates
6. Send

**Expected response (200):**

```json
{
  "transactionId": "uuid-here",
  "status": "pending",
  "amount": "500",
  "platformOrderId": "payok-order-id",
  "paymentInfo": { ... },
  "expiresAt": "2025-03-09T..."
}
```

**Save the `transactionId`** – you'll use it in the next step.

**Note:** In a real flow, the customer would use `paymentInfo` to pay (e.g. bKash). For Payok staging, they may send a callback within a few minutes. For local testing without Payok, the pay-in stays "pending" and balance stays 0.

---

## Step 5: Check Pay-in Status

**Request:** `GET {{baseUrl}}/v1/payins/:id`

1. New request → GET
2. URL: `{{baseUrl}}/v1/payins/PASTE_TRANSACTION_ID_HERE`
   - Replace `PASTE_TRANSACTION_ID_HERE` with the `transactionId` from Step 4
3. Send

**Expected response (200):**

```json
{
  "id": "uuid",
  "transactionId": "uuid",
  "status": "pending",
  "amount": "500",
  "paidAmount": null,
  "platformOrderId": "...",
  "paymentMethod": "BKASH",
  "createdAt": "...",
  "completedAt": null
}
```

When the customer pays, `status` becomes `success` and `paidAmount` is set.

---

## Step 6: Create a Payout (You Send Money)

You need balance first. If balance is 0, see "Quick Test: Add Balance" below.

**Request:** `POST {{baseUrl}}/v1/payouts`

1. New request → POST
2. URL: `{{baseUrl}}/v1/payouts`
3. Body → **raw** → **JSON**
4. Paste:

```json
{
  "amount": "100",
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

**Bangladesh e-wallets:** Use `orgId`/`orgCode`/`orgName` = `BKASH`, `NAGAD`, or `UPAY`. The `number` is the wallet/phone number.

5. (Optional) Add header: `Idempotency-Key` = `payout-test-1`
6. Send

**Expected response (200):**

```json
{
  "transactionId": "uuid",
  "status": "pending",
  "amount": "100",
  "platformOrderId": "...",
  "recipient": { "masked": "****5678" },
  "estimatedCompletion": "..."
}
```

**Save the `transactionId`** for the next step.

---

## Step 7: Check Payout Status

**Request:** `GET {{baseUrl}}/v1/payouts/:id`

1. New request → GET
2. URL: `{{baseUrl}}/v1/payouts/PASTE_TRANSACTION_ID_HERE`
3. Send

**Expected response (200):**

```json
{
  "id": "uuid",
  "transactionId": "uuid",
  "status": "pending",
  "amount": "100",
  "platformOrderId": "...",
  "recipient": { "masked": "****5678" },
  "createdAt": "...",
  "completedAt": null
}
```

When Payok completes the payout, `status` becomes `success`.

---

## Step 8: List All Transactions

**Request:** `GET {{baseUrl}}/v1/transactions`

1. New request → GET
2. URL: `{{baseUrl}}/v1/transactions`
3. (Optional) Query params:
   - `type` = `payin` or `payout`
   - `limit` = `20`
   - `offset` = `0`
4. Send

**Example URL:** `{{baseUrl}}/v1/transactions?type=payin&limit=10`

**Expected response (200):**

```json
{
  "items": [
    {
      "id": "uuid",
      "type": "payin",
      "status": "success",
      "amount": "500",
      "paidAmount": "500",
      "platformOrderId": "...",
      "createdAt": "...",
      "completedAt": "..."
    }
  ],
  "total": 1,
  "limit": 20,
  "offset": 0
}
```

---

## Quick Test: Add Balance (No Real Payment)

To test payouts without waiting for a real pay-in:

1. Open your database (e.g. `npm run db:studio` or psql)
2. Find your merchant's wallet:

```sql
SELECT id, merchant_id, balance FROM wallets 
WHERE merchant_id = 'YOUR_MERCHANT_ID' AND type = 'merchant';
```

3. Update balance:

```sql
UPDATE wallets 
SET balance = '1000' 
WHERE merchant_id = 'YOUR_MERCHANT_ID' AND type = 'merchant';
```

4. Call `GET /v1/balance` again – you should see 1000 BDT.

---

## Request Order Summary

| Step | Method | Endpoint | Purpose |
|------|--------|----------|---------|
| 1 | GET | /v1/me | Who am I? |
| 2 | GET | /v1/balance | How much do I have? |
| 3 | POST | /v1/payins | Create pay-in |
| 4 | GET | /v1/payins/:id | Pay-in status |
| 5 | POST | /v1/payouts | Create payout |
| 6 | GET | /v1/payouts/:id | Payout status |
| 7 | GET | /v1/transactions | List all transactions |

---

## Limits (Bangladesh BDT)

| Type   | Min  | Max    |
|--------|------|--------|
| Pay-in | 200  | 25,000 |
| Payout | 100  | 25,000 |

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| 401 Unauthorized | Check `apiKey` and `secret` in environment. Ensure Pre-request Script runs. |
| 401 Invalid signature | Body must match exactly. For GET, body is empty. For POST, use raw JSON. |
| 401 Request timestamp expired | Your clock may be wrong. Timestamp must be within ±5 minutes. |
| 403 KYC verification required | Set `KYC_REQUIRED=false` in .env, or use a merchant with `kycStatus=verified`. |
| 400 Amount must be between... | Use amount within limits (payin: 200–25000, payout: 100–25000). |
| 400 Insufficient balance | Add balance to wallet (see "Quick Test" above) or complete a real pay-in. |

---

## Optional: Webhook URL

To receive pay-in/payout callbacks:

**Request:** `PATCH {{baseUrl}}/v1/me/webhook`

Body:

```json
{
  "webhookUrl": "https://your-server.com/webhooks/transacty"
}
```

Use `null` to remove. The response includes a `webhookSecret` – use it to verify callback signatures.

---

*Last updated: March 2025*
