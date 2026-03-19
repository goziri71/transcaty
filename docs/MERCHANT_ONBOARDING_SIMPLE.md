# Transcaty Merchant Onboarding (Very Simple)

This guide is for your merchants.  
Goal: start using Transcaty in a few easy steps.

---

## 1) What You Get From Transcaty

When a merchant is onboarded, they get:

- `apiKey`
- `secret`
- `baseUrl` (your API URL)

They use these to call Transcaty APIs.

---

## 2) How Payment Flow Works

Merchant talks to **Transcaty**.  
Transcaty talks to **Payok**.

So merchant only integrates with Transcaty endpoints.

---

## 3) Main Endpoints Merchants Use

### Auth / identity

- `GET /v1/me`

### Balance

- `GET /v1/balance`

### Pay-in (customer pays merchant)

- `POST /v1/payins`
- `GET /v1/payins/:id`

### Payout (merchant sends money out)

- `POST /v1/payouts`
- `GET /v1/payouts/:id`

### Transactions

- `GET /v1/transactions`

---

## 4) How Merchant Ties Their Customer to Their Service

This is the part that usually confuses teams, so keep it simple:

1. Merchant keeps their own customer ID in their system.
2. Merchant creates/uses a Transcaty customer wallet under their merchant account.
3. Merchant stores a mapping in their DB:
   - `merchant_customer_id` (their ID)
   - `transcaty_customer_wallet_id` (Transcaty ID)
4. For future actions (balance view, transfer, refund, transaction history), merchant uses the stored Transcaty wallet ID.

Important:

- Merchant customers never call Transcaty directly.
- Merchant backend calls Transcaty, then merchant app shows results to customer.
- Customer data is isolated by merchant context, so one merchant cannot access another merchant's customers.

---

## 5) HMAC Headers (Required for `/v1/*`)

Merchant must send:

- `X-Transcaty-Key`
- `X-Transcaty-Signature`
- `X-Transcaty-Timestamp`

Signature payload format:

`<timestamp>.<raw_json_body>`

Hash algorithm:

`HMAC-SHA256` with merchant `secret`.

---

## 6) Merchant Webhooks (Yes, Available)

Transcaty can notify merchant server after pay-in/payout completion.

### Configure merchant webhook URL

Use:

- `PATCH /v1/me/webhook`

Body example:

```json
{
  "webhookUrl": "https://merchant.com/webhooks/transcaty"
}
```

Response includes:

- `webhookSecret` (save this safely)

Use `null` to remove webhook:

```json
{
  "webhookUrl": null
}
```

### Event types sent by Transcaty

- `payin.completed`
- `payin.failed`
- `payout.completed`
- `payout.failed`

Headers sent by Transcaty:

- `X-Transcaty-Webhook-Signature` (HMAC SHA256)
- `X-Transcaty-Event`

Payload shape:

```json
{
  "event": "payin.completed",
  "transactionId": "uuid",
  "status": "success",
  "amount": "500",
  "paidAmount": "500",
  "platformOrderId": "2026031807000000129",
  "timestamp": "2026-03-19T10:00:00.000Z"
}
```

For failed events, `paidAmount` may be absent.

---

## 7) Important Notes for Merchants

- Use `transactionId` from Transcaty as your main reference.
- `platformOrderId` is provider-side reference (for support/escalation).
- Do not call Payok directly from merchant integration.
- If webhook is delayed, poll `GET /v1/payins/:id` or `GET /v1/payouts/:id`.

---

## 8) Super Quick Test (Merchant)

1. `GET /v1/me`
2. `GET /v1/balance`
3. `POST /v1/payins`
4. Complete payer step from `paymentInfo.content`
5. `GET /v1/payins/:id` until `success`
6. `POST /v1/payouts`
7. `GET /v1/payouts/:id` until final state
8. Set webhook URL with `PATCH /v1/me/webhook` and confirm events are received

---

## 9) Existing Detailed Docs

For deeper testing examples:

- `docs/POSTMAN_MERCHANT_API_GUIDE.md`
- `docs/PORTAL_FRONTEND_SPEC.md`
