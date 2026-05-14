# Merchant Portal – Frontend Spec

> API contract and UX flow for the Transacty merchant dashboard. Use this to build the portal UI.

---

## Overview

Merchants sign up with minimal info, log in (optionally **MFA**), complete activation (KYC), then manage API keys. Two auth systems:

| Context | Auth | Use |
|--------|------|-----|
| **Portal** | JWT (Bearer token) | Dashboard UI – signup, login, **MFA**, **forgot password**, profile, KYC, API keys |
| **API** | HMAC (API key + secret) | Programmatic – payins, payouts, balance (**not** this doc; unchanged by portal MFA) |

**Implementation order for auth UI:** Login → if `requiresMfa`, show TOTP step → store session JWT → protected routes. Optional: **Forgot password** flow (email link to your SPA → reset form). Optional: **Security** settings for MFA enrollment (`/portal/me/mfa/*`).

**Tylt / cross-border (India)** uses the **same** merchant portal as Bangladesh: operators see **wallet pockets** (per currency), **one programmatic API key** permissioned by **scopes**, and **one transactions** timeline. Cross-border **pay-in/pay-out initiation** is **not** a separate portal wizard—it happens via the merchant **`/v1/h2h`** (India UPI pay-in; **H2H only**—no hosted CrossRamp create on `/v1`), **`/v1/cpg`**, etc. API (HMAC); the portal shows **balances** and **history**. Full UI flow for that product line: [§ Tylt and cross-border — merchant portal flows](#tylt-and-cross-border--merchant-portal-flows).

---

## Base URL

```
{API_BASE}/portal/...
```

Example: `https://api.transacty.com/portal/auth/login`

---

## Flow

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐     ┌─────────────────┐     ┌─────────────────────────────────┐
│   Signup    │────▶│    Login     │────▶│ MFA step?    │────▶│ Activation      │────▶│  Operations                      │
│ (minimal)   │     │ (email+pwd)  │     │ (if enabled) │     │ (KYC modal)     │     │  • API Keys  • Balance          │
└─────────────┘     └─────────────┘     └──────────────┘     └─────────────────┘     │  • Customers • Transactions      │
       │                    │                   │                     │             │  • Transfers • Refunds • Payouts  │
       │                    │                   │                     │             │  • Block/pending customer wallet │
       ▼                    ▼                   ▼                     ▼             └─────────────────────────────────┘
  businessName         See login           TOTP 6-digit        business, persons,
  email                responses           code                documents, submit
  password
```

1. **Signup** – Business name, email, password. Returns JWT + `needsActivation: true`.
2. **Login** – Email + password.
   - If MFA **off**: response includes `token` (session JWT) + `needsActivation` + `merchant`.
   - If MFA **on**: response includes `requiresMfa: true` and `mfaToken` (short-lived, **not** the session). Show TOTP input → **`POST /portal/auth/mfa/verify`** → then store `token`.
3. **Forgot password** (optional UX) – `POST /portal/auth/forgot-password` → email → user opens **`/reset-password?token=...`** on **your frontend** → `POST /portal/auth/reset-password`.
4. **Activation** – If `needsActivation`, show modal/wizard: business profile → persons → documents → submit.
5. **Operations** – Balance, customers, transactions, transfers, refunds, payouts, block/pending customer wallets.
6. **MFA enrollment** (optional) – Settings page: `GET /portal/me/mfa/status` → setup → QR → confirm (see **MFA (TOTP) – management** below).

---

## Auth

### Headers for protected routes

```
Authorization: Bearer <token>
```

Or:

```
X-Portal-Token: <token>
```

### Token storage

- Store **session** JWT in `localStorage` or `sessionStorage` after login **or** after successful **`/portal/auth/mfa/verify`**.
- **Do not** persist `mfaToken` longer than needed — it is only for the second login step (minutes).
- Include `Authorization: Bearer <session_token>` on all requests to `/portal/me/*`, `/portal/me/kyc/*`, `/portal/me/api-keys/*`, etc.

### Logout

- Call `POST /portal/auth/logout` (optional).
- Clear stored token and redirect to login.

### Routes to implement (auth)

| Route | Purpose |
|-------|---------|
| `/login` | Email + password |
| `/login/mfa` or inline step | Shown when login returns `requiresMfa: true` — TOTP code + call `POST /portal/auth/mfa/verify` |
| `/forgot-password` | Email → `POST /portal/auth/forgot-password` |
| `/reset-password` | Read `token` from query `?token=` → new password → `POST /portal/auth/reset-password` |
| `/settings/security` (optional) | MFA enrollment: `GET/POST /portal/me/mfa/*` |

---

## Endpoints

### 1. Signup

**POST** `/portal/auth/signup`

| Header | Value |
|--------|-------|
| Content-Type | application/json |

**Body**

```json
{
  "businessName": "Acme Inc",
  "email": "admin@acme.com",
  "password": "securePassword123"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| businessName | string | yes | 1–200 chars |
| email | string | yes | Valid email |
| password | string | yes | 8–128 chars |

**Success (201)**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "merchantId": "uuid",
  "email": "admin@acme.com",
  "role": "admin",
  "needsActivation": true,
  "merchant": {
    "name": "Acme Inc",
    "status": "pending",
    "kycStatus": "pending"
  }
}
```

**Error (400)**

```json
{
  "error": "Bad Request",
  "message": "Email already registered"
}
```

---

### 2. Login

**POST** `/portal/auth/login`

**Body**

```json
{
  "email": "admin@acme.com",
  "password": "securePassword123"
}
```

**Success (200) when MFA is not enabled**

Response includes a **session JWT** in `token`. Store it and use for all `/portal/me/*` calls.

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "merchantId": "uuid",
  "email": "admin@acme.com",
  "role": "admin",
  "needsActivation": true,
  "merchant": {
    "name": "Acme Inc",
    "status": "pending",
    "kycStatus": "pending"
  }
}
```

**Success (200) when MFA is enabled**

No session `token` yet. User must complete **§ MFA login – second step** below.

```json
{
  "requiresMfa": true,
  "mfaToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "merchantId": "uuid",
  "email": "admin@acme.com"
}
```

| Field | Frontend action |
|-------|------------------|
| `requiresMfa` | If `true`, show TOTP (6-digit) step; **do not** navigate as logged-in yet |
| `mfaToken` | Send with `POST /portal/auth/mfa/verify` together with the code from the authenticator app |
| `merchantId` / `email` | Optional display; session is issued only after MFA verify |

**Error (401)**

```json
{
  "error": "Unauthorized",
  "message": "Invalid email or password"
}
```

---

### 2a. MFA login – second step

**POST** `/portal/auth/mfa/verify`

No `Authorization` header (public endpoint).

**Body**

```json
{
  "mfaToken": "<from login response when requiresMfa was true>",
  "code": "123456"
}
```

| Field | Notes |
|-------|--------|
| mfaToken | Short-lived JWT from login (`mfaToken`) |
| code | 6-digit TOTP from authenticator app (spaces stripped server-side) |

**Success (200)** — same shape as a normal login **without** MFA:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "merchantId": "uuid",
  "email": "admin@acme.com",
  "role": "admin",
  "needsActivation": true,
  "merchant": {
    "name": "Acme Inc",
    "status": "pending",
    "kycStatus": "pending"
  }
}
```

Store `token` as the session JWT.

**Error (401)** — invalid/expired `mfaToken`, wrong code, or MFA not enabled for user.

---

### 3. Logout

**POST** `/portal/auth/logout`

No body. Returns `{ "ok": true }`. Client clears token.

---

### Forgot password

**POST** `/portal/auth/forgot-password`

**Body:** `{ "email": "admin@acme.com" }`

**Success (200)** — same message whether or not the email exists:

```json
{
  "ok": true,
  "message": "If an account exists for this email, you will receive reset instructions shortly."
}
```

Sends an email with a link: `{base}/reset-password?token=...`

**Base URL:** `PORTAL_PUBLIC_URL` (falls back to `APP_BASE_URL` if unset).
- **PORTAL_PUBLIC_URL** must be your merchant dashboard SPA origin (e.g. `https://dashboard.transacty.ai`) — **not** the API URL.
- If only `APP_BASE_URL` is set (e.g. `https://api.transacty.ai`), the link points to the API, which has no reset page → user gets 404 or wrong content.
- **Set `PORTAL_PUBLIC_URL`** in backend env to the exact origin where your SPA runs.

**Rate limit:** per IP (requires `REDIS_URL` for distributed limits). Env: `PASSWORD_RESET_REQUESTS_PER_IP_PER_HOUR` (default `5`).

**Full flow (frontend):**
1. User visits `/forgot-password`, enters email, submits.
2. Frontend: `POST {API_BASE}/portal/auth/forgot-password` with `{ "email": "..." }`.
3. Backend (if user exists): queues email with link `{PORTAL_PUBLIC_URL}/reset-password?token={hex}`.
4. User receives email, clicks link → lands on `{PORTAL_PUBLIC_URL}/reset-password?token=...`.
5. Frontend `/reset-password` route: read `token` from `?token=`, show password form.
6. User submits → `POST {API_BASE}/portal/auth/reset-password` with `{ "token": "...", "password": "..." }`.
7. On 200: redirect to `/login`.

---

### Reset password

**POST** `/portal/auth/reset-password`

**Body:** `{ "token": "<from email query string>", "password": "newSecurePassword123" }`

**Success (200):** `{ "ok": true }`

**Error (400):** invalid or expired token.

---

### MFA (TOTP) – management

Requires **session JWT** (`Authorization: Bearer <token>`). Backend needs **`ENCRYPTION_MASTER_KEY`** to store secrets.

| Step | Method | Path | Body | Notes |
|------|--------|------|------|--------|
| Status | GET | `/portal/me/mfa/status` | — | `{ enabled, pendingSetup }` |
| Start setup | POST | `/portal/me/mfa/setup` | — | Returns `otpauthUrl`, `issuer`, `accountEmail` — render QR or open in authenticator |
| Confirm | POST | `/portal/me/mfa/confirm` | `{ "code": "123456" }` | After user scans QR and app shows code |
| Cancel setup | POST | `/portal/me/mfa/cancel` | — | Clears in-progress enrollment |
| Disable | POST | `/portal/me/mfa/disable` | `{ "password": "...", "code": "123456" }` | Current password + current TOTP |

**UX:** Settings → Security → “Enable two-factor” → show QR (`otpauthUrl` or QR from URL) → user enters code → confirm → next login will use **§2 + §2a** flow.

**Issuer** in the app label: server env `PORTAL_MFA_ISSUER` (optional). See `docs/MFA_AND_METRICS.md`.

---

### 4. Get profile

**GET** `/portal/me`

**Headers:** `Authorization: Bearer <token>`

**Success (200)**

```json
{
  "merchantId": "uuid",
  "businessName": "Acme Inc",
  "email": "admin@acme.com",
  "role": "admin",
  "kycStatus": "pending",
  "needsActivation": true,
  "canCreateApiKeys": false,
  "businessProfile": null,
  "personsCount": 0,
  "documentsCount": 0,
  "mfaEnabled": false,
  "mfaPendingSetup": false
}
```

| Field | Description |
|-------|-------------|
| kycStatus | `pending` \| `verified` \| `rejected` |
| needsActivation | Show activation modal when `true` |
| canCreateApiKeys | `true` only when `kycStatus === 'verified'` |
| businessProfile | `null` until business profile is created |
| mfaEnabled | `true` if TOTP MFA is active for this user |
| mfaPendingSetup | `true` if enrollment started but not confirmed (show “finish setup” in UI) |

---

### 5. Get balance

**GET** `/portal/me/balance?environment=test|live` (default: `test`)

**Semantics (backward-compatible):** Returns a **single** row for the **domestic primary** wallet. If the merchant has **more than one** active merchant wallet in that environment (e.g. BDT + USDT for cross-border), the API **prefers BDT**, then orders by `currency` and `id` so the result is deterministic. Merchants with only the default BDT wallet see **unchanged** behaviour.

**Success (200)**

```json
{
  "balance": "1000.00",
  "availableBalance": "1000.00",
  "pendingBalance": "0",
  "currency": "BDT",
  "lastUpdated": "2025-03-09T12:00:00.000Z",
  "limits": {
    "payin": { "min": 200, "max": 25000 },
    "payout": { "min": 100, "max": 25000 }
  }
}
```

To show **every** currency “pocket” (e.g. Bangladesh BDT vs Tylt settled balance) in the dashboard, use **`GET /portal/me/wallets`** below instead of inferring from this endpoint alone.

---

### 5a. List merchant wallets (multi-currency pockets)

**GET** `/portal/me/wallets?environment=test|live` (default: `test`)

Returns all **active** **merchant** wallets for this merchant and environment—one entry per `currency` pocket. **Customer** wallets are not included (use customers APIs). Use this to render separate balance cards (e.g. “Bangladesh” vs “Cross-border”) without merging amounts.

**Success (200)**

```json
{
  "environment": "live",
  "items": [
    {
      "id": "uuid",
      "currency": "BDT",
      "balance": "1000.00",
      "status": "active",
      "label": null,
      "updatedAt": "2025-03-09T12:00:00.000Z",
      "createdAt": "2025-01-01T10:00:00.000Z"
    }
  ]
}
```

`label` is reserved for future use on merchant wallets (usually `null`). Ordering matches the balance endpoint: **BDT first**, then alphabetical currency, then `id`.

---

### 6. Update profile

**PATCH** `/portal/me`

**Body**

```json
{
  "businessName": "Acme Corp"
}
```

**Success (200)** `{ "ok": true }`

---

### 7. KYC – Business profile

**PUT** `/portal/me/kyc/business`

**Body**

```json
{
  "legalName": "Acme Corporation Ltd",
  "tradingName": "Acme",
  "businessType": "private_limited",
  "registrationNumber": "REG-123",
  "incorporationDate": "2020-01-15T00:00:00.000Z",
  "industry": "technology",
  "registeredAddress": "123 Main St, Dhaka",
  "operatingAddress": "123 Main St, Dhaka",
  "taxId": "TIN-123",
  "contactPhone": "+8801712345678",
  "contactEmail": "legal@acme.com"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| legalName | yes | |
| tradingName | no | |
| businessType | yes | e.g. sole_proprietorship, partnership, private_limited |
| registrationNumber | no | |
| incorporationDate | no | ISO 8601 |
| industry | no | |
| registeredAddress | yes | |
| operatingAddress | no | |
| taxId | no | |
| contactPhone | yes | |
| contactEmail | yes | Valid email |

**Success (200)** `{ "id": "uuid", "status": "draft" }`

---

### 8. KYC – Add person

**POST** `/portal/me/kyc/persons`

**Body**

```json
{
  "role": "director",
  "fullName": "John Doe",
  "nationality": "BD",
  "dateOfBirth": "1985-06-15T00:00:00.000Z",
  "idType": "nid",
  "idNumber": "1234567890",
  "address": "456 Oak Ave, Dhaka",
  "ownershipPercentage": 25
}
```

| Field | Required | Notes |
|-------|----------|-------|
| role | yes | `director` \| `ubo` \| `authorized_signatory` |
| fullName | yes | |
| nationality | yes | |
| dateOfBirth | no | ISO 8601 |
| idType | yes | `nid` \| `passport` |
| idNumber | yes | |
| address | yes | |
| ownershipPercentage | no | 0–100 (for UBO) |

**Success (200)** `{ "id": "uuid" }`

---

### 9. KYC – List persons

**GET** `/portal/me/kyc/persons`

**Success (200)**

```json
{
  "items": [
    {
      "id": "uuid",
      "role": "director",
      "fullName": "John Doe",
      "status": "pending"
    }
  ]
}
```

---

### 10a. KYC – Get presigned upload URL

**POST** `/portal/me/kyc/documents/upload-url`

Get a presigned URL to upload a file directly to S3/R2. Frontend uploads via `PUT` to `uploadUrl`, then sends `fileReference` to `POST /portal/me/kyc/documents`.

**Body**

```json
{
  "documentType": "registration_certificate",
  "filename": "certificate.pdf",
  "contentType": "application/pdf",
  "merchantPersonId": "uuid"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| documentType | yes | e.g. registration_certificate, trade_license, nid, passport |
| filename | yes | Original filename (used for extension) |
| contentType | no | application/pdf, image/jpeg, image/png, etc. Default: application/octet-stream |
| merchantPersonId | no | Link to person if person-specific doc |

**Success (200)**

```json
{
  "uploadUrl": "https://xxx.supabase.co",
  "uploadToken": "signed-token...",
  "path": "kyc/{merchantId}/{uuid}-certificate.pdf",
  "bucket": "kyc-documents",
  "fileReference": "kyc/{merchantId}/{uuid}-certificate.pdf",
  "expiresIn": 7200
}
```

**Flow:** 1) Call this endpoint; 2) Use Supabase client: `supabase.storage.from(bucket).uploadToSignedUrl(path, uploadToken, file)`; 3) Call `POST /portal/me/kyc/documents` with `fileReference`.

---

### 10b. KYC – Add document

**POST** `/portal/me/kyc/documents`

**Body**

```json
{
  "documentType": "registration_certificate",
  "fileReference": "kyc/{merchantId}/{uuid}-certificate.pdf",
  "documentNumber": "DOC-123",
  "merchantPersonId": "uuid"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| documentType | yes | e.g. registration_certificate, trade_license, nid, passport |
| fileReference | yes | From `upload-url` response (must be from this merchant) |
| documentNumber | no | |
| merchantPersonId | no | Link to person if person-specific doc |

**Success (200)** `{ "id": "uuid" }`

---

### 11. KYC – List documents

**GET** `/portal/me/kyc/documents`

**Success (200)**

```json
{
  "items": [
    {
      "id": "uuid",
      "documentType": "registration_certificate",
      "status": "pending",
      "submittedAt": "2025-03-09T12:00:00.000Z"
    }
  ]
}
```

---

### 12. KYC – Submit

**POST** `/portal/me/kyc/submit`

No body. Requires business profile to exist.

**Success (200)** `{ "status": "submitted" }`

**Error (400)** `{ "error": "Business profile required before submit" }`

---

### 13. API Keys – List

**GET** `/portal/me/api-keys`

Requires `kycStatus === 'verified'`.

**Success (200)**

```json
{
  "items": [
    {
      "id": "uuid",
      "keyMasked": "••••••••abcd1234",
      "environment": "test",
      "scopes": "payin:create,payout:create,balance:read,*",
      "status": "active",
      "createdAt": "2025-03-09T12:00:00.000Z"
    }
  ]
}
```

**Error (403)** `{ "error": "Forbidden", "message": "KYC verification required to manage API keys" }`

---

### 14. API Keys – Create

**POST** `/portal/me/api-keys`

**Body**

```json
{
  "environment": "test"
}
```

| Field | Required | Default | Notes |
|-------|----------|---------|-------|
| environment | no | test | `live` \| `test` |

**Success (201)**

```json
{
  "id": "uuid",
  "apiKey": "transacty_abc123...",
  "secret": "64-char-hex",
  "environment": "test",
  "scopes": "payin:create,payout:create,balance:read,*",
  "message": "Save the secret securely. It will not be shown again."
}
```

**Important:** Show the secret once. User must copy it; it cannot be retrieved later.

**Error (403)** Same as list.

---

### 15. API Keys – Revoke

**DELETE** `/portal/me/api-keys/:keyId`

**Success (200)** `{ "ok": true }`

**Error (404)** `{ "error": "Not found", "message": "API key not found" }`

---

## Customers (operational)

### 16. Customers – List

**GET** `/portal/me/customers`

**Query params:** `limit`, `offset`, `status` (active | frozen | pending | closed)

**Success (200)**

```json
{
  "items": [
    {
      "id": "uuid",
      "label": "John Doe",
      "balance": "150.00",
      "currency": "BDT",
      "status": "active",
      "createdAt": "2025-03-09T12:00:00.000Z"
    }
  ],
  "total": 10,
  "limit": 20,
  "offset": 0
}
```

---

### 17. Customers – Create

**POST** `/portal/me/customers`

**Body**

```json
{
  "label": "John Doe"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| label | no | Display name (e.g. customer name, email) |

**Success (201)** Returns customer wallet object.

---

### 18. Customers – Get

**GET** `/portal/me/customers/:id`

**Success (200)** Returns customer wallet detail.

---

### 19. Customers – Update status (block / pending / active / closed)

**PATCH** `/portal/me/customers/:id/status`

**Body**

```json
{
  "status": "frozen",
  "reason": "Fraud investigation"
}
```

| status | Use |
|--------|-----|
| active | Normal – wallet can receive/send |
| frozen | Blocked – no transfers, refunds, or payouts |
| pending | Under review (e.g. fraud) – same as frozen for operations |
| closed | Permanently closed – balance must be 0 |

**Success (200)** `{ "id": "uuid", "status": "frozen" }`

**Error (400)** `{ "error": "Bad Request", "message": "Cannot close wallet with positive balance. Transfer or refund first." }`

---

### 20. Customers – List transactions

**GET** `/portal/me/customers/:id/transactions`

**Query params:** `limit`, `offset`

**Success (200)** Returns paginated transactions for that customer wallet.

---

## Transactions (operational)

### 21. Transactions – List

**GET** `/portal/me/transactions`

**Query params:** `type` (payin | payout | transfer | refund), `status` (pending | success | failed), `customerId` (wallet uuid), `limit`, `offset`

**Success (200)**

```json
{
  "items": [
    {
      "id": "uuid",
      "type": "payin",
      "status": "success",
      "amount": "500.00",
      "paidAmount": "500.00",
      "platformOrderId": "payok-123",
      "customerWalletId": null,
      "refundOfTransactionId": null,
      "metadata": null,
      "createdAt": "2025-03-09T12:00:00.000Z",
      "completedAt": "2025-03-09T12:01:00.000Z"
    }
  ],
  "total": 50,
  "limit": 20,
  "offset": 0
}
```

List items include `metadata` when present. See [Transaction metadata](#22-transactions--get) below for field shapes by type.

---

### 22. Transactions – Get

**GET** `/portal/me/transactions/:id`

**Success (200)** Returns full transaction detail including metadata.

```json
{
  "id": "uuid",
  "type": "payin",
  "status": "success",
  "amount": "500.00",
  "paidAmount": "500.00",
  "platformOrderId": "payok-123",
  "customerWalletId": null,
  "refundOfTransactionId": null,
  "metadata": { },
  "createdAt": "2025-03-09T12:00:00.000Z",
  "completedAt": "2025-03-09T12:01:00.000Z"
}
```

**Transaction metadata** (by type)

`metadata` is a JSON object. Shape varies by `type`:

| type | metadata fields | Purpose |
|------|-----------------|---------|
| **payin** | `environment` | `"test"` or `"live"` |
| | `paymentMethodCode` | Provider payment method (e.g. bKash, Nagad) |
| **payout** | `environment` | `"test"` or `"live"` |
| | `benificiaryAccountInfo` | `{ number, orgId, orgCode, orgName, holderName }` – recipient account |
| | `failedStage` | If failed: `"account_inquiry"` or `"create_payout"` |
| | `failureReason` | If failed: error message from provider |
| **transfer** | `reason` | Optional note for the transfer |
| **refund** | `refundOfTransactionId` | Original payin transaction ID |
| | `reason` | Optional refund reason |
| | `customerWalletId` | Customer wallet credited |

**Internal fields** – Transacty ops may add `providerFix: { fixedAt, ... }` when reconciling or fixing a transaction. Safe to ignore in merchant UI.

---

### 23. Transfers – Create (money to customer)

**POST** `/portal/me/transfers`

**Body**

```json
{
  "customerWalletId": "uuid",
  "amount": "100.00",
  "reason": "Bonus payment"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| customerWalletId | yes | Customer wallet to credit |
| amount | yes | Positive decimal |
| reason | no | Internal note |

**Success (201)** Returns transaction object.

**Error (400)** `{ "error": "Bad Request", "message": "Insufficient balance" }` or `"Customer wallet is blocked or pending"`

---

### 24. Refunds – Create (money return to customer)

**POST** `/portal/me/refunds`

**Body**

```json
{
  "customerWalletId": "uuid",
  "amount": "50.00",
  "refundOfTransactionId": "uuid",
  "reason": "Duplicate charge"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| customerWalletId | yes | Customer wallet to credit |
| amount | yes | Positive decimal |
| refundOfTransactionId | yes | Original payin transaction ID (for audit) |
| reason | no | Internal note |

**Success (201)** Returns refund transaction object.

**Error (400)** Same as transfers.

---

### 25. Payouts – Create (merchant dashboard)

**POST** `/portal/me/payouts`

Creates a payout request from merchant dashboard using portal JWT auth.

**Body**

```json
{
  "environment": "test",
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

| Field | Required | Notes |
|-------|----------|-------|
| environment | no | `test` or `live` (default `test`) |
| amount | yes | Must be within payout limits |
| benificiaryAccountInfo | yes | Recipient account details |
| cardHolderInfo | yes | Sender identity details |

**Success (201)**

```json
{
  "transactionId": "uuid",
  "reference": "uuid",
  "status": "pending",
  "amount": "300.00",
  "platformOrderId": "2026031807090000044",
  "environment": "test",
  "recipient": { "masked": "****5678" },
  "estimatedCompletion": null
}
```

**Error (400)**

```json
{
  "error": "Bad Request",
  "message": "Payok account inquiry failed: ...",
  "transactionId": "uuid",
  "reference": "uuid",
  "platformOrderId": null
}
```

**Error (403)** for live environment when merchant is not active or KYC is not verified.

---

## Error format

All errors follow:

```json
{
  "error": "ErrorType",
  "message": "Human-readable message"
}
```

| Status | Typical error |
|--------|----------------|
| 400 | Bad Request – validation, duplicate email |
| 401 | Unauthorized – missing/invalid token, wrong credentials |
| 403 | Forbidden – KYC required, account suspended |
| 404 | Not found |
| 500 | Internal – server error |

---

## Tylt and cross-border — merchant portal flows

This section is the **implementation guide** for showing **Tylt / India (cross-border)** alongside **Bangladesh (domestic)** in the merchant dashboard. For **Postman / `v1` HMAC** testing of the API you give merchants, use **`docs/TYLT_MERCHANT_API_TESTING.md`**—that file is **not** for frontend dashboard implementation.

### Product model (what the merchant understands)

- **Transacty** is what merchants see (portal + `/v1` API). Under the hood, **domestic** traffic may use Payok (Bangladesh); **cross-border / India** traffic is processed via integration routes exposed as **`/v1/h2h`**, **`/v1/cpg`**, etc. (merchants never see the processor name in the URL). **India UPI pay-in** uses **`/v1/h2h`** only on the merchant API.
- **One merchant account**, **one portal login**, **one programmatic API key type** (`transacty_…`). There are **not** separate “BD keys” and “Tylt keys”—**scopes** on the key decide whether domestic payin/payout, Tylt rails, or balances are allowed.
- **Wallet balances** are **not** merged across rails: each **currency** is a separate **merchant wallet** row (**pocket**), e.g. BDT vs a settled USD-like/crypto pocket used for Tylt.

### Portal vs merchant API — who does what

| Concern | Merchant portal (`/portal/*`, JWT) | Merchant API (`/v1/*`, HMAC) |
|--------|-------------------------------------|--------------------------------|
| Signup, login, MFA, password reset | Yes | No |
| KYC uploads / activation | Yes | No |
| Create, list, revoke **API keys** (incl. **scopes**) | Yes | N/A (uses keys) |
| View **balance** snapshot (single primary row) | `GET /portal/me/balance` | `GET /v1/balance` |
| View **all wallet pockets** (per currency) | **`GET /portal/me/wallets`** | — |
| **Domestic** payin/payout (Bangladesh) | Optional portal payins/payouts where implemented | `POST /v1/payins`, payouts, etc. |
| **Cross-border** H2H UPI / CPG pay-in/out, internal transfer | **No dedicated portal wizard**—merchants (or integrators) call API | **`POST` / `GET` under `/v1/h2h`, `/v1/cpg`, …** (see testing doc) |
| **Transactions** history (all rails that write to ledger) | `GET /portal/me/transactions` (+ detail) | `GET /v1/transactions` |
| Merchant **webhook** URL | `PATCH /portal/me/webhook` (and GET) | `PATCH /v1/me/webhook` pattern (HMAC) for programmatic |

**Important:** The SPA must **never** embed the API **secret** or implement browser-side HMAC for production. Portal features use **JWT** only. Integrators test Tylt with **Postman** or a **server**.

### Recommended frontend implementation order (Tylt-aware)

1. **Environment switch** — `test` \| `live` on dashboard (already required for balance, keys, and txs). Tylt and domestic rows share the same `environment` dimension.
2. **Wallets-first overview** — On shell load (after auth): `GET /portal/me`, `GET /portal/me/balance`, **`GET /portal/me/wallets`**. Render **one card per** `items[]` pocket; do **not** sum unlike currencies into one headline.
3. **Optional regional UX** — Group pockets in the UI (e.g. “Bangladesh” when `currency === BDT`, “Cross-border / India” when `currency` is the settled pocket used for Tylt—**you can derive labels from `currency` and product rules**; no extra API field is required for v1).
4. **API Keys** — Obey `canCreateApiKeys` (KYC **verified**). Show **scopes** on each key; explain **one key** gates **both** domestic and Tylt (see **API keys and scopes (flow)** below). In **help text or docs links** for integrators, point to **`docs/TYLT_MERCHANT_API_TESTING.md`** (Postman, **`/v1` HMAC only**—not for building the portal UI). See esp. §11.
5. **Transactions** — Same list for all rails. **`GET /portal/me/transactions`** returns **id, type, status, amount**, etc. (see route schema in this doc—**currency** / **provider** are not always exposed on list items); **`GET /portal/me/transactions/:id`** returns **`metadata`** when present—**Tylt** rows often include **`rail`**, **`tyltProduct`**, etc. Use **metadata** on **detail** (when present) to show a **badge** or filter “Tylt” vs domestic; if `metadata` is missing or opaque, show **type / amount / status** (and **currency** when the API exposes it).
6. **Webhooks** — Configure **one** merchant webhook URL in portal settings where supported; server delivers events for activity originating from any rail the merchant uses.
7. **KYC / live** — If the environment is **live** and `KYC_REQUIRED` is on in production, **Tylt create** routes and some domestic flows require **`kycStatus === verified`**—mirror existing portal messaging (“complete verification”).

### Balances and wallet pockets (flow)

1. User selects **test** or **live** (persist per session or user preference).
2. Call **`GET /portal/me/wallets?environment=…`**.
3. For each item: show **currency**, **balance**, **status**, **updatedAt**; optional **copy** explaining this pocket may reflect **cross-border** activity when the currency is not BDT.
4. **`GET /portal/me/balance`** remains the **compat** single-row view (BDT-first when multiple wallets exist). Prefer **wallets** for any “India / Tylt” or multi-currency headline area.

### API keys and scopes (flow)

1. **List keys** — `GET /portal/me/api-keys` (when authenticated); show masked key, **scopes** string, environment, created/revoked state per your existing spec.
2. **Create key** — Modal: enforce **scopes** input or **preset** chips (e.g. “Domestic payin/payout”, “Cross-border full”, “Read-only balance”). **Document in UI** that **cross-border** paths under `/v1/h2h`, `/v1/cpg`, etc. use the **same** key as domestic routes; missing scopes yield **403** on the API.
3. **Recommended scope string** (sandbox / full regression; tighten in production):  
   `payin:create,payout:create,balance:read,internal_transfer:create` or `*` only in non-prod sandboxes. Align copy with `docs/TYLT_MERCHANT_API_TESTING.md` § scopes (`tylt:internal_transfer` legacy).
4. **Secret** — Show **once** on create; warn **not** to commit to frontend. Point to **Postman** doc for HMAC testing.
5. **Revocation** — Existing revoke flow; after revoke, Tylt and domestic calls with that key fail.

### Transactions and support (flow)

1. **`GET /portal/me/transactions`** — Paginated list; includes **all** merchant ledger transactions the backend records (domestic + Tylt) for that `environment`.
2. **Detail** — `GET /portal/me/transactions/:id` — display **`metadata`** JSON in an “Advanced” or ops-friendly panel if useful; parse known keys (`rail`, `tyltProduct`) for a **product** label when present.
3. **Payouts UI** — Existing **domestic** portal payout flows (if any) remain **Payok-shaped**; **CPG payouts** are initiated via **`POST /v1/cpg/payout-requests`**; the portal still shows **resulting** balance and **transaction** rows.

### What we do **not** build in the portal for v1 (by design)

- Hosted **CrossRamp** iframe / redirect UI (there is **no** `rampUrl` **create** route on `/v1`), **H2H** UPI step-by-step, or **CPG** travel-rule forms—the merchant product surface for those is the **`/v1/*` cross-border API** or a **merchant-built** checkout. The portal’s job is **visibility** (money + history + keys), not replacing those APIs.

### Engineer reference (Postman / `/v1`)

- **Full ordered checklist** of Tylt merchant endpoints: **`docs/TYLT_MERCHANT_API_TESTING.md`** §11.  
- **Domestic HMAC** primer (same signing pattern): **`docs/POSTMAN_MERCHANT_API_GUIDE.md`**.

---

## UX recommendations

### Signup page

- Fields: business name, email, password (with confirmation).
- On success: store token, redirect to dashboard. Check `needsActivation` to show modal.

### Login page

- Fields: email, password.
- **If response has `token`:** store as session JWT, redirect to dashboard. Check `needsActivation` for activation modal.
- **If response has `requiresMfa: true`:** do **not** store session yet. Keep `mfaToken` in memory (or state) only. Show a **second screen** (same route or `/login/mfa`) with one field: 6-digit authenticator code → `POST /portal/auth/mfa/verify` with `{ mfaToken, code }`. On success, store returned `token` and redirect.
- Link to **Forgot password** → `/forgot-password`.

### Forgot password page

- **URL:** `{SPA_ORIGIN}/forgot-password` (e.g. `https://dashboard.transacty.ai/forgot-password`)
- Single field: email.
- **Request:** `POST {API_BASE}/portal/auth/forgot-password` with `{ "email": "user@example.com" }`
- Always show the same success copy (do not reveal whether email exists).
- **Headers:** `Content-Type: application/json` (no auth required).

### Reset password page

- **URL:** `{SPA_ORIGIN}/reset-password?token=...` — the email link sends users here.
- **Critical:** Backend must have `PORTAL_PUBLIC_URL={SPA_ORIGIN}` (e.g. `https://dashboard.transacty.ai`). If unset, it falls back to `APP_BASE_URL` (the API URL), and the link will point to the wrong place (API has no reset page).
- Route must read **`token`** from query string: `?token=` (use `window.location.search`, `URLSearchParams`, or your router).
- Fields: new password (+ confirm).
- **Request:** `POST {API_BASE}/portal/auth/reset-password` with `{ "token": "<from query>", "password": "newSecurePassword123" }`
- On success: redirect to `/login`.
- **Headers:** `Content-Type: application/json` (no auth required).

### Security / MFA settings (optional)

- `GET /portal/me` shows `mfaEnabled` and `mfaPendingSetup`.
- **Enroll:** `POST /portal/me/mfa/setup` → display QR from `otpauthUrl` (or use a QR library) → `POST /portal/me/mfa/confirm` with `{ code }`.
- **Disable:** password + TOTP → `POST /portal/me/mfa/disable`.
- **Cancel in-progress:** `POST /portal/me/mfa/cancel` if user started setup but did not confirm.

### Dashboard layout

- Header: business name, email, balance, logout.
- Sidebar or tabs: Overview, Balance, Transactions, Customers, KYC, API Keys, **Settings** (optional).
- On load: `GET /portal/me`, `GET /portal/me/balance`, and `GET /portal/me/wallets` (to show **per-currency** merchant pockets, e.g. BDT vs USDT, without merging). If `needsActivation`, show activation modal (or redirect to activation wizard).
- If `mfaPendingSetup === true`, show banner: “Finish two-factor setup” linking to Security.

### Activation flow (modal or wizard)

1. **Business** – Form for `PUT /portal/me/kyc/business`.
2. **Persons** – Add directors/UBOs via `POST /portal/me/kyc/persons`. Show list from `GET /portal/me/kyc/persons`.
3. **Documents** – Add docs via `POST /portal/me/kyc/documents`. `fileReference` – upload flow TBD (e.g. presigned URL, direct upload).
4. **Submit** – `POST /portal/me/kyc/submit`. Show "Pending verification" state.

### API Keys page

- Show only when `canCreateApiKeys === true`.
- List keys with masked display. "Create key" button → modal with copy for key + secret.
- Show **scopes** per key and explain that **Bangladesh and Tylt share one key**; scopes gate both. Optional **“API docs”** link for **merchant server / Postman** testers: **`docs/TYLT_MERCHANT_API_TESTING.md`** (not the portal frontend spec). For the full **portal** flow (wallets, tabs, what is not in the portal), see [§ Tylt and cross-border — merchant portal flows](#tylt-and-cross-border--merchant-portal-flows).
- Revoke button per key.

### Customers page

- List customers (`GET /portal/me/customers`). Filter by status (active, frozen, pending, closed).
- "Add customer" → create with optional label.
- Per customer: view detail, balance, transactions. Actions: **Block** (frozen), **Pending** (fraud review), **Unblock** (active), **Close** (balance must be 0).

### Transactions page

- List all transactions (`GET /portal/me/transactions`). Filter by type (payin, payout, transfer, refund), status, customer.
- Click row → transaction detail.
- "Transfer" button → modal: select customer, amount, reason.
- From payin detail: "Refund" button → modal: select customer wallet (or create), amount, link to payin, reason.

### Token expiry

- Session JWT expires in **7 days**. On `401` from `/portal/me/*`, clear token and redirect to login.
- `mfaToken` from login expires in **~5 minutes**; if verify fails, user must log in again from step 1.

---

## Frontend implementation checklist

| Area | Tasks |
|------|--------|
| **Env** | `API_BASE` / `VITE_API_URL` = Transacty API. **Backend:** `PORTAL_PUBLIC_URL` = SPA origin for reset links. |
| **Auth** | Login; handle `requiresMfa` + MFA verify; logout; forgot/reset routes. |
| **Session** | Attach `Authorization: Bearer` to all `/portal/me/*` requests; handle 401 globally. |
| **Profile** | `GET /portal/me` on app shell load; use `mfaEnabled` / `mfaPendingSetup` for Security UI. |
| **KYC** | Upload flow via Supabase `uploadToSignedUrl` per [File upload](#file-upload-documents). |
| **Ops** | Balance, customers, transactions, transfers, refunds, payouts per sections below. |
| **Cross-border / Tylt** | Full flow: [§ Tylt and cross-border — merchant portal flows](#tylt-and-cross-border--merchant-portal-flows). **`/portal/me/wallets`**, API key **scopes**, **`metadata`** on tx detail, no browser `/v1` secrets. |

For **Postman-only** testing (no UI), see `docs/POSTMAN_PORTAL_TESTING.md`. For **Tylt `/v1`** regression, see `docs/TYLT_MERCHANT_API_TESTING.md`.

---

## File upload (documents)

The backend uses **Supabase Storage** with signed upload URLs:

1. Call `POST /portal/me/kyc/documents/upload-url` with `documentType`, `filename`, optional `contentType`.
2. Receive `{ uploadUrl, uploadToken, path, bucket, fileReference, expiresIn }`.
3. Use Supabase client to upload:

   ```js
   import { createClient } from '@supabase/supabase-js';
   const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
   await supabase.storage.from(bucket).uploadToSignedUrl(path, uploadToken, file, {
     contentType: file.type,
   });
   ```

4. Call `POST /portal/me/kyc/documents` with `fileReference` to register the document.

Allowed types: `application/pdf`, `image/jpeg`, `image/png`, `image/webp`.

---

## Test credentials

After running `npm run db:seed-portal-user`:

- **Email:** merchant@example.com  
- **Password:** password123  

Use for login. This user has `kycStatus: pending`; complete KYC to test API keys.

---

*Last updated: March 2026 — includes MFA, forgot/reset password, profile MFA flags, implementation checklist.*
