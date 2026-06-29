# Frontend Handoff — June 2026 Updates

Single implementation guide for **merchant portal** and **provider admin** SPAs.  
Older baseline docs still apply: [PORTAL_FRONTEND_SPEC.md](./PORTAL_FRONTEND_SPEC.md), [PROVIDER_DASHBOARD_API_UPDATE.md](./PROVIDER_DASHBOARD_API_UPDATE.md).

**Backend prerequisite (ops):** `npm run db:migrate` then `npx tsx scripts/backfill-merchant-slugs.ts` for existing merchants.

---

## Quick checklist

### Merchant portal

| Priority | Feature | API | UI suggestion |
|----------|---------|-----|----------------|
| P0 | Merchant slug | `GET /portal/me` → `merchantSlug` | Show in header/settings next to business name; copy button |
| P0 | Reconciliation report | `GET /portal/me/reconciliation` | Date range picker + summary cards + table; **Export CSV** button |
| P1 | Signup slug | `POST /portal/auth/signup` → `merchantSlug` | Optional welcome screen: “Your merchant id: `acme-payments`” |
| P2 | Payment emails | (server-side) | No UI required; optional note under Webhooks: “We also email your team on pay-in/payout results” |

### Provider admin

| Priority | Feature | API | UI suggestion |
|----------|---------|-----|----------------|
| P0 | Reconciliation export | `GET /provider/merchants/:merchantId/reconciliation-report` | Tab on merchant 360: date range + summary + CSV download |
| P1 | Fee schedules | `GET/POST …/fee-schedules` | Replace/extend pricing panel: grid by rail × currency × payin/payout |
| P1 | FX spread (crypto send-out) | `GET/POST /provider/fx-rate-profiles`, `PUT …/fx-overrides` | Finance settings: global spread bps; per-merchant override on merchant FX tab |
| P2 | Preview quote | `POST /provider/fx-rate-profiles/preview-quote` | Small calculator in FX admin |
| P1 | India / Europe payouts | `POST /portal/me/cpg/payout-requests`, `POST /portal/me/eur/payout-instances` | See **[FRONTEND_INDIA_EUROPE_PORTAL.md](./FRONTEND_INDIA_EUROPE_PORTAL.md)** |
| P1 | API IP allowlist (merchant self-service) | `GET/PUT /portal/me/api-ip-rules` | Settings → API security; show `clientIp` on load |

### Merchant API (HMAC) — display only in portal docs

| Field | Endpoint |
|-------|----------|
| `merchantSlug` | `GET /v1/me` |
| Full payout `recipient` | `POST /v1/payouts`, `GET /v1/payouts/:id` (not masked) |

---

## 1. Merchant slug

Human-readable public id (e.g. `acme-payments`). **UUID `merchantId` stays canonical** for API keys, webhooks, and transaction ids.

**Max slug length:** 32 characters (auto-generated from business name).

**Provider routes:** `:merchantId` accepts **UUID or slug** (case-insensitive), e.g.  
`/provider/merchants/acme-payments/overview` and `/provider/merchants/7f2ef700-…/overview`.

### Portal

**Signup / login / MFA** — `merchant` object and top-level fields:

```json
{
  "merchantId": "uuid",
  "merchantSlug": "acme-payments",
  "merchant": {
    "id": "uuid",
    "slug": "acme-payments",
    "businessName": "Acme Payments Ltd",
    "name": "Acme Payments Ltd",
    "status": "pending",
    "kycStatus": "pending"
  }
}
```

**Profile** `GET /portal/me`:

```json
{
  "merchantId": "uuid",
  "merchantSlug": "acme-payments",
  "slug": "acme-payments",
  "businessName": "Acme Payments Ltd",
  ...
}
```

### Provider admin

**Merchant list** `GET /provider/merchants` and **overview** `GET /provider/merchants/:merchantId/overview`:

```json
{
  "merchant": {
    "id": "uuid",
    "slug": "acme-payments",
    "businessName": "Acme Payments Ltd",
    "name": "Acme Payments Ltd",
    "status": "active",
    "kycStatus": "verified",
    "createdAt": "2026-06-12T12:27:45.846Z"
  }
}
```

Search `?q=` matches **business name**, **slug**, or **UUID**.

### Merchant API

`GET /v1/me` (HMAC):

```json
{
  "merchantId": "uuid",
  "merchantSlug": "acme-payments",
  "slug": "acme-payments",
  "businessName": "Acme Payments Ltd",
  "scopes": ["payin:create", "…"],
  "environment": "test"
}
```

### UI guidance

- Show all three: **Merchant ID** (UUID, copy), **Slug** (copy), **Business name** (display).
- Provider deep links may use slug in the URL path.
- Do **not** use slug in transaction API paths — still use UUID `transactionId`.

---

## 2. Reconciliation report

Transaction statement for a date range (accounting / ops review). Max range: **93 days**.

### Merchant portal

