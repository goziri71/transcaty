# Password reset & email (Transcaty)

## Overview

- **Portal (merchants):** `POST /portal/auth/forgot-password`, `POST /portal/auth/reset-password`
- **Provider (Transcaty admins):** `POST /provider/auth/forgot-password`, `POST /provider/auth/reset-password`

Emails are sent **asynchronously** via **pg-boss** so HTTP handlers stay fast. Workers run in `src/server.ts` next to merchant webhook delivery.

## Environment

| Variable | Purpose |
| --- | --- |
| `EMAIL_FROM` | Required to send mail (e.g. `Transcaty <noreply@yourdomain.com>`) |
| `RESEND_API_KEY` | Use [Resend](https://resend.com) HTTP API (simplest) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Alternative: any SMTP provider |
| `PORTAL_PUBLIC_URL` | Origin of **merchant** SPA for reset links (defaults to `APP_BASE_URL`) |
| `PROVIDER_PUBLIC_URL` | Origin of **provider** SPA for reset links |
| `EMAIL_APP_NAME` | Display name in email subject/body (default: `Transcaty`) |
| `REDIS_URL` | Optional; enables distributed per-IP rate limits for forgot/reset |
| `PASSWORD_RESET_TOKEN_TTL_MINUTES` | Default `60` |
| `PASSWORD_RESET_REQUESTS_PER_IP_PER_HOUR` | Default `5` (forgot-password) |
| `PASSWORD_RESET_ATTEMPTS_PER_IP_PER_HOUR` | Default `30` (reset-password) |

## Database

Run migrations after deploy:

```bash
npm run db:migrate
```

Migration `0007_password_reset_tokens` adds table `password_reset_tokens`.

## Health

`GET /health` includes `redis`: `ok` \| `skipped` \| `error` (`skipped` when `REDIS_URL` is unset).

## Frontend

- Merchant app should implement routes that read `token` from the query string and call `POST /portal/auth/reset-password`.
- Provider app: same for `POST /provider/auth/reset-password`.
