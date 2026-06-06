# Security hardening (priority order)

Operational and code changes to reduce SQL injection, webhook abuse, and credential blast radius. Complements `AUTH_HARDENING.md` (auth/JWT) and Drizzle’s parameterized queries.

## 1. Database least privilege (ops)

**Goal:** The API runtime should not own the database or run DDL.

1. Run migrations with the **owner** connection (Render default `DATABASE_URL` during `db:migrate`).
2. Create a dedicated app role: `scripts/create-app-db-role.sql` (replace password first).
3. Point **production API + worker** `DATABASE_URL` at `transacty_app`, not the owner user.
4. Keep owner credentials only in CI/migration jobs and break-glass admin.

**Render:** Add a second env group or secret for `DATABASE_URL_MIGRATE` (owner) vs `DATABASE_URL` (app role). Run `npm run db:migrate` in a one-off job or pre-deploy hook with the migrate URL.

**Rollback:** Revert `DATABASE_URL` to owner if the app role is misconfigured; fix grants and retry.

## 2. Webhook and auth rate limits

Per-route limits (in addition to global `RATE_LIMIT_MAX`):

| Route prefix / path | Env | Default |
|---------------------|-----|---------|
| `/webhooks/*` | `WEBHOOK_RATE_LIMIT_MAX`, `WEBHOOK_RATE_LIMIT_WINDOW` | 120 / 1 minute |
| Portal/provider login, signup, MFA, forgot-password | `AUTH_LOGIN_RATE_LIMIT_MAX`, `AUTH_LOGIN_RATE_LIMIT_WINDOW` | 10 / 15 minutes |

Uses the same Redis store as global rate limit when `REDIS_URL` is set.

**Webhook debug body (production):** `PAYOK_WEBHOOK_DEBUG_BODY` and `TYLT_WEBHOOK_DEBUG_BODY` are **ignored** when `NODE_ENV=production`. Use only in staging/local; remove after debugging.

Structured security logs (`securityEvent` JSON field):

- `webhook.signature_rejected`
- `rate_limit.exceeded`

## 3. CI: SQL safety check

```bash
npm run security:sql
```

Scans `src/`, `api/`, `services/`, `scripts/` for `sql.raw`, string-built `.execute()`, and obvious non-Drizzle template SQL. Fails the build on hits.

**Rule for contributors:** User-controlled values go through Drizzle `eq` / `ilike` / `sql` tagged templates — never into `` db.execute(`...${user}...`) ``.

Provider merchant search sanitizes `%` and `_` in free-text `q` (`sanitizeIlikeSearchQuery`).

## 4. Dependency scanning

```bash
npm run security:audit   # npm audit --audit-level=high
npm run security:check   # sql check + audit
```

GitHub Dependabot (`.github/dependabot.yml`) opens weekly npm update PRs. Review and merge high/critical advisories promptly.

CI runs `npm audit --audit-level=high` as an **advisory** step (`continue-on-error`) until `drizzle-orm` can be upgraded to ≥0.45.2 (breaking change with `drizzle-kit`). Run `npm run security:check` locally before releases.

## 5. WAF / penetration test (ops, not in repo)

- Put Cloudflare (or provider WAF) in front of public API hostnames.
- Schedule annual or pre-launch pen test on `/webhooks/*`, auth, and merchant API keys.

## Checklist before production deploy

- [ ] `DATABASE_URL` uses `transacty_app` (not owner)
- [ ] `TYLT_WEBHOOK_DEBUG_BODY` and `PAYOK_WEBHOOK_DEBUG_BODY` unset in prod
- [ ] `REDIS_URL` set for distributed rate limits
- [ ] CI runs `npm run security:check` on every PR
