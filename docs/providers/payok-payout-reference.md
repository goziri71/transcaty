# Payok Payout API Reference

> Domestic payout in Bangladesh (countryCode: **BD**, currency: BDT)

## Flow Overview

```
1. Bank Account Inquiry  →  Get inquiryToken (validates beneficiary)
2. Request Payout         →  Create order (uses inquiryToken)
3. Callback Notification ←  Payok POSTs to our notificationUrl (async)
4. Inquiry Status        →  Poll status if needed (merchantOrderId)
5. Inquiry Balance       →  Check merchant balance (optional)
```

---

## 1. Bank Account Inquiry

**Purpose:** Validate beneficiary account before payout. Returns `inquiryToken` required for step 2.

**Endpoint:** `POST /api-pay/remit/V3.5/account/inquiry`

### Request

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| requestTime | String(24) | M | UTC, format: `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` |
| merchantId | String(20) | M | From Payok |
| merchantOrderId | String(50) | M | Our unique order ID |
| amount | decimal(12,2) | M | Payout amount |
| countryCode | String(4) | M | `BD` for Bangladesh |
| currency | String(4) | M | `BDT` |
| language | String(4) | M | e.g. `EN` |
| benificiaryAccountInfo | Object | M | See below |

**benificiaryAccountInfo:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| number | String(30) | M | Account number |
| orgId | String(20) | M | Bank ID (Supported Bank List) |
| orgCode | String(20) | M | Bank code (Supported Bank List) |
| orgName | String(45) | M | Bank name (Supported Bank List) |
| holderName | String(200) | M | Account holder name |
| personalId | String(12) | C | **Not required for Bangladesh** |
| personalType | String(10) | C | **Not required for Bangladesh** |
| accountType | String(10) | C | **Not required for Bangladesh** |

### Response (Success)

| Field | Description |
|-------|-------------|
| code | `SUCCESS` or `FAIL` |
| message | Error details if FAIL |
| inquiryToken | String(30) – **required for Request Payout** |
| merchantId, merchantOrderId, amount, countryCode, currency, language | Echoed |
| benificiaryAccountInfo | Echoed |

---

## 2. Request Payout

**Purpose:** Create the payout order. Must be called after Bank Account Inquiry with the returned `inquiryToken`.

**Endpoint:** `POST /api-pay/remit/V3.5/order/create`

### Request

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| requestTime | String(24) | M | UTC |
| merchantId | String(20) | M | |
| merchantOrderId | String(50) | M | Same as inquiry |
| amount | decimal(12,2) | M | |
| countryCode | String(4) | M | |
| currency | String(4) | M | |
| language | String(4) | M | |
| inquiryToken | String(30) | M | From Bank Account Inquiry |
| notificationUrl | String(200) | O | Our webhook URL for callback |
| description | String(200) | O | Remark |
| benificiaryAccountInfo | Object | M | Same as inquiry |
| cardHolderInfo | Object | M | See below |

**cardHolderInfo:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| firstName | String(20) | M | |
| lastName | String(20) | M | |
| email | String(45) | M | Valid email (helps success rate) |
| phone | String(20) | M | |
| country | String(64) | O | |
| city | String(20) | O | |
| zip | String(32) | O | |
| address | String(200) | O | |

### Response (Success)

| Field | Description |
|-------|-------------|
| code | `SUCCESS` or `FAIL` |
| status | `PENDING` or `FAILED` |
| platformOrderId | Payok order ID |
| transFeeRate | Transaction rate |
| transFee | Fee amount |
| totalTransFee | Total fee |
| inquiryToken | Echoed |

---

## 3. Inquiry Status

**Purpose:** Check transaction status by `merchantOrderId`.

**Endpoint:** `POST /api-pay/remit/V3.5/order/query`

### Request

| Field | Type | Required |
|-------|------|----------|
| requestTime | String(24) | M |
| merchantId | String(20) | M |
| merchantOrderId | String(50) | M |

### Response (Success)

| Field | Description |
|-------|-------------|
| code | `SUCCESS` or `FAIL` |
| status | `PENDING` \| `SUCCESS` \| `FAILED` |
| platformOrderId | Payok order ID |
| createTime | `yyyyMMddHHmmss` |
| successTime | `yyyyMMddHHmmss` (when SUCCESS) |
| transFeeRate, transFee, totalTransFee | Fee info |

---

## 4. Callback Notification

**Purpose:** Payok sends async status updates to our `notificationUrl`.

**Method:** POST (Payok → us)

### Payok Retry Policy

- Return plain text `SUCCESS` to acknowledge
- If we don’t return `SUCCESS`, Payok retries: 2s, 5s, 10s, 30s, 60s, 900s (6 times)

### Callback Body

