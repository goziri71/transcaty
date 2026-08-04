# Frontend API Contract — Security Update (July 2026)

Implementation guide for **merchant portal** and **provider admin** SPAs after the portal/provider security hardening pass.

**Auth for both apps:** `Authorization: Bearer <session JWT>`

**Related docs:** [AUTH_HARDENING.md](./AUTH_HARDENING.md) (provider step-up baseline), [FRONTEND_HANDOFF_JUNE_2026.md](./FRONTEND_HANDOFF_JUNE_2026.md), [PORTAL_FRONTEND_SPEC.md](./PORTAL_FRONTEND_SPEC.md).

**Backend ops:** run `npm run db:migrate` (includes `merchant_users.session_version`). Optional env:

| Env | Effect |
|-----|--------|
| `PORTAL_MFA_REQUIRED=true` | Block `/portal/me/*` until MFA enrolled (except MFA setup + `GET /portal/me`) |
| `PORTAL_JWT_EXPIRES_IN` | Session TTL (default `12h`) |
| `ALLOW_HTTP_WEBHOOKS=true` | Dev only; ignored in production |

---

## Quick map

| Feature | App | What to send |
|---------|-----|----------------|
| Step-up | Merchant | `POST /portal/auth/step-up` → header `X-Portal-Step-Up` |
| Step-up | Admin | `POST /provider/auth/step-up` → header `X-Provider-Step-Up` |
| Idempotency | Merchant only | header `Idempotency-Key` on money creates |
| Roles | Merchant only | gate UI by `admin` / `finance` / `viewer` |
| Live key revoke | Merchant only | confirm on live API key create |
| HTTPS webhook | Merchant only | body `webhookUrl` must be `https://` |
| Revoke sessions | Merchant only | `POST /portal/auth/revoke-sessions` |
| Pricing step-up | Admin only | add step-up to legacy pricing `PATCH` |
| Wallet adjust body | Admin only | `direction`, string `amount`, `referenceId` |

---

# A) Merchant dashboard (`/portal/*`)

## A1. Login / signup — new fields

### `POST /portal/auth/login`

**Body**

```json
{
  "email": "user@merchant.com",
  "password": "SecretPass1"
}
```

**Response 200 (no MFA enrolled)**

```json
{
  "token": "<jwt>",
  "merchantId": "uuid",
  "merchantSlug": "acme",
  "email": "user@merchant.com",
  "role": "admin",
  "needsActivation": false,
  "mfaEnabled": false,
  "mfaSetupRequired": true,
  "merchant": {
    "id": "uuid",
    "slug": "acme",
    "businessName": "Acme",
    "name": "Acme",
    "status": "active",
    "kycStatus": "verified"
  }
}
```

- `mfaSetupRequired: true` only when server has `PORTAL_MFA_REQUIRED=true` and user has no MFA.
- If true → send user to MFA setup before money/settings.

**Response 200 (MFA enrolled — password step only)**

```json
{
  "requiresMfa": true,
  "mfaToken": "<short-lived-token>",
  "merchantId": "uuid",
  "merchantSlug": "acme",
  "email": "user@merchant.com"
}
```

Then call MFA verify as today with `mfaToken` + TOTP `code`.

**Roles from login:** `"admin"` | `"finance"` | `"viewer"`

Signup (`POST /portal/auth/signup`) may also return `mfaSetupRequired` when the policy is on.

---

## A2. Step-up MFA (new)

Use when the user has MFA **enabled**, before sensitive mutations.

### `POST /portal/auth/step-up`

**Headers**

```http
Authorization: Bearer <portal session jwt>
```

**Body**

```json
{
  "code": "123456",
  "action": "money.write"
}
```

**`action` values**

| Action | Use for |
|--------|---------|
| `money.write` | Payins / payouts / transfers / refunds |
| `api_keys.write` | Create / revoke API keys |
| `webhook.write` | Save webhook URL |
| `any` | Works for all of the above |

**Response 200**

```json
{
  "token": "<step-up-jwt>",
  "tokenType": "Bearer",
  "expiresIn": "5m",
  "action": "money.write"
}
```

**Error 403 (MFA not enrolled)**

```json
{
  "error": "Forbidden",
  "message": "MFA must be enrolled to perform this action"
}
```

**Error 401 (bad code)**

```json
{
  "error": "Unauthorized",
  "message": "Invalid authenticator code"
}
```

Send that token on the real request:

```http
X-Portal-Step-Up: <step-up-jwt>
```

**If step-up missing (MFA on)**

```json
{
  "error": "Forbidden",
  "message": "Step-up MFA required",
  "stepUpRequired": true,
  "action": "money.write"
}
```

