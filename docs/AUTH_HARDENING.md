# Auth & admin hardening (P4)

Phase 4 of the high-traffic readiness program closes the
authentication and admin-action gaps surfaced in the original
evaluation (C6, C10, O5, O6, H8). It complements
`MONEY_INVARIANTS.md` (P1), `HIGH_TRAFFIC_POSTURE.md` (P2), and
`WEBHOOK_DEDUPE_AND_IDEMPOTENCY.md` (P3).

There are five moving parts, each described below:

1. **`PROVIDER_API_KEY` downgrade.** The shared API key no longer maps
   to `super_admin`, and a context-aware authorization gate hard-denies
   money- and admin-mutating permissions on API-key sessions.
2. **Constant-time login + unified error messages.** The portal and
   provider login endpoints always run a bcrypt compare and always
   return the same generic message on failure, so neither timing nor
   error text leaks user existence or status.
3. **JWT claim hardening.** Tokens now carry `iss`, `aud`, `jti`, `sub`
   and verify under a 30-second clock tolerance. Pre-P4 tokens still
   verify (no forced sign-out at deploy) but new code can rely on the
   strict shape.
4. **JWT revocation list + logout actually revokes.** A small
   `jwt_revocations` table backed by an in-process TTL cache lets the
   logout endpoints kill tokens before their natural expiry.
5. **Step-up MFA on sensitive provider actions.** Wallet adjustments
   and transaction-status writes now require an additional, short-lived
   token bound to the specific action, obtained by re-presenting the
   TOTP code via `POST /provider/auth/step-up`.

Plus an operational change: `render.yaml` now declares a
`healthCheckPath` so deploy cut-over waits for the new instance to be
ready, and the worker-split is sketched for the next phase.

## 1. `PROVIDER_API_KEY` downgrade

`PROVIDER_API_KEY` was originally the bootstrap mechanism for provider
admin access. Pre-P4, an authenticated API-key request was treated as
`super_admin`, bypassing MFA, the maker-checker queue, and the
permission matrix. One leaked key meant unbounded financial damage.

P4 changes this in three layers:

- The role assigned to API-key sessions defaults to **`support`** (a
  read-mostly role). Set `PROVIDER_API_KEY_ROLE=ops|risk|finance` to
  override; **`super_admin` is rejected** even if explicitly requested
  (a boot-time `console.warn` makes that visible).
- An explicit deny list — `API_KEY_DENIED_PERMISSIONS` — is enforced
  by `canProviderActionContext(ctx, permission)`. The deny list
  always blocks `wallet.adjust`, `tx.status.write`,
  `merchant.status.write`, `merchant.kyc.write`,
  `merchant.pricing.write`, `approval.review`, and
  `provider.users.manage` for `authType === "api_key"`, regardless of
  the role mapping.
- The provider auth middleware uses `timingSafeStringEqual` for the
  API-key comparison.

In practice, API-key sessions can read merchant and customer data,
read transactions, ack approvals, and run the bootstrap endpoint, but
they cannot mutate money state. The 403 response on a denied API-key
mutation states *"API-key sessions cannot perform this action; use a
JWT session with MFA"* so operators can self-diagnose.

### Migration notes for operators

If your deployment previously relied on the API key for ad-hoc money
adjustments, switch to a JWT session:

1. Bootstrap a super_admin via `POST /provider/auth/bootstrap` (still
   gated by API key) if one doesn't already exist.
2. Login as that super_admin (`POST /provider/auth/login`).
3. Use the JWT for `wallet.adjust` and similar; obtain a step-up token
   first (see §5).

## 2. Constant-time login + unified error messages

`api/portal/auth.ts` and `api/provider/auth.ts` previously branched
between *"user not found"*, *"account suspended"*, *"account has no
password"*, and *"wrong password"* — both as distinct messages and as
distinct timing (the bcrypt compare was skipped on the first three).

P4 routes both endpoints through `verifyPasswordOrDummy(password,
hash | null)` from `src/lib/login-timing.ts`, which:

- Always runs a bcrypt compare. When `hash` is missing/empty/malformed,
  it compares against a precomputed dummy hash so the wall-clock cost
  is uniform.
- Returns false on any failure (no throws on bad hashes).

