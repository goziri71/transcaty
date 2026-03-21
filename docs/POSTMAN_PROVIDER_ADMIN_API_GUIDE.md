# Provider Admin API – Postman Testing Guide (Transcaty Super Admin)

> Step-by-step guide for testing the provider (master) admin endpoints under `/provider/*`.

---

## What This Is

This API is a **separate admin surface** from merchant portal.

| Surface | Auth | Postman doc |
| --- | --- | --- |
| **Merchant API** `/v1/*` | HMAC + API key | **`POSTMAN_MERCHANT_API_GUIDE.md`** — **not** covered here |
| **Merchant portal** `/portal/*` | JWT (dashboard users) | **`POSTMAN_PORTAL_TESTING.md`** |
| **Provider admin** `/provider/*` | Provider API key or provider JWT | **this document** |

**Merchant API is unchanged** by portal MFA, provider MFA, password reset, or `/metrics`. Those features only add **dashboard/admin** flows.

- Merchant portal routes: `/portal/*`
- Provider (Transcaty super-admin) routes: `/provider/*`

Provider auth supports two modes:

- `X-Provider-Key: <PROVIDER_API_KEY>`
- `Authorization: Bearer <provider_jwt_token>` after login

Recommended env:

- `PROVIDER_JWT_SECRET` for provider JWT signing
- `PROVIDER_IP_ALLOWLIST` to restrict admin access to known office/VPN IPs
- `PROVIDER_APPROVAL_THRESHOLD_AMOUNT` for high-risk maker-checker trigger

---

## Step 0: Create Provider Key (Yes, generate it yourself)

Yes, you should generate a strong random key.

Use one of these:

```bash
# Option A: Node (64 hex chars / 32 bytes)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```bash
# Option B: OpenSSL
openssl rand -hex 32
```

Set it in Render/local env:

```env
PROVIDER_API_KEY=<generated_value>
```

Optional encrypted setup:

```bash
npm run encrypt -- "<generated_value>"
```

Then set:

```env
PROVIDER_API_KEY_ENC=<encrypted_value>
ENCRYPTION_MASTER_KEY=<your_master_key>
```

Never expose this key in frontend code.

---

## Step 1: Postman Environment

Create environment, e.g. **Transcaty Provider Admin**.

| Variable | Value |
| --- | --- |
| `baseUrl` | `https://transcaty-building-technology-1.onrender.com` |
| `providerKey` | your `PROVIDER_API_KEY` |
| `providerToken` | (leave empty initially) |

Collection-level headers:

| Key | Value |
| --- | --- |
| `Authorization` | `Bearer {{providerToken}}` |
| `Content-Type` | `application/json` |

If `providerToken` is empty, you can temporarily use `X-Provider-Key: {{providerKey}}` for bootstrap and emergency access.

---

## Step 2: Bootstrap + Login (Phase 3)

### 2.1 Bootstrap first super admin (one-time)

POST `{{baseUrl}}/provider/auth/bootstrap`

Headers:

- `X-Provider-Key: {{providerKey}}`

Body:

```json
{
  "email": "superadmin@transcaty.com",
  "password": "ChangeMe123!",
  "fullName": "Transcaty Super Admin"
}
```

### 2.2 Login (with optional MFA)

POST `{{baseUrl}}/provider/auth/login`

```json
{
  "email": "superadmin@transcaty.com",
  "password": "ChangeMe123!"
}
```