If MFA is **off**, skip step-up (no header needed).

---

## A3. Revoke all sessions (new)

### `POST /portal/auth/revoke-sessions`

**Headers**

```http
Authorization: Bearer <portal session jwt>
```

**Body**

```json
{
  "password": "SecretPass1"
}
```

**Response 200**

```json
{
  "ok": true,
  "sessionVersion": 1
}
```

After this: clear local token and force login (current JWT is invalid).

**Error 401**

```json
{
  "error": "Unauthorized",
  "message": "Invalid password"
}
```

Password reset also bumps `sessionVersion` (all existing sessions die).

Default session TTL is **12h** (`PORTAL_JWT_EXPIRES_IN`). Handle **401** → re-login.

---

## A4. Money mutations — required headers + role

**Who:** `role` must be `admin` or `finance` (`viewer` → 403).

**Every money create must send:**

```http
Authorization: Bearer <jwt>
Idempotency-Key: <unique-uuid>
X-Portal-Step-Up: <step-up-jwt>
```

(`X-Portal-Step-Up` only if MFA is enabled.)

**Applies to** (same bodies as before; headers/role change):

- `POST /portal/me/payins`
- `POST /portal/me/payouts`
- `POST /portal/me/transfers`
- `POST /portal/me/refunds`
- Brazil portal money routes (`/portal/me/br/...`)
- `POST /portal/me/eur/payout-instances`
- `POST /portal/me/cpg/payout-requests`
- EUR approve also needs role + step-up (idempotency not required on approve)

**Error 400 (missing idempotency)**

```json
{
  "error": "Bad Request",
  "message": "Idempotency-Key header is required"
}
```

**Error 403 (viewer)**

```json
{
  "error": "Forbidden",
  "message": "Finance or admin role required for money operations"
}
```

**Error 409 (idempotency conflict)**

```json
{
  "error": "Idempotency conflict",
  "message": "Idempotency-Key was already used with a different request body",
  "reason": "body_mismatch"
}
```

Same key + same body → cached replay. Same key + different body → 409.

---

## A5. API keys — admin only + step-up

### `POST /portal/me/api-keys`

**Headers**

```http
Authorization: Bearer <jwt>
X-Portal-Step-Up: <step-up with action api_keys.write or any>
```

**Body**

```json
{
  "environment": "live",
  "scopes": ["payin:create", "payout:create", "balance:read"]
}
```

- `environment`: `"test"` | `"live"` (default `"test"`)
- `scopes`: optional array; omit = full default scopes  
  Allowed: `*`, `payin:create`, `payout:create`, `balance:read`, `wallets:create`, `wallets:read`, `transfer:create`, `internal_transfer:create`, `tylt:internal_transfer`

**Response 201**

```json
{
  "id": "uuid",
  "apiKey": "transacty_...",
  "secret": "...",
  "environment": "live",
  "scopes": "payin:create,payout:create,balance:read",
  "message": "Save the secret securely. It will not be shown again. Any previous live API key was revoked."
}
```

Creating **live** revokes any previous active live key — show a confirm dialog in the UI.

### `DELETE /portal/me/api-keys/:keyId`

Same headers (admin + step-up).

**Response 200**

```json
{ "ok": true }
```

**Error 403 (not admin)**

```json
{
  "error": "Forbidden",
  "message": "Admin role required"
}
```

---

## A6. Webhook — admin only + HTTPS + step-up

### `PATCH /portal/me/webhook`

**Headers**

```http
Authorization: Bearer <jwt>
X-Portal-Step-Up: <step-up with action webhook.write or any>
```

**Body**

```json
{
  "webhookUrl": "https://merchant.example.com/hooks/transacty"
}
```

- Clear webhook: `"webhookUrl": null` or `""`
- Must be `https://` (not `http://`)

**Response 200**

```json
{
  "webhookUrl": "https://merchant.example.com/hooks/transacty",
  "webhookSecret": "hex-secret-shown-once"
}
```

**Error 400**

```json
{
  "error": "Bad Request",
  "message": "Webhook URL must use HTTPS"
}
```

Merchant outbound webhook verification (merchant server side): header `X-Transacty-Webhook-Signature` = HMAC-SHA256(raw body, `webhookSecret`) hex. That secret is **not** used to call Transacty APIs.

---

## A7. MFA policy block (if enabled on server)

When `PORTAL_MFA_REQUIRED=true`, any `/portal/me/*` except MFA setup routes and `GET /portal/me`:

**403**

```json
{
  "error": "Forbidden",
  "message": "MFA enrollment required",
  "mfaSetupRequired": true
}
```

→ redirect to MFA setup UI.

---

## A8. Password strength (portal signup / reset)

