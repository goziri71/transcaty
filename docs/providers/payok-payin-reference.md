# Payok Pay-in (Payment) API Reference

> Domestic pay-in in Bangladesh – customer pays merchant (opposite of payout)

**Not a duplicate of payout.** Different base path: `/api-pay/payment/` vs payout `/api-pay/remit/`

---

## Flow Overview

```
1. Create Order (API or H5)  →  Get paymentInfo (VA number, QR, URL, etc.)
2. Customer pays            →  Via bKash/Nagad/UPAY app or page
3. Callback Notification     ←  Payok POSTs to our notificationUrl
4. Inquiry Status           →  Poll by merchantOrderId (or voucherNo for QRIS)
5. Inquiry Payment Methods  →  Get available methods per country (optional)
```

---

## Endpoints Summary

| Endpoint | Path | Purpose |
|----------|------|---------|
| Create Order (API) | `/api-pay/payment/V3.5/order/create-api` | Create order, get payment content (VA, QR, etc.) |
| Create Order (H5) | `/api-pay/payment/V3.5/order/create-h5` | Redirect to Payok payment page |
| Inquiry Status | `/api-pay/payment/V3.5/order/query` | Check status by merchantOrderId |
| Inquiry Status (VoucherNo) | `/api-pay/payment/V3.5/order/query-voucherno` | Check by voucherNo (QRIS RRN, etc.) |
| Inquiry Payment Methods | `/api-pay/payment/V3.5/merchant/paymentMethods` | Get available methods per country |
| Payin Order Supplementation | `/api-pay/payment/V3.5/order/feedback` | India UPI only |

---

## 1. Create Order (API Endpoint)

**Purpose:** Create pay-in order. Use when merchant has own payment page.

**Endpoint:** `POST /api-pay/payment/V3.5/order/create-api`

### Request

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| requestTime | String(24) | M | UTC: `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` |
| merchantId | String(20) | M | From Payok |
| paymentMethodCode | String(10) | M | `BKASH`, `NAGAD`, `UPAY` for Bangladesh |
| countryCode | String(4) | M | `BD` |
| merchantOrderId | String(50) | M | Our unique order ID |
| amount | decimal(12,2) | M | Amount in BDT |
| currency | String(4) | M | `BDT` |
| notificationUrl | String(200) | M | Our webhook URL |
| returnUrl | String(200) | O | Redirect after payment |
| language | String(4) | M | `EN` or `BN` |
| customer | Object | M | See below |
| goodsInfo | Object | M | See below |
| customerAccount | Object | C | **Not required for Bangladesh** |

**customer:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | String(64) | M | User name |
| email | String(45) | M | Valid email |
| phone | String(32) | M | Valid phone |
| deviceId | String(200) | M | Unique order identifier |
| personalId | String(50) | C | **Not required for Bangladesh** |
| countryName, city, zip, address, ip | | O | Optional |

**goodsInfo:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | String(128) | M | Product name |
| id | String(64) | O | Product ID |
| price | String(12,2) | O | Product price |

### Response (Success)

| Field | Description |
|-------|-------------|
| code | `SUCCESS` or `FAIL` |
| status | `PENDING` or `SUCCESS` |
| platformOrderId | Payok order ID |
| paymentInfo | See below |
| transFeeRate, transFee, totalTransFee | Fee info |
| createTime, updateTime | `yyyyMMddHHmmss` |

**paymentInfo:**

| Field | Description |
|-------|-------------|
| content | Payment content (VA number, URL, JSON with pay_url/qr_code) |
| type | `url`, `code`, `html`, or `json` |
| expiredTime | `yyyyMMddHHmmss` |

---

## 2. Create Order (H5 Endpoint)

**Purpose:** Redirect user to Payok payment page. Same params as API; `paymentMethodCode` is optional (user selects on H5 page).

**Endpoint:** `POST /api-pay/payment/V3.5/order/create-h5`

Response returns `paymentInfo.type: url` – redirect user to that URL.

---

## 3. Inquiry Status