The handler then maps every non-MFA failure to the constant
`UNIFIED_LOGIN_FAILURE = "Invalid email or password"`. The actual
reason still goes to the audit log (`audit({ action: "auth.failed",
meta: { reason: ... } })`) so operators can debug without exposing
the signal to clients.

### Audit log reasons

| `reason` value     | When                                            |
| ------------------ | ----------------------------------------------- |
| `no_user`          | The email did not match any user                |
| `suspended`        | The user exists but `status !== "active"`       |
| `no_password`      | The user has no `password_hash` (SSO-only?)     |
| `wrong_password`   | bcrypt compare returned false                   |

(`no_password` is portal-only — provider users always have passwords.)

## 3. JWT claim hardening

| Claim     | Portal value                       | Provider value                      |
| --------- | ---------------------------------- | ----------------------------------- |
| `iss`     | `transacty.portal`                 | `transacty.provider`                |
| `aud`     | `transacty.portal.session`         | `transacty.provider.session`        |
| `sub`     | `merchantUserId`                   | `providerUserId`                    |
| `jti`     | `randomUUID()` per sign            | `randomUUID()` per sign             |
| `exp`     | `iat + 7d`                         | `iat + 12h`                         |

Verification enforces the `iss`/`aud` pair when the token carries
them, applies a 30-second clock tolerance, and rejects tokens whose
`aud` is one of the special-purpose audiences:

- `transacty.{portal,provider}.mfa_pending` — short-lived token issued
  after password OK; only valid for the corresponding `mfa/verify`
  endpoint.
- `transacty.provider.step_up` — short-lived step-up token (see §5);
  cannot be used as a session token.

### Backward compatibility

Tokens issued before P4 (no `iss`/`aud`/`jti`) are accepted by
`verifyPortalToken` and `verifyProviderToken` so a deploy doesn't
force a global sign-out. They cannot be revoked, but they will still
expire on schedule. Once the legacy window closes, you can flip
strict mode on by removing the fallback `decodeAndValidate(token)`
call inside the verify helpers.

## 4. JWT revocation list

`drizzle/0019_jwt_revocations.sql` introduces:

```sql
CREATE TABLE jwt_revocations (
  jti        text PRIMARY KEY,
  realm      text NOT NULL,           -- 'portal' | 'provider'
  subject_id uuid,
  reason     text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now()
);
```

`src/lib/jwt-revocation.ts` exposes:

- `isJtiRevoked(realm, jti) → Promise<boolean>` — used by both verify
  helpers. Backed by an in-process TTL cache (negative TTL 5s,
  positive TTL 60s) so the hot path runs from memory.
- `revokeJti({ realm, jti, expiresAt, subjectId, reason })` — used by
  the logout endpoints. Idempotent (`ON CONFLICT DO NOTHING`).
- `cleanupExpiredRevocations()` — drops rows whose `expires_at` has
  already passed; safe to wire into a periodic worker.
- `__setJwtRevocationLookupForTesting(fn)` — test seam; the production
  code never calls this.

| Env var                                | Default | Effect                                  |
| -------------------------------------- | ------: | --------------------------------------- |
| `JWT_REVOCATION_POSITIVE_TTL_MS`       | `60000` | How long a "revoked" answer is cached   |
| `JWT_REVOCATION_NEGATIVE_TTL_MS`       |  `5000` | How long a "not revoked" answer is cached |
| `JWT_REVOCATION_CACHE_MAX`             |  `5000` | Max cache entries                       |

### Logout endpoints

`POST /portal/auth/logout` and `POST /provider/auth/logout` accept the
same `Authorization: Bearer <token>` (or `X-Portal-Token`,
`X-Provider-Token`) the rest of the API does, decode the embedded
`jti`, and call `revokeJti`. Calls without a token still succeed
(idempotent). Audit log records `portal.session.logout` /
`provider.session.logout` with the revoked `jti`.

Eventual consistency: a logout on instance A propagates to instance B
within `JWT_REVOCATION_NEGATIVE_TTL_MS` (default 5 seconds). For
tighter guarantees you can broadcast revocations via Redis pub/sub —
left out of P4 to keep the change-set small.

## 5. Step-up MFA on sensitive provider actions

Provider routes that mutate money state now require a fresh
**step-up** confirmation in addition to the active session. The flow:

