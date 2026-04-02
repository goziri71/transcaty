---
title: Transacty Superadmin Dashboard Frontend Spec
---

# Transacty Superadmin Dashboard - Frontend Spec

> Product and API contract spec for building the Transacty internal provider/admin dashboard (`/provider/*`).

## 1) Scope

This dashboard is for **Transacty internal team members** (super admin, ops, risk, finance, support), not merchant users.

Core responsibilities:
- Provider authentication and MFA
- Merchant lifecycle operations (status, KYC, pricing)
- Wallet and transaction supervision
- Maker-checker approvals for high-risk actions
- Reconciliation actions for provider-backed transactions

Out of scope:
- Merchant self-service UI (see `docs/PORTAL_FRONTEND_SPEC.md`)
- Public merchant API client tooling (`/v1/*`)

## 2) Base URLs and Routing

Backend API base:
- `{API_BASE}/provider/...`

Example:
- `https://api.transacty.com/provider/auth/login`

Suggested SPA route map:
- `/login`
- `/mfa/verify`
- `/dashboard`
- `/merchants`
- `/merchants/:merchantId`
- `/customers`
- `/transactions`
- `/approvals`
- `/settings/security` (MFA status/setup/disable)

## 3) Authentication Model

Provider auth supports:
- `Authorization: Bearer <provider_jwt>` (primary for dashboard UI)
- `X-Provider-Key: <PROVIDER_API_KEY>` (service/admin testing mode)

Frontend should use JWT mode for humans.

### Login flow
1. `POST /provider/auth/login` with email/password.
2. If `requiresMfa=true`:
   - Redirect to MFA verify screen
   - submit `mfaToken` + TOTP code to `POST /provider/auth/mfa/verify`
3. Persist JWT securely in memory + secure storage strategy.
4. Call `GET /provider/me` for current context.

### Password reset flow
- `POST /provider/auth/forgot-password`
- User receives email reset link
- Reset page submits to `POST /provider/auth/reset-password`

## 4) Authorization and Role UX

Provider roles:
- `super_admin`
- `ops`
- `risk`
- `finance`
- `support`

UI rules:
- Hide or disable actions user is not allowed to perform.
- Show clear "Insufficient permission" messaging for blocked actions.
- Never rely on UI-only checks; backend permission remains source of truth.

## 5) Main Screens and Contracts

## 5.1 Dashboard Home

Purpose:
- Quick operational summary + shortcuts.

Initial data:
- `GET /provider/me`
- Optional counts from list endpoints with small limits.

Widgets (v1):
- My role / auth method
- Pending approvals count
- Recent transaction issues (failed/reconcile needed)

## 5.2 Merchant List

Endpoint:
- `GET /provider/merchants?limit=&offset=&status=&kycStatus=&q=`

Columns:
- Merchant name
- Status
- KYC status
- Merchant balance
- Created at
- Actions: view details

Filters:
- Status
- KYC status
- Name search

## 5.3 Merchant Detail

Endpoint:
- `GET /provider/merchants/:merchantId`

Show:
- Merchant identity
- Merchant wallet
- KYC profile snapshot
- Persons/documents counts

Actions:
- Change status: `PATCH /provider/merchants/:merchantId/status`
- KYC approve/reject: `PATCH /provider/merchants/:merchantId/kyc`
- Pricing read/update:
  - `GET /provider/merchants/:merchantId/pricing`
  - `PATCH /provider/merchants/:merchantId/pricing`
- Wallet adjustment request:
  - `POST /provider/merchants/:merchantId/wallet-adjustments`

Pricing UX fields:
- `billingMode`: `percentage_only` | `monthly_only` | `both`
- Payin/payout fee percentages
- Min/max fee caps
- Monthly amount

## 5.4 Customer Wallet Supervision

Endpoints:
- `GET /provider/customers`
- `PATCH /provider/customers/:walletId/status`

Use:
- Investigate abuse
- Block/unblock customer wallets

## 5.5 Transactions Monitor

Endpoints:
- `GET /provider/transactions`
- `PATCH /provider/transactions/:transactionId/status`
- `GET /provider/transactions/:transactionId/reconcile`

Use:
- Review transaction history/status
- Request or apply controlled status changes
- Reconcile with provider when needed

## 5.6 Approvals (Maker-Checker)

Endpoints:
- `GET /provider/approvals`
- `POST /provider/approvals/:requestId/approve`
- `POST /provider/approvals/:requestId/reject`

UX rules:
- Show risk level, action type, requested by, reason, and payload summary.
- Require mandatory reason for reject.
- Show immutable audit trail in item details.

## 5.7 Provider User Management

Endpoints:
- `GET /provider/auth/users`
- `POST /provider/auth/users`
- `PATCH /provider/auth/users/:userId`

Use:
- Create/manage internal operator accounts
- Change role/status safely

## 5.8 My Security (MFA)

Endpoints:
- `GET /provider/me/mfa/status`
- `POST /provider/me/mfa/setup`
- `POST /provider/me/mfa/confirm`
- `POST /provider/me/mfa/cancel`
- `POST /provider/me/mfa/disable`

UX:
- Setup with QR + recovery messaging
- Confirm TOTP code
- Disable with strong confirmation

## 6) Data and Error Handling Standards

API response handling:
- Treat unexpected payloads as errors.
- Show user-safe error messages; keep raw details for debug panel/logs.
- Retry only idempotent reads automatically.

Status and form validation:
- Enforce required inputs before submit.
- Validate numeric pricing fields client-side and server-side.
- For high-risk actions, require explicit confirmation modal.

## 7) Security Requirements for Frontend

- Do not expose secrets or provider API key in frontend bundles.
- Prefer HttpOnly cookie strategy if available; if bearer token in storage, harden with strict CSP and short token TTL.
- Auto-logout on token expiry/401.
- Show last login and notify on suspicious access where possible.
- Never bypass backend authorization checks in UI assumptions.

## 8) Audit and Observability UX

- Every destructive/admin action should display request outcome and reference ID.
- Surface approval IDs, transaction IDs, merchant IDs prominently for support workflows.
- Add copy-to-clipboard controls for IDs.

## 9) Environment Variables (Frontend-facing expectations)

Backend must be configured with:
- `PROVIDER_PUBLIC_URL` (used in provider password reset links)
- `APP_BASE_URL` fallback
- `PROVIDER_JWT_SECRET`

Frontend app config:
- `PROVIDER_API_BASE_URL` (points to backend API host)
- Separate env per dev/staging/prod

## 10) Suggested Implementation Order

1. Auth login + MFA verify + logout
2. `/provider/me` bootstrap and role-based route guards
3. Merchant list/detail + status/KYC actions
4. Pricing update UI
5. Transactions + reconcile view
6. Approvals queue (approve/reject)
7. Provider users management
8. MFA settings + password reset screens

## 11) QA Checklist (Release Gate)

- Login works for MFA and non-MFA users
- Unauthorized roles cannot execute restricted actions
- Merchant pricing updates persist and reload correctly
- Wallet adjustment flows create approval requests where required
- Approve/reject flow updates status and UI instantly
- Transaction reconcile path handles provider failures safely
- All critical actions show IDs and clear success/failure feedback

---

For endpoint request/response examples and test payloads, use:
- `docs/POSTMAN_PROVIDER_ADMIN_API_GUIDE.md`
