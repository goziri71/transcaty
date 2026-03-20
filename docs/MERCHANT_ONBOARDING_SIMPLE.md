# Transcaty Merchant API Guide (Simple + Full Examples)

This is a merchant-facing guide.  
It shows the full flow with request and response examples.

---

## 1) What Merchant Receives

When a merchant is onboarded, they receive:

- `apiKey`
- `secret`
- `baseUrl`

Example:

```text
apiKey: transcaty_test_xxxxxxxxxxxxxxxxx
secret: 64-char-secret-hex
baseUrl: https://api.transcaty.com
```

---

## 2) Required Headers (`/v1/*`)

Every merchant API call to `/v1/*` must include:

- `X-Transcaty-Key`
- `X-Transcaty-Signature`
- `X-Transcaty-Timestamp`
- `Content-Type: application/json` (for POST/PATCH)

Signature payload format:

```text
<timestamp>.<raw_json_body>
```

Algorithm:

```text
HMAC-SHA256 using merchant secret
```

---

## 3) Step-by-Step API Flow

## 3.1 Auth Check

Request:

`GET /v1/me`

Response (200):

```json
{
  "merchantId": "85305e39-5cd5-4e81-b5ea-58ba10c0f110",
  "scopes": ["payin:create", "payout:create", "balance:read", "*"],
  "environment": "test"
}
```

---

## 3.2 Get Balance

Request:

`GET /v1/balance`

Response (200):

```json
{
  "balance": "5000.00",
  "availableBalance": "5000.00",
  "pendingBalance": "0.00",
  "currency": "BDT",
  "lastUpdated": "2026-03-20T10:00:00.000Z",
  "limits": {
    "payin": { "min": 200, "max": 25000 },
    "payout": { "min": 100, "max": 25000 }
  }
}
```

---

## 3.3 Create Pay-in

Request:

`POST /v1/payins`

```json
{
  "amount": "500.00",
  "paymentMethodCode": "BKASH",
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

Response (200):

```json
{
  "transactionId": "d562be7c-00d4-4d63-bf50-93f72b437222",
  "status": "pending",
  "amount": "500.00",
  "platformOrderId": "2026031807000000129",
  "paymentInfo": {
    "content": "https://payment-link.example",
    "type": "url",
    "expiredTime": "20260320120000"
  },
  "expiresAt": "2026-03-20T12:00:00.000Z"
}
```

Use `transactionId` as your main reference in your system.

---

## 3.4 Check Pay-in Status

Request:

`GET /v1/payins/:id`

Example:

`GET /v1/payins/d562be7c-00d4-4d63-bf50-93f72b437222`

Response (200):

```json
{
  "id": "d562be7c-00d4-4d63-bf50-93f72b437222",
  "transactionId": "d562be7c-00d4-4d63-bf50-93f72b437222",
  "status": "success",
  "amount": "500.00",
  "paidAmount": "500.00",
  "platformOrderId": "2026031807000000129",
  "paymentMethod": "BKASH",
  "createdAt": "2026-03-20T11:00:00.000Z",
  "completedAt": "2026-03-20T11:02:00.000Z"
}
```

---

## 3.5 Create Payout

Request:

`POST /v1/payouts`

```json
{
  "amount": "300.00",
  "benificiaryAccountInfo": {
    "number": "01712345678",
    "holderName": "01712345678",
    "orgName": "BKASH",
    "orgCode": "BKASH",
    "orgId": "BKASH"
  },
  "cardHolderInfo": {
    "firstName": "Rahim",
    "lastName": "Uddin",
    "email": "rahim@example.com",
    "phone": "01712345678"
  }
}
```

Response (200):

```json
{
  "transactionId": "3bec8916-0ea6-4f8d-891a-e5e14a0dcbf9",
  "status": "pending",
  "amount": "300.00",
  "platformOrderId": "2026031807090000044",
  "estimatedCompletion": "2026-03-20T12:05:00.000Z"
}
```

---

## 3.6 Check Payout Status

Request:

`GET /v1/payouts/:id`

Example:

`GET /v1/payouts/3bec8916-0ea6-4f8d-891a-e5e14a0dcbf9`

Response (200):

```json
{
  "id": "3bec8916-0ea6-4f8d-891a-e5e14a0dcbf9",
  "transactionId": "3bec8916-0ea6-4f8d-891a-e5e14a0dcbf9",
  "status": "success",
  "amount": "300.00",
  "platformOrderId": "2026031807090000044",
  "createdAt": "2026-03-20T12:00:00.000Z",
  "completedAt": "2026-03-20T12:01:00.000Z"
}
```

---

## 3.7 List Transactions

Request:

`GET /v1/transactions?type=payin&limit=10&offset=0`

Response (200):

```json
{
  "items": [
    {
      "id": "d562be7c-00d4-4d63-bf50-93f72b437222",
      "type": "payin",
      "status": "success",
      "amount": "500.00",
      "paidAmount": "500.00",
      "platformOrderId": "2026031807000000129",
      "createdAt": "2026-03-20T11:00:00.000Z",
      "completedAt": "2026-03-20T11:02:00.000Z"
    }
  ],
  "total": 1,
  "limit": 10,
  "offset": 0
}
```

---

## 3.8 Configure Merchant Webhook

### Request

`PATCH /v1/me/webhook`

```json
{
  "webhookUrl": "https://merchant.com/webhooks/transcaty"
}
```

### Response (200)

```json
{
  "webhookUrl": "https://merchant.com/webhooks/transcaty",
  "webhookSecret": "generated-secret-value"
}
```

Save `webhookSecret` securely.

Disable webhook:

```json
{
  "webhookUrl": null
}
```

---

## 4) Webhook Events Merchant Receives

Event types:

- `payin.completed`
- `payin.failed`
- `payout.completed`
- `payout.failed`

Webhook headers:

- `X-Transcaty-Event`
- `X-Transcaty-Webhook-Signature`

Example payload:

```json
{
  "event": "payin.completed",
  "transactionId": "d562be7c-00d4-4d63-bf50-93f72b437222",
  "status": "success",
  "amount": "500.00",
  "paidAmount": "500.00",
  "platformOrderId": "2026031807000000129",
  "timestamp": "2026-03-20T11:02:00.000Z"
}
```

---

## 5) Customer Mapping (Important)

Merchant should map internal customer IDs to Transcaty wallet IDs.

Store in merchant DB:

- `merchant_customer_id`
- `transcaty_customer_wallet_id`

Use this mapping in your own app/services when showing customer balances and histories.

---

## 6) Common Errors

### 401 Unauthorized

- Invalid/missing HMAC headers
- Wrong `apiKey` or `secret`
- Bad timestamp

### 400 Bad Request

- Amount out of allowed range
- Invalid body fields

### 403 Forbidden

- KYC or permission restriction

---

## 7) Quick Go-Live Checklist

1. Auth check works (`GET /v1/me`)
2. Balance check works (`GET /v1/balance`)
3. Pay-in create + status flow works
4. Payout create + status flow works
5. Webhook endpoint receives and verifies signatures
6. Retry/idempotency handling is implemented in merchant backend

---

## 8) More Detailed References

- `docs/POSTMAN_MERCHANT_API_GUIDE.md`
- `docs/PORTAL_FRONTEND_SPEC.md`