```
GET /portal/me/reconciliation?environment=test&from=2026-06-01T00:00:00.000Z&to=2026-06-30T23:59:59.999Z
GET /portal/me/reconciliation?environment=test&from=…&to=…&format=csv
```

**Auth:** Portal JWT (`Authorization: Bearer …`).

**JSON response:**

```json
{
  "merchantId": "uuid",
  "environment": "test",
  "from": "2026-06-01T00:00:00.000Z",
  "to": "2026-06-30T23:59:59.999Z",
  "summary": {
    "totalTransactions": 42,
    "payinCount": 30,
    "payoutCount": 12,
    "successCount": 38,
    "failedCount": 2,
    "pendingCount": 2,
    "payinVolumeByCurrency": [
      { "currency": "BDT", "amount": "10000.00" },
      { "currency": "USDT", "amount": "2500.00" }
    ],
    "payoutVolumeByCurrency": [
      { "currency": "BDT", "amount": "2000.00" },
      { "currency": "USDT", "amount": "500.00" }
    ]
  },
  "rows": [
    {
      "transactionId": "uuid",
      "type": "payin",
      "status": "success",
      "amount": "500.00",
      "paidAmount": "500.00",
      "currency": "BDT",
      "rail": "bangladesh",
      "railLabel": "Bangladesh pay-in",
      "platformOrderId": "2026061207000000009",
      "createdAt": "2026-06-12T10:00:00.000Z",
      "completedAt": "2026-06-12T10:05:00.000Z"
    }
  ]
}
```

**CSV:** same query with `format=csv` — browser download (`Content-Disposition: attachment`).

### Provider admin

```
GET /provider/merchants/:merchantId/reconciliation-report?environment=test&from=…&to=…&format=json|csv
```

**Permission:** `tx.read` (all roles with transaction read).

### UI guidance

Suggested page: **Reports → Reconciliation**

1. Environment toggle (`test` / `live`)
2. Date from / to (default: current month)
3. Summary cards: total; **pay-in / payout volume per currency** (`payinVolumeByCurrency`, `payoutVolumeByCurrency`); success / failed / pending
4. Sortable table from `rows` (columns: date, type, status, amount, currency, rail, platform order id, transaction id)
5. **Export CSV** → same URL with `format=csv` (open in new tab or `fetch` + blob download)

**Not included (v1):** per-row platform fees, wallet running balance — use transactions list + ledger ops for detail.

---

## 3. Email notifications (light)

Server sends email to **all portal users** on the merchant when:

| Event | Email subject pattern |
|-------|------------------------|
| Pay-in success | `Pay-in completed – Transacty` |
| Pay-in failed | `Pay-in failed – Transacty` |
| Payout success | `Payout completed – Transacty` |
| Payout failed | `Payout failed – Transacty` |

Also existing: login alert, password reset, portal payout **initiated** (Bangladesh dashboard payout).

**Frontend:** no settings screen required. Optional copy on Webhooks or Settings:

> Payment results are sent to your registered email and to your webhook URL.

Requires `EMAIL_FROM` + ZeptoMail/Resend/SMTP on API (see [PASSWORD_RESET_AND_EMAIL.md](./PASSWORD_RESET_AND_EMAIL.md)).

---

## 4. Provider — fee schedules (flexible pricing)

Per-merchant fees by **environment × rail × currency × fee type**.

**Rails:** `bangladesh` | `india` | `europe` | `cpg_crypto`  
**Fee types:** `payin` | `payout`

### List

```
GET /provider/merchants/:merchantId/fee-schedules?environment=test&status=active
```

**Permission:** `merchant.pricing.read`

```json
{
  "items": [
    {
      "id": "uuid",
      "environment": "test",
      "rail": "bangladesh",
      "currency": "BDT",
      "feeType": "payin",
      "billingMode": "percentage_only",
      "feePercentage": "3.0000",
      "feeFlat": "0.00",
      "feeMin": "0.00",
      "feeMax": null,
      "effectiveFrom": "2026-01-01T00:00:00.000Z",
      "effectiveTo": null,
      "status": "active"
    }
  ]
}
```

### Create schedule

```
POST /provider/merchants/:merchantId/fee-schedules
```

**Permission:** `merchant.pricing.write`  
**MFA step-up:** `merchant.pricing.write` → `POST /provider/auth/step-up` then header `X-Provider-Step-Up: <token>`

```json
{
  "environment": "test",
  "rail": "india",
  "currency": "USDT",
  "feeType": "payin",
  "billingMode": "percentage_only",
  "feePercentage": "1.5",
  "feeFlat": "0",
  "feeMin": "0",
  "feeMax": "50.00"
}
```

Legacy `GET/PATCH /provider/merchants/:merchantId/pricing` still works for simple Bangladesh % fees; prefer fee schedules for new UI.

### UI guidance

Merchant detail → **Pricing** tab:

- Table grouped by environment
- Columns: rail, currency, type, %, flat, min, max, effective from
- “Add schedule” modal
- Step-up MFA prompt before save (same pattern as wallet adjust)