**Endpoint:** `POST /api-pay/payment/V3.5/order/query`

### Request

| Field | Type | Required |
|-------|------|----------|
| requestTime | String(24) | M |
| merchantId | String(20) | M |
| merchantOrderId | String(50) | M |

### Response (Success)

| Field | Description |
|-------|-------------|
| code, status | `PENDING`, `SUCCESS`, `FAILED` |
| paidAmount | Actual amount paid (may differ from request amount) |
| payer | Actual payer name (INA VA, BNC VA, QRIS only) |
| accountNo | Actual payer account (INA VA, BNC VA only) |

---

## 4. Inquiry Payment Methods

**Endpoint:** `POST /api-pay/payment/V3.5/merchant/paymentMethods`

### Request

| Field | Type | Required |
|-------|------|----------|
| requestTime | String(24) | M |
| merchantId | String(20) | M |
| countryCode | String(4) | M |

### Response

Returns `list` of `{ name, imageUrl, countryName, category }` where `category` = paymentMethodCode.

---

## 5. Callback Notification

**Purpose:** Payok POSTs to our `notificationUrl` when payment completes.

### Retry Policy (different from payout)

- Return plain text `SUCCESS` to acknowledge
- Retries: 1S, 5S, 10S, 30S, 60S, 300S, 900S, 1800S (8 times)

### Callback Body

| Field | Description |
|-------|-------------|
| code | `SUCCESS` or `FAIL` |
| status | `SUCCESS` (paid) |
| merchantId, merchantOrderId, platformOrderId | |
| paymentMethodCode | BKASH, NAGAD, UPAY |
| amount, paidAmount | Request vs actual paid |

**Alert:** `amount` and `paidAmount` may differ. Use `paidAmount` for the actual received amount when crediting.
| createTime, successTime | `yyyyMMddHHmmss` |
| transFeeRate, transFee, totalTransFee | |
| payer, accountNo | Optional (VA/QRIS only) |

### Our Response

Return plain text: `SUCCESS`

---

## Bangladesh-Specific

| Field | Value |
|-------|-------|
| countryCode | `BD` |
| currency | `BDT` |
| language | `EN` or `BN` |
| personalId | **Not required** |
| customerAccount | **Not required** |

### Payment Methods (Bangladesh)

| Method | Code | Min (BDT) | Max (BDT) |
|--------|------|-----------|-----------|
| bKash | BKASH | 200 | 25,000 |
| Nagad | NAGAD | 200 | 25,000 |
| UPAY | UPAY | 200 | 25,000 |

**Note:** UPAY added in doc v3.1.20 (Dec 2025). Min is 200 BDT (vs payout 100 BDT).

---

## Error Codes (Pay-in)

| Code | Description |
|------|-------------|
| 01 | Signature error or merchant doesn't exist |
| 02 | Non-POST JSON format |
| 03-05 | requestTime errors |
| 06 | Invalid personal id |
| 07-26 | Parameter errors |
| 27 | System anomaly |
| 28 | Amount null or must be greater than 0 |
| 29 | Order doesn't exist or status changed |
| 30 | Country code and currency mismatch |
| 31 | Internal Server Error |
| 32 | Amount outside payment method range |

---

## Signature

Same as payout: SHA256WithRSA, Base64. Plaintext = `{json_body}&{endpoint_path}`

Example: `{"paymentMethodCode":"BKASH",...}&/api-pay/payment/V3.5/order/create-api`

---

## Pay-in vs Payout Summary

| Aspect | Pay-in (Payment) | Payout (Remit) |
|--------|------------------|----------------|
| Base path | `/api-pay/payment/` | `/api-pay/remit/` |
| Direction | Customer → Merchant | Merchant → Recipient |
| Create endpoint | `/order/create-api` or `/create-h5` | Bank inquiry → `/order/create` |
| paymentMethodCode | BKASH, NAGAD, UPAY | N/A (beneficiary account) |
| Callback retries | 8 times | 6 times |
| Bangladesh min | 200 BDT | 100 BDT |