1. Operator obtains the step-up token by POSTing their current TOTP
   code to `/provider/auth/step-up`:

   ```http
   POST /provider/auth/step-up
   Authorization: Bearer <provider session JWT>
   Content-Type: application/json

   { "code": "123456", "action": "wallet.adjust" }
   ```

   Response:

   ```json
   {
     "token": "<step-up JWT, 5 minute TTL>",
     "tokenType": "Bearer",
     "expiresIn": "5m",
     "action": "wallet.adjust"
   }
   ```

2. Operator presents the step-up token alongside the action request:

   ```http
   POST /provider/customers/<walletId>/wallet-adjustments
   Authorization: Bearer <provider session JWT>
   X-Provider-Step-Up: <step-up JWT>
   Content-Type: application/json

   { "direction": "credit", "amount": "1000.00", "reason": "ops fix", "referenceId": "T-12345" }
   ```

3. The route's `requireProviderStepUp(action)` middleware verifies the
   header token: it must be issued by us (`iss`,`aud` match), bound to
   the same `action` (or `"any"`), and not expired. If absent or
   invalid, the route returns 403 with `stepUpRequired: true` and the
   client knows to show the MFA prompt.

### Wired routes

| Route                                                       | Action               |
| ----------------------------------------------------------- | -------------------- |
| `POST /provider/customers/:walletId/wallet-adjustments`     | `wallet.adjust`      |
| `POST /provider/merchants/:merchantId/wallet-adjustments`   | `wallet.adjust`      |
| `PATCH /provider/transactions/:transactionId/status`         | `tx.status.write`    |

KYC overrides (`merchant.kyc.write`) intentionally still go through
the maker-checker queue rather than step-up; bringing them under
step-up too is a follow-up.

### Bypasses (and why)

`requireProviderStepUp` returns true (i.e. allows the request through)
in two specific cases:

- The actor authenticated via API key. Money mutations from API keys
  are already blocked by `canProviderActionContext`; if we reach
  `requireProviderStepUp` for a non-mutating action, no step-up is
  needed.
- The actor has not enrolled MFA. `request.provider.stepUpVerified`
  is set to `false` and an audit entry tags the action so ops can
  drive enrollment. The eventual P5 work is to make MFA mandatory for
  provider users — at that point, this bypass goes away.

### Schema additions

Step-up tokens reuse the same JWT secret as the session/MFA-pending
tokens; no new tables are required.

## 6. `render.yaml` health check + scaling

`healthCheckPath: /health` makes Render's load balancer wait for a
green response before cutting traffic to a freshly-deployed
instance. `/health` already pings Postgres and Redis (see `app.ts`).

`numInstances: 1` is left at the default to avoid an unintended bill
bump; bump it once the underlying plan supports horizontal scaling.
Sticky sessions are NOT required because rate-limit and
circuit-breaker state both live in Redis (P2).

The pg-boss worker split (a separate Render service that runs only
the queue consumers) is sketched as a comment block in
`render.yaml`. The split is a P5 change; pg-boss workers currently
run in-process inside the web service.

## Validation

```bash
# Pure-function tests (no DB needed):
npm run test:unit

# DB-backed tests (idempotency, webhook events, ledger immutability,
# transactions(provider, ...) uniqueness):
npm run test:integration
```

The relevant unit suites added in P4 are:

- `tests/lib/login-timing.test.ts` — bcrypt-or-dummy compare, unified
  failure message.
- `tests/lib/jwt-claims.test.ts` — `iss`/`aud`/`jti`/clockTolerance,
  revocation, step-up audience separation.
- `tests/lib/provider-auth-context.test.ts` — API-key downgrade and
  the deny-list gate.

## What's NOT in P4 (deferred)

- **Refresh tokens.** The natural pairing with a revocation list is
  short access tokens + opaque refresh tokens stored hashed in DB.
  Implementing this requires UI/SDK changes (the SPA needs to know to
  call `/refresh` on 401), which is its own track of work.
- **Mandatory MFA enrollment for provider users.** P4 only enforces
  step-up *when* MFA is enrolled. Making it mandatory is a one-line
  flip in `requireProviderStepUp` once enrollment hits 100%.
- **MFA backup codes.** Currently MFA enrollment has no backup codes;
  account-recovery is via password reset only.
- **Worker process split.** `render.yaml` documents the future state
  but pg-boss still runs in-process today.