---

## 5. Provider — FX spread (crypto send-out)

Admin sets **spread in basis points** (50 = 0.50%) on crypto debits for **CPG payout** and **EUR payout (USDC)**. Separate from platform % fee.

### Global profiles

```
GET  /provider/fx-rate-profiles?product=cpg_payout&settledCurrency=USDT
POST /provider/fx-rate-profiles
PATCH /provider/fx-rate-profiles/:id
POST /provider/fx-rate-profiles/preview-quote
```

**Permissions:** `merchant.rates.read` / `merchant.rates.write`  
**Step-up:** `merchant.rates.write` on POST/PATCH

**Create body example:**

```json
{
  "product": "cpg_payout",
  "settledCurrency": "USDT",
  "networkSymbol": "TRC20",
  "spreadBps": 25,
  "spreadMode": "on_output",
  "source": "manual_fixed"
}
```

**Preview quote:**

```json
POST /provider/fx-rate-profiles/preview-quote
{
  "product": "cpg_payout",
  "amount": "100.00",
  "settledCurrency": "USDT",
  "merchantId": "uuid",
  "environment": "test"
}
```

Response: `baseAmount`, `spreadBps`, `spreadAmount`, `totalDebit`.

### Per-merchant override

```
GET /provider/merchants/:merchantId/fx-overrides?environment=test
PUT /provider/merchants/:merchantId/fx-overrides
```

```json
{
  "environment": "test",
  "product": "cpg_payout",
  "settledCurrency": "USDT",
  "spreadBpsOverride": 40,
  "disabled": false
}
```

`disabled: true` blocks crypto send-out for that merchant/product.

### UI guidance

Finance → **FX & spread** (global) + merchant tab **FX overrides**.  
Show bps helper text: “25 bps = 0.25% extra on crypto debit”.

---

## 6. Provider — step-up MFA (new actions)

Existing step-up flow: `POST /provider/auth/step-up` with `{ "code": "123456", "action": "…" }`.

**New `action` values:**

| Action | Used for |
|--------|----------|
| `merchant.pricing.write` | Fee schedule create |
| `merchant.rates.write` | FX profile create/update, merchant FX override |
| `merchant.ip_whitelist.write` | (optional — in-app IP feature; ops may skip UI) |

Send token on write requests: `X-Provider-Step-Up: <jwt>`.

---

## 7. Merchant API — payout recipient (unchanged auth, richer response)

`POST /v1/payouts` and `GET /v1/payouts/:id` return **full** beneficiary details (merchant manages PII):

```json
{
  "transactionId": "uuid",
  "status": "pending",
  "amount": "200",
  "recipient": {
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
}
```

Portal payout create may still return masked recipient in portal-only routes — merchant **HMAC API** returns full object.

---

## 8. What frontend does **not** need to build

| Item | Reason |
|------|--------|
| In-app IP whitelist UI | Ops allowlists merchant server IP at infrastructure / Payok level |
| FX education screens | Internal ops concept; optional tooltip only |
| Merchant self-service fee editing | Provider admin only (v1) |
| Unified “create payment” wizard | Still per-rail APIs (`/v1/payins`, `/v1/h2h`, `/v1/cpg`, `/v1/eur`) |
| Full transaction detail API | `GET /v1/transactions/:id` still summary; use rail-specific GET for detail |

---

## 9. Suggested navigation map

### Portal

```
Dashboard
├── Balance / Wallets        (existing)
├── Transactions             (existing)
├── Reports
│   └── Reconciliation     ← NEW
├── Payouts / Pay-ins        (existing)
├── Settings
│   ├── Profile              ← show merchantSlug
│   ├── Webhooks
│   └── API Keys
```

### Provider

```
Merchant 360
├── Overview
├── KYC / Users / API keys   (existing)
├── Pricing                  ← fee schedules
├── FX overrides             ← NEW (optional tab)
├── Reconciliation           ← NEW
└── Audit log                (existing)

Finance (global)
└── FX rate profiles         ← NEW
```

---

## 10. Error codes to handle

| Code / status | Where | UI |
|---------------|-------|-----|
| `400` invalid date range | reconciliation | “Max 93 days” / invalid dates |
| `403` + `ip_not_allowed` | `/v1/*` HMAC | Rare if ops allowlists IP manually |
| `403` step-up required | provider writes | Open MFA modal, retry with header |

---

## Related docs

- [POSTMAN_MERCHANT_API_GUIDE.md](./POSTMAN_MERCHANT_API_GUIDE.md) — Bangladesh HMAC API
- [PROVIDER_DASHBOARD_API_UPDATE.md](./PROVIDER_DASHBOARD_API_UPDATE.md) — KYC, transactions, approvals
- [PORTAL_FRONTEND_SPEC.md](./PORTAL_FRONTEND_SPEC.md) — auth, KYC, wallets, transactions
- [PASSWORD_RESET_AND_EMAIL.md](./PASSWORD_RESET_AND_EMAIL.md) — email env vars