| Field | Description |
|-------|-------------|
| code | `SUCCESS` or `FAIL` |
| status | `SUCCESS` or `FAILED` (final status) |
| merchantId, merchantOrderId, platformOrderId | |
| amount, countryCode, currency | |
| createTime, successTime | `yyyyMMddHHmmss` |
| benificiaryAccountInfo | |
| transFeeRate, transFee, totalTransFee | |

### Our Response

Return plain text: `SUCCESS`

---

## Signature (All Requests & Responses)

- **Algorithm:** SHA256WithRSA, Base64
- **Our requests:** Sign with merchant private key, put in `sign` header
- **Their responses/callbacks:** Verify with Payok public key

**Plaintext to sign:** `{json_body}&{endpoint_path}`

Example: `{"requestTime":"...","amount":"20000.00",...}&/api-pay/remit/V3.5/account/inquiry`

---

## 5. Inquiry Balance

**Purpose:** Check merchant balance before payout.

**Endpoint:** `POST /api-pay/remit/V3.5/balance/query`

### Request

| Field | Type | Required |
|-------|------|----------|
| requestTime | String(24) | M |
| merchantId | String(20) | M |

### Response (Success)

| Field | Description |
|-------|-------------|
| code | `SUCCESS` or `FAIL` |
| merchantId | Echoed |
| withdrawingBalance | Amount being withdrawn |
| availableBalance | **Can be used for payout** |
| settlingBalance | Pay-in not yet settled |
| totalBalance | availableBalance + settlingBalance |
| currency | e.g. BDT |
| createTime, updateTime | `yyyyMMddHHmmss` |

---

## Bangladesh-Specific

| Field | Value |
|-------|-------|
| countryCode | `BD` |
| currency | `BDT` |
| language | `EN` or `BN` |
| personalId, personalType, accountType | **Not required** |

### Transaction Limits (Bangladesh)

| Payment Method | Min (BDT) | Max (BDT) |
|----------------|-----------|-----------|
| Payout to E-Wallet Account | 100 | 25,000 |

**Note:** Bangladesh supports **E-Wallet payout only** (no bank account payout).

---

## Error Codes

| Code | Description |
|------|-------------|
| 00 | Signature error or merchant doesn't exist |
| 01 | Non-POST JSON format parameter request |
| 02 | Invalid personal id |
| 03 | Personal id is null |
| 04 | Bank card number cannot be empty |
| 05 | requestTime is null |
| 06 | requestTime non-UTC format |
| 07 | Invalid requestTime |
| 08 | Invalid callback notification address |
| 09 | Bank Code cannot be empty |
| 10 | Wrong bank card information |
| 11 | outTradeNo cannot be empty |
| 12 | Max length of outTradeNo is 50 |
| 13 | inquiryToken cannot be empty |
| 14 | Max length of inquiryToken is 30 |
| 15 | Bank ID cannot be empty |
| 16 | Amount cannot be empty |
| 17 | personalType or AccountType cannot be empty |
| 18 | Invalid inquiry token |
| 19 | Invalid amount |
| 20 | Single payout exceeds bank max |
| 21 | No available channel or unsupported bank code |
| 22 | Amount outside merchant's payout range |
| 23 | No available channel or unsupported bank code |
| 24 | Amount outside merchant's payout range |
| 25 | **Merchant Account Balance Insufficient** |
| 26 | Amount null or must be greater than 0 |
| 27 | No available channel or channel not opened |
| 28 | Inquiry queries exceed max requests |
| 29 | Blacklist user |
| 30 | Non-whitelisted IP request |
| 31 | Internal Server Error |
| 32 | System anomaly |
| 33 | Order already exists |

---

## Endpoints Summary

| Step | Endpoint | Purpose |
|------|----------|---------|
| 1 | `/api-pay/remit/V3.5/account/inquiry` | Validate account, get inquiryToken |
| 2 | `/api-pay/remit/V3.5/order/create` | Create payout |
| 3 | `/api-pay/remit/V3.5/order/query` | Poll status |
| 4 | Our `notificationUrl` | Receive callback |
| 5 | `/api-pay/remit/V3.5/balance/query` | Check balance |

---

## Supported Bank List – Bangladesh (E-Wallets)

From Payok "Supported Bank List.xlsx", Bangladesh sheet. Bangladesh supports **E-Wallet payout only**.

**Config file:** `config/providers/payok/banks/bd.json` (source of truth, loaded at runtime)

| orgId | orgName | orgCode |
|-------|---------|---------|
| BKASH | BKASH | BKASH |
| NAGAD | NAGAD | NAGAD |

**Providers:**
- **bKash** – Mobile financial service
- **Nagad** – Mobile financial service

---

## References

- **Supported Bank List:** Payok "Supported Bank List.xlsx" (downloaded from Payok)
- **Config:** `config/providers/payok/banks/{country}.json` – use `getPayokBanks(countryCode)` from `src/lib/banks.ts`