**If MFA is not enabled** for this user, the response includes a normal session:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "authType": "jwt",
  "tokenType": "Bearer",
  "expiresIn": "12h",
  "user": { "id": "...", "email": "...", "role": "super_admin", "...": "..." }
}
```

Copy `token` into Postman env variable `providerToken`.

**If MFA is enabled**, you get a **second step** (no session JWT yet):

```json
{
  "requiresMfa": true,
  "mfaToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "authType": "jwt",
  "tokenType": "Bearer",
  "expiresIn": "5m",
  "user": { "id": "...", "email": "...", "role": "super_admin", "...": "..." }
}
```

Then call **2.2c MFA verify** (below) with the **6-digit TOTP code** from the authenticator app. The **success** response from that call contains the real `token` → save **`providerToken`** from that response.

### 2.2a Forgot password (email)

POST `{{baseUrl}}/provider/auth/forgot-password`

```json
{
  "email": "superadmin@transcaty.com"
}
```

Response is generic (same whether the user exists). Configure `EMAIL_FROM` + `RESEND_API_KEY` (or SMTP) and `PROVIDER_PUBLIC_URL` (or `APP_BASE_URL`) on the server.

### 2.2b Reset password

POST `{{baseUrl}}/provider/auth/reset-password`

```json
{
  "token": "<paste token from email link query string>",
  "password": "NewSecurePassword123!"
}
```

### 2.2c MFA verify (only when login returned `requiresMfa: true`)

POST `{{baseUrl}}/provider/auth/mfa/verify`

```json
{
  "mfaToken": "{{paste mfaToken from login response}}",
  "code": "123456"
}
```

Success `200` — same shape as a normal login without MFA (includes `token`, `expiresIn: "12h"`, `user`). Copy `token` → **`providerToken`**.

Errors `401`: bad/expired `mfaToken`, wrong code, or MFA not enabled.

### 2.3 Verify auth

GET `{{baseUrl}}/provider/me`

Headers: `Authorization: Bearer {{providerToken}}`

Expected `200` (JWT users may include MFA flags):

```json
{
  "role": "super_admin",
  "authType": "jwt",
  "email": "superadmin@transcaty.com",
  "mfaEnabled": true,
  "mfaPendingSetup": false
}
```

`mfaEnabled` / `mfaPendingSetup` appear when **JWT** auth is used (not for raw API key).

If `401`: token/key invalid.
If `500`: provider auth not configured on server.

### 2.3a MFA enrollment (optional — JWT only)

Use **provider JWT** (`Authorization: Bearer {{providerToken}}`). **API key** auth cannot manage MFA.

| Step | Method | Path | Body / notes |
| --- | --- | --- | --- |
| Status | GET | `/provider/me/mfa/status` | — |
| Start setup | POST | `/provider/me/mfa/setup` | Returns `otpauthUrl` (scan in Google Authenticator / Authy) |
| Confirm | POST | `/provider/me/mfa/confirm` | `{ "code": "123456" }` |
| Cancel setup | POST | `/provider/me/mfa/cancel` | Abandons enrollment |
| Disable MFA | POST | `/provider/me/mfa/disable` | `{ "password": "...", "code": "123456" }` |

Requires **`ENCRYPTION_MASTER_KEY`** on the server for encrypted TOTP secrets. Issuer labels: `PROVIDER_MFA_ISSUER` (optional; see `docs/MFA_AND_METRICS.md`).

### 2.4 Manage provider users (super admin)

- `GET /provider/auth/users`
- `POST /provider/auth/users`
- `PATCH /provider/auth/users/:userId`

---

## Step 3: Merchant Management

### 3.1 List merchants

GET `{{baseUrl}}/provider/merchants?limit=20&offset=0`

Optional filters:

- `status=pending|active|suspended|closed`
- `kycStatus=pending|verified|rejected`
- `q=<name search>`

### 3.2 Get merchant details

GET `{{baseUrl}}/provider/merchants/<merchantId>`

Includes merchant wallet + KYC summary counts.

### 3.3 Change merchant status

PATCH `{{baseUrl}}/provider/merchants/<merchantId>/status`

```json
{
  "status": "suspended",
  "reason": "Chargeback review"
}
```

### 3.4 Approve/reject KYC (merchant-level)

PATCH `{{baseUrl}}/provider/merchants/<merchantId>/kyc`

Approve:

```json
{
  "kycStatus": "verified"
}
```

Reject:

```json
{
  "kycStatus": "rejected",
  "reason": "Documents mismatch"
}
```

---

## Step 4: Customer Wallet Management (Global)

### 4.1 List customer wallets

GET `{{baseUrl}}/provider/customers?limit=20&offset=0`

Optional filters:

- `merchantId=<uuid>`
- `status=active|frozen|pending|closed`

### 4.2 Update customer wallet status

PATCH `{{baseUrl}}/provider/customers/<walletId>/status`

```json
{
  "status": "frozen",
  "reason": "Fraud monitoring"
}
```

Note: closing wallet with positive balance returns `400`.

---

## Step 5: Merchant Wallet Adjustments (Credit/Debit)

### POST `{{baseUrl}}/provider/merchants/<merchantId>/wallet-adjustments`

Credit example:

```json
{
  "direction": "credit",
  "amount": "500.00",
  "reason": "Manual settlement correction",
  "referenceId": "ops-ticket-1234"
}
```

Debit example:

```json
{
  "direction": "debit",
  "amount": "100.00",
  "reason": "Duplicate credit rollback",
  "referenceId": "ops-ticket-1235"
}
```

`referenceId` is required (use internal ticket/case ID).

Response includes previous/current balance.

---

## Step 6: Transaction Ops / Remediation

### 6.1 List transactions

GET `{{baseUrl}}/provider/transactions?limit=20&offset=0`

Optional filters:

- `merchantId=<uuid>`
- `type=payin|payout|transfer|refund`
- `status=pending|success|failed`

### 6.2 Change transaction status (manual remediation)

PATCH `{{baseUrl}}/provider/transactions/<transactionId>/status`

```json
{
  "status": "failed",
  "reason": "Provider timeout reconciliation",
  "ticketId": "ops-ticket-2201",
  "platformOrderId": "2026031807000000129"
}
```

Optional `paidAmount` can be sent when needed:

```json
{
  "status": "success",
  "reason": "Late callback reconciliation",
  "ticketId": "ops-ticket-2202",
  "paidAmount": "500.00",
  "force": true
}
```

Guardrail for Payok-backed tx (`payin`, `payout`):

- Without `force=true`, only `pending -> failed` is allowed.
- For any other transition, reconcile first, then use `force=true` with a valid `ticketId`.

### 6.3 Reconcile with Payok before force fixes

GET `{{baseUrl}}/provider/transactions/<transactionId>/reconcile`

Response shows:

- local status
- Payok inquiry payload/status
- `suggestedLocalStatus`
- `isMismatch`

Use this endpoint before manual force updates.

---

## Step 7: Maker-Checker Approvals (Phase 4)

High-risk actions are queued for approval (non-super-admin), including:

- large wallet adjustments (threshold-based)
- debit adjustments
- force/high-risk transaction status changes

### 7.1 List approval requests

GET `{{baseUrl}}/provider/approvals?status=pending&limit=20&offset=0`

Optional filters:

- `status=pending|approved|rejected|executed|cancelled`
- `actionType=wallet_adjustment|transaction_status_change`

### 7.2 Approve request

POST `{{baseUrl}}/provider/approvals/<requestId>/approve`

```json
{
  "note": "Reviewed and approved by risk"
}
```

Rules:

- Only roles with review permission can approve
- Maker-checker enforced: requester cannot approve own request

### 7.3 Reject request

POST `{{baseUrl}}/provider/approvals/<requestId>/reject`

```json
{
  "reason": "Missing supporting evidence"
}
```

---

## Suggested Test Sequence

1. `GET /provider/me`
2. `GET /provider/merchants`
3. Pick merchant ID
4. `GET /provider/merchants/:merchantId`
5. `PATCH /provider/merchants/:merchantId/kyc` (approve/reject)
6. `POST /provider/merchants/:merchantId/wallet-adjustments`
7. `GET /provider/transactions`
8. `PATCH /provider/transactions/:transactionId/status`
9. `GET /provider/transactions/:transactionId/reconcile` before force status change
10. `GET /provider/approvals?status=pending`
11. `POST /provider/approvals/:requestId/approve` (from different reviewer account)

---

## Metrics (ops / Prometheus)

**GET** `{{baseUrl}}/metrics`

- **Production:** set `METRICS_TOKEN` on the server; send `Authorization: Bearer <METRICS_TOKEN>`. Without `METRICS_TOKEN`, `/metrics` may return **404** when `NODE_ENV=production`.
- **Local dev:** often open if `METRICS_TOKEN` is unset.

Does **not** use provider or merchant credentials. See `docs/MFA_AND_METRICS.md`.

---

## Security Notes

- Rotate `PROVIDER_API_KEY` periodically.
- Restrict access to trusted backend tools and admin devices only.
- Keep provider actions tied to internal ticket/reference IDs.
- Monitor audit logs for:
  - `provider.merchant.status_changed`
  - `provider.merchant.kyc_changed`
  - `provider.customer.status_changed`
  - `provider.wallet.adjusted`
  - `provider.transaction.status_changed`
  - `provider.transaction.reconciled`

---

## Scope of This Version

This version provides core super-admin operations for live ops.

Potential next upgrades:

- Multi-user provider admins (instead of one API key)
- Fine-grained provider roles/permissions
- Stronger remediation workflows with dual approval
- Dedicated KYC document/person approval endpoints