Passwords must be at least **10** characters and include a **letter** and a **number**. Common denylisted passwords are rejected. Surface this in form validation copy.

---

# B) Admin dashboard (`/provider/*`)

Almost unchanged. Ensure step-up is used wherever the backend requires it.

## B1. Step-up (existing — keep using)

### `POST /provider/auth/step-up`

**Headers**

```http
Authorization: Bearer <provider jwt>
```

**Body**

```json
{
  "code": "123456",
  "action": "merchant.pricing.write"
}
```

**Useful `action` values**

| Action | Use for |
|--------|---------|
| `wallet.adjust` | Wallet adjustments |
| `merchant.pricing.write` | Legacy pricing `PATCH` **and** fee-schedules |
| `merchant.rates.write` | FX / rates |
| `merchant.ip_whitelist.write` | IP allowlist |
| `tx.status.write` | Manual tx status |
| `merchant.kyc.write` | KYC writes |
| `any` | Broad short-lived token |

**Response 200**

```json
{
  "token": "<step-up-jwt>",
  "tokenType": "Bearer",
  "expiresIn": "5m",
  "action": "merchant.pricing.write"
}
```

Send on sensitive calls:

```http
X-Provider-Step-Up: <step-up-jwt>
```

**If missing (MFA on)**

```json
{
  "error": "Forbidden",
  "message": "Step-up MFA required",
  "stepUpRequired": true
}
```

Provider **API keys** cannot mutate money (`wallet.adjust`, etc.) — use a JWT session. Step-up is skipped when MFA is not enrolled (same pattern as portal).

---

## B2. Legacy merchant pricing (step-up required)

### `PATCH /provider/merchants/:merchantId/pricing`

**Headers**

```http
Authorization: Bearer <provider jwt>
X-Provider-Step-Up: <step-up with merchant.pricing.write or any>
```

**Body** (any subset)

```json
{
  "billingMode": "percentage_only",
  "feePercentagePayin": "2.5",
  "feePercentagePayout": "1.5",
  "feeMinPayin": "0",
  "feeMaxPayin": null,
  "feeMinPayout": "0",
  "feeMaxPayout": null,
  "monthlyAmount": null
}
```

**Response 200**

```json
{
  "id": "uuid",
  "billingMode": "percentage_only"
}
```

Wire this the same way as fee-schedules step-up.

---

## B3. Wallet adjust — request body contract

### `POST /provider/merchants/:merchantId/wallet-adjustments`

**Headers**

```http
Authorization: Bearer <provider jwt>
X-Provider-Step-Up: <step-up with wallet.adjust or any>
```

**Body**

```json
{
  "environment": "live",
  "direction": "credit",
  "amount": "100.00",
  "reason": "Manual correction",
  "referenceId": "adj-2026-001"
}
```

| Field | Rules |
|-------|--------|
| `direction` | `"credit"` \| `"debit"` (required) |
| `amount` | **string**, not number |
| `referenceId` | required, unique-ish string |
| `reason` | required |
| `environment` | `"test"` \| `"live"` (default `"live"`) |

**Response 200 (applied)**

```json
{
  "merchantId": "uuid",
  "walletId": "uuid",
  "direction": "credit",
  "amount": "100.00",
  "previousBalance": "50.00",
  "currentBalance": "150.00"
}
```

**Response 202 (needs approval)**

```json
{
  "requestId": "uuid",
  "status": "pending",
  "requiresApproval": true
}
```

Customer wallet adjust (`POST /provider/customers/:walletId/wallet-adjustments`) uses the same shape (no `environment`) and also needs `X-Provider-Step-Up`.

**Frontend bug to avoid:** do not send `{ "amount": 122, "currency": "BDT", "reason": "…" }` — backend will 400 for missing `direction` / `referenceId` and wrong `amount` type.

---

## Implementation checklist

### Merchant portal

- [ ] Handle `mfaSetupRequired` / `mfaEnabled` on login/signup
- [ ] Step-up modal → `X-Portal-Step-Up` on money, API keys, webhooks
- [ ] Always send `Idempotency-Key` on money creates
- [ ] Hide/disable money for `viewer`; credentials for non-`admin`
- [ ] HTTPS-only webhook URL validation in UI
- [ ] Confirm dialog when creating a **live** API key
- [ ] Optional: revoke-all-sessions settings action
- [ ] Password rules copy (10+, letter + number)
- [ ] Re-login on 401 / after revoke-sessions

### Provider admin

- [ ] Step-up on legacy pricing `PATCH` (same as fee-schedules)
- [ ] Wallet adjust payload: `direction`, string `amount`, `referenceId`
- [ ] Keep existing step-up on wallet adjust / other sensitive writes
