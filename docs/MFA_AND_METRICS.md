# MFA (TOTP) & Prometheus metrics

## MFA

- **Requirement:** `ENCRYPTION_MASTER_KEY` (same as other encrypted secrets) to store TOTP secrets.
- **Portal**
  - Enroll: `POST /portal/me/mfa/setup` → scan QR / add key → `POST /portal/me/mfa/confirm` with `{ "code": "123456" }`.
  - Disable: `POST /portal/me/mfa/disable` with password + current TOTP code.
  - Cancel in-progress setup: `POST /portal/me/mfa/cancel`.
  - **Login:** if MFA is enabled, `POST /portal/auth/login` returns `requiresMfa: true` and `mfaToken` (no session JWT yet). Complete with `POST /portal/auth/mfa/verify` `{ "mfaToken", "code" }` → full login payload with `token`.
- **Provider (JWT only for MFA management)**
  - Same pattern under `/provider/me/mfa/*`.
  - **Login:** `POST /provider/auth/login` may return `requiresMfa: true` + `mfaToken`; complete with `POST /provider/auth/mfa/verify`.

Issuers (shown in authenticator apps): `PORTAL_MFA_ISSUER`, `PROVIDER_MFA_ISSUER` (optional; default from `EMAIL_APP_NAME` or `"Transacty Portal"` / `"Transacty Provider"`).

**DB migration:** `npm run db:migrate` (adds `mfa_*` columns on `merchant_users` and `provider_users`).

## Metrics (APM-style)

- **`GET /metrics`** — Prometheus text format (`transacty_*` metrics + Node.js defaults).
- **Production:** set `METRICS_TOKEN` and send `Authorization: Bearer <METRICS_TOKEN>`. Without `METRICS_TOKEN`, `/metrics` returns **404** when `NODE_ENV=production`.
- **Development:** `/metrics` is open if `METRICS_TOKEN` is unset.
- **HTTP metrics:** `transacty_http_requests_total`, `transacty_http_request_duration_seconds` (labels: `method`, `route`, `status_code`). `/metrics` and `/health` are excluded from these histograms.

## Request IDs

- Fastify generates a request id per request; clients may send **`X-Request-Id`** to correlate logs.
