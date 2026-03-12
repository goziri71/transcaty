# Payok Live Testing

Test against your DB and confirm the integration works with Payok production.

## Prerequisites

- Payok merchant credentials (production)
- PostgreSQL with schema migrated (`npm run db:migrate`)
- Merchant + API key seeded (`npm run db:seed-merchant`)

## 1. Configure `.env`

```env
DATABASE_URL=postgresql://...
APP_BASE_URL=https://your-public-url  # Payok must reach this for webhooks

PAYOK_MERCHANT_ID=...
PAYOK_MERCHANT_PRI_KEY="-----BEGIN RSA PRIVATE KEY-----..."
PAYOK_BASE_URL=https://api.payok.xxx   # From Payok docs
PAYOK_PLATFORM_PUB_KEY="-----BEGIN PUBLIC KEY-----..."
```

For local dev, use ngrok so Payok can hit your webhooks: `ngrok http 3000` → set `APP_BASE_URL` to the ngrok HTTPS URL.

## 2. Verify Payok Connectivity

```bash
npm run payok:test
```

Balance inquiry returns 200 → Payok API is reachable and credentials are valid.

## 3. Test Against Your DB

**Balance** (uses your seeded wallet):

```bash
curl -X GET "http://localhost:3000/v1/balance" \
  -H "X-Transcaty-Key: <api_key>" \
  -H "X-Transcaty-Signature: <hmac>" \
  -H "X-Transcaty-Timestamp: $(date +%s000)"
```

**Pay-in** – creates order in DB, calls Payok, returns `paymentInfo`:

```bash
curl -X POST "http://localhost:3000/v1/payins" \
  -H "X-Transcaty-Key: ..." -H "X-Transcaty-Signature: ..." -H "X-Transcaty-Timestamp: ..." \
  -H "Content-Type: application/json" \
  -d '{"amount":"500","paymentMethodCode":"BKASH","customer":{"name":"Test","email":"t@t.com","phone":"01712345678","deviceId":"dev1"},"goodsInfo":{"name":"Test order"}}'
```

**Payout** – debits wallet, calls Payok:

```bash
curl -X POST "http://localhost:3000/v1/payouts" \
  -H "X-Transcaty-Key: ..." -H "X-Transcaty-Signature: ..." -H "X-Transcaty-Timestamp: ..." \
  -H "Content-Type: application/json" \
  -d '{"amount":"100","benificiaryAccountInfo":{"number":"...","orgId":"...","orgCode":"...","orgName":"...","holderName":"..."},"cardHolderInfo":{"firstName":"A","lastName":"B","email":"a@b.com","phone":"01712345678"}}'
```

Use the merchant auth script or your own HMAC signing for the headers.

## 4. Confirm Live Readiness

| Check | How |
|-------|-----|
| DB schema | `npm run db:migrate` |
| Merchant + wallet | `npm run db:seed-merchant` |
| Payok API | `npm run payok:test` |
| Webhooks reachable | `APP_BASE_URL` must be public HTTPS |
| Signature verification | Webhooks verify Payok `platformOrderId` + signature |

Once Payok sends callbacks to your webhooks, pay-in credits and payout debits/refunds will update your DB automatically.
