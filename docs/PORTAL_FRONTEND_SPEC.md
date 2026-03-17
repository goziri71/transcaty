# Merchant Portal – Frontend Spec

> API contract and UX flow for the Transcaty merchant dashboard. Use this to build the portal UI.

---

## Overview

Merchants sign up with minimal info, log in, complete activation (KYC), then manage API keys. Two auth systems:

| Context | Auth | Use |
|--------|------|-----|
| **Portal** | JWT (Bearer token) | Dashboard UI – signup, login, profile, KYC, API keys |
| **API** | HMAC (API key + secret) | Programmatic – payins, payouts, balance (not covered here) |

---

## Base URL

```
{API_BASE}/portal/...
```

Example: `https://api.transcaty.com/portal/auth/login`

---

## Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────────┐     ┌─────────────────────────────────┐
│   Signup    │────▶│    Login     │────▶│ Activation      │────▶│  Operations (world-class)        │
│ (minimal)   │     │ (email+pwd)  │     │ (KYC modal)     │     │  • API Keys  • Balance          │
└─────────────┘     └─────────────┘     └─────────────────┘     │  • Customers • Transactions      │
       │                    │                     │             │  • Transfers • Refunds           │
       │                    │                     │             │  • Block/pending customer wallet │
       ▼                    ▼                     ▼             └─────────────────────────────────┘
  businessName         JWT token           business, persons,
  email                needsActivation     documents, submit
  password
```

1. **Signup** – Business name, email, password. Returns JWT + `needsActivation: true`.
2. **Login** – Email + password. Returns JWT + `needsActivation`.
3. **Activation** – If `needsActivation`, show modal/wizard: business profile → persons → documents → submit.
4. **Operations** – Balance, customers, transactions, transfers, refunds, block/pending customer wallets.

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

- Store JWT in `localStorage` or `sessionStorage`.
- Include in all requests to `/portal/me/*` and `/portal/me/kyc/*`, `/portal/me/api-keys/*`.

### Logout

- Call `POST /portal/auth/logout` (optional).
- Clear stored token and redirect to login.

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
  "needsActivation": true
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

**Success (200)**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "merchantId": "uuid",
  "email": "admin@acme.com",
  "needsActivation": true
}
```

**Error (401)**

```json
{
  "error": "Unauthorized",
  "message": "Invalid email or password"
}
```

---

### 3. Logout

**POST** `/portal/auth/logout`

No body. Returns `{ "ok": true }`. Client clears token.

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
  "documentsCount": 0
}
```

| Field | Description |
|-------|-------------|
| kycStatus | `pending` \| `verified` \| `rejected` |
| needsActivation | Show activation modal when `true` |
| canCreateApiKeys | `true` only when `kycStatus === 'verified'` |
| businessProfile | `null` until business profile is created |

---

### 5. Get balance

**GET** `/portal/me/balance`

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

### 10. KYC – Add document

**POST** `/portal/me/kyc/documents`

**Body**

```json
{
  "documentType": "registration_certificate",
  "fileReference": "s3://bucket/path/to/file.pdf",
  "documentNumber": "DOC-123",
  "merchantPersonId": "uuid"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| documentType | yes | e.g. registration_certificate, trade_license, nid, passport |
| fileReference | yes | Storage reference (upload flow TBD) |
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

### 11. KYC – Submit

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
  "apiKey": "transcaty_abc123...",
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
      "createdAt": "2025-03-09T12:00:00.000Z",
      "completedAt": "2025-03-09T12:01:00.000Z"
    }
  ],
  "total": 50,
  "limit": 20,
  "offset": 0
}
```

---

### 22. Transactions – Get

**GET** `/portal/me/transactions/:id`

**Success (200)** Returns full transaction detail including metadata.

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

## UX recommendations

### Signup page

- Fields: business name, email, password (with confirmation).
- On success: store token, redirect to dashboard. Check `needsActivation` to show modal.

### Login page

- Fields: email, password.
- On success: store token, redirect to dashboard. Check `needsActivation` to show modal.

### Dashboard layout

- Header: business name, email, balance, logout.
- Sidebar or tabs: Overview, Balance, Transactions, Customers, KYC, API Keys.
- On load: `GET /portal/me`, `GET /portal/me/balance`. If `needsActivation`, show activation modal (or redirect to activation wizard).

### Activation flow (modal or wizard)

1. **Business** – Form for `PUT /portal/me/kyc/business`.
2. **Persons** – Add directors/UBOs via `POST /portal/me/kyc/persons`. Show list from `GET /portal/me/kyc/persons`.
3. **Documents** – Add docs via `POST /portal/me/kyc/documents`. `fileReference` – upload flow TBD (e.g. presigned URL, direct upload).
4. **Submit** – `POST /portal/me/kyc/submit`. Show "Pending verification" state.

### API Keys page

- Show only when `canCreateApiKeys === true`.
- List keys with masked display. "Create key" button → modal with copy for key + secret.
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

- JWT expires in 7 days. On 401, clear token and redirect to login.

---

## File upload (documents)

`fileReference` is a string. The backend does not handle file upload. Options:

1. **Presigned URL** – Backend provides a presigned S3/Storage URL; frontend uploads, then sends the resulting path as `fileReference`.
2. **Base64** – Frontend encodes file, sends in body; backend stores and returns reference. (Requires backend support.)
3. **External storage** – Frontend uploads to your storage, passes URL/path as `fileReference`.

Confirm with backend which approach is implemented.

---

## Test credentials

After running `npm run db:seed-portal-user`:

- **Email:** merchant@example.com  
- **Password:** password123  

Use for login. This user has `kycStatus: pending`; complete KYC to test API keys.

---

*Last updated: March 2025*
