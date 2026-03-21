# Merchant Portal – Postman Testing Guide (Dashboard)

> Test **`/portal/*`** (merchant staff login, MFA, password reset, profile). **Not** the Merchant API (`/v1/*`).

---

## Scope

| API | Doc |
| --- | --- |
| **Merchant API** `/v1/*` (HMAC) | `POSTMAN_MERCHANT_API_GUIDE.md` — **unchanged** by portal flows |
| **Portal** `/portal/*` | **this document** |
| **Provider admin** `/provider/*` | `POSTMAN_PROVIDER_ADMIN_API_GUIDE.md` |

---

## Postman environment

| Variable | Example |
| --- | --- |
| `baseUrl` | `https://api.yourdomain.com` |
| `portalToken` | (empty until login) |

Default header for protected routes:

- `Authorization: Bearer {{portalToken}}`

Public routes (no auth): signup, login, forgot/reset password, MFA verify.

---

## 1. Signup (optional)

POST `{{baseUrl}}/portal/auth/signup`

```json
{
  "businessName": "Test Merchant",
  "email": "admin@example.com",
  "password": "SecurePass123!"
}
```

Save `token` → `portalToken` if you want to continue immediately.

---

## 2. Login (with optional MFA)

POST `{{baseUrl}}/portal/auth/login`

```json
{
  "email": "admin@example.com",
  "password": "SecurePass123!"
}
```

### 2a. MFA not enabled

Response includes `token` → save as **`portalToken`**.

### 2b. MFA enabled

Response includes `requiresMfa: true` and `mfaToken` (no session JWT yet).

POST `{{baseUrl}}/portal/auth/mfa/verify`

```json
{
  "mfaToken": "<paste from login>",
  "code": "123456"
}
```

Success response includes `token` → **`portalToken`**.

---

## 3. Profile (with MFA flags)

GET `{{baseUrl}}/portal/me`

Headers: `Authorization: Bearer {{portalToken}}`

Response includes `mfaEnabled`, `mfaPendingSetup` (among other profile fields).

---

## 4. MFA enrollment (optional)

Requires **`ENCRYPTION_MASTER_KEY`** on the server.

| Step | Method | Path | Body |
| --- | --- | --- | --- |
| Status | GET | `/portal/me/mfa/status` | — |
| Start | POST | `/portal/me/mfa/setup` | — |
| Confirm | POST | `/portal/me/mfa/confirm` | `{ "code": "123456" }` |
| Cancel | POST | `/portal/me/mfa/cancel` | — |
| Disable | POST | `/portal/me/mfa/disable` | `{ "password": "...", "code": "123456" }` |

`POST /portal/me/mfa/setup` returns `otpauthUrl` — scan in an authenticator app.

Issuer label: `PORTAL_MFA_ISSUER` (optional; see `docs/MFA_AND_METRICS.md`).

---

## 5. Forgot / reset password

### Forgot

POST `{{baseUrl}}/portal/auth/forgot-password`

```json
{
  "email": "admin@example.com"
}
```

Generic success message (always). Email must be configured (`EMAIL_FROM` + Resend or SMTP).

### Reset

POST `{{baseUrl}}/portal/auth/reset-password`

```json
{
  "token": "<from email link query string>",
  "password": "NewSecurePass123!"
}
```

---

## 6. Does this affect the Merchant API?

**No.** Integrations using **`/v1/*`** with HMAC signing are **not** affected by portal login, MFA, or password reset. Those are separate routes and credentials.
