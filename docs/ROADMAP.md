# Transacty Roadmap

> Real money flows. Merchants build fintechs. Customers under merchants. Do it right.

---

## Architecture

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for separation plan: Bangladesh isolated, folder structure, and migration checklist. Never touch Bangladesh when adding other countries.

---

## Phase 0: Payok verified ✓

**Gate:** Payok API returns 200 before we proceed.

- [ ] Receive Payok credentials (merchantId, keys, base URL)
- [ ] Implement signature util (sign requests, verify callbacks)
- [ ] Call one Payok endpoint (e.g. balance inquiry) – confirm 200
- [ ] Document base URL, env vars, test flow

---

## Phase 1: Foundation ✓

### 1.1 Database schema

- [x] `merchants` – id, name, status, kyc_status, created_at
- [x] `merchant_api_keys` – merchant_id, key_hash, secret_enc, scopes, status
- [x] `wallets` – merchant_id, type (merchant|customer), parent_id (for customer), balance, currency, status
- [x] `ledger_entries` – wallet_id, amount, direction, type, reference_id, created_at
- [x] `transactions` – id, merchant_id, type (payin|payout|transfer), status, amount, currency, external_id (Payok), metadata
- [x] `idempotency_keys` – key, merchant_id, response_snapshot, expires_at

### 1.2 Merchant authentication

- [x] API key + secret model (live/test)
- [x] HMAC request signing (X-Transacty-Key, X-Transacty-Signature, X-Transacty-Timestamp)
- [x] Replay protection (±5 min timestamp)
- [x] Scope-based authorization (payin:create, payout:create, etc.)

---

## Phase 2: Payok flows ✓

### 2.1 Payok client

- [x] Sign all outbound requests
- [x] Verify all inbound callbacks
- [ ] Retry logic, error handling (optional)
- [ ] Log requests/responses (no secrets) (optional)

### 2.2 Pay-in flow (customer → merchant)

- [x] Create order via Payok
- [x] **Use `paidAmount` (not `amount`) when crediting wallet**
- [x] Store transaction (PENDING)
- [x] Receive Payok callback → verify signature
- [x] Credit merchant wallet (ledger entry)
- [x] Update transaction (SUCCESS/FAILED)
- [x] Return SUCCESS to Payok
- [ ] Emit webhook to merchant (Phase 3)

### 2.3 Payout flow (merchant → recipient)

- [x] Validate merchant balance
- [x] Bank account inquiry via Payok
- [x] Create payout via Payok (with inquiryToken)
- [x] Debit merchant wallet (ledger entry)
- [x] Store transaction (PENDING)
- [x] Receive Payok callback → verify signature
- [x] Update transaction (SUCCESS/FAILED)
- [x] Return SUCCESS to Payok (refund on failure)
- [ ] Emit webhook to merchant (Phase 3)

---

## Phase 3: Merchant API

### 3.1 Merchant-facing endpoints

- [x] `POST /v1/payins` – create pay-in order
- [x] `GET /v1/payins/:id` – inquiry pay-in status
- [x] `POST /v1/payouts` – create payout (inquiry + create in one or two steps)
- [x] `GET /v1/payouts/:id` – inquiry payout status
- [x] `GET /v1/balance` – merchant wallet balance
- [x] `GET /v1/transactions` – list transactions (paginated)
- [x] `PATCH /v1/me/webhook` – configure webhook URL

### 3.2 Our webhooks to merchants

- [x] Webhook URL per merchant
- [x] Sign payload (HMAC-SHA256, X-Transacty-Webhook-Signature)
- [x] Events: payin.completed, payin.failed, payout.completed, payout.failed
- [x] Retry policy (pg-boss: 5 retries, 60s delay)
- [ ] Idempotent delivery (merchant dedupes by event_id)

---

## Phase 3.5: Merchant Portal ✓

**Flow:** Signup (business name, email, password) → Login → Activation (KYC) → API keys.

### 3.5.1 Portal auth

- [x] `POST /portal/auth/signup` – minimal signup (businessName, email, password)
- [x] `POST /portal/auth/login` – email + password → JWT
- [x] `POST /portal/auth/logout` – client clears token
- [x] JWT auth for `/portal/me/*` (Authorization: Bearer or X-Portal-Token)

### 3.5.2 Portal profile & activation

- [x] `GET /portal/me` – profile, kycStatus, needsActivation, canCreateApiKeys
- [x] `PATCH /portal/me` – update business name
- [x] `PUT /portal/me/kyc/business` – business profile
- [x] `POST /portal/me/kyc/persons` – add persons
- [x] `POST /portal/me/kyc/documents` – add documents
- [x] `POST /portal/me/kyc/submit` – submit KYC

### 3.5.3 Portal API keys

- [x] `GET /portal/me/api-keys` – list keys (requires kycStatus=verified)
- [x] `POST /portal/me/api-keys` – create key (returns key + secret once)
- [x] `DELETE /portal/me/api-keys/:keyId` – revoke key

### 3.5.4 Env & setup

- Add `PORTAL_JWT_SECRET` to .env (32-byte hex)
- Run `npm run db:migrate` for `password_hash` on merchant_users
- Run `npm run db:seed-portal-user` for test user (merchant@example.com / password123)

---

## Phase 4: Customer wallets

- [ ] `POST /v1/wallets` – merchant creates customer wallet
- [ ] `POST /v1/transfers` – merchant → customer wallet
- [ ] Customer wallet limits (max balance, per merchant config)
- [ ] `GET /v1/wallets/:id` – balance, status
- [ ] Freeze/unfreeze (merchant control)

---

## Phase 5: Fraud & safety

### 5.1 Limits & velocity

- [ ] Per-merchant rate limits
- [ ] Per-transaction amount limits (tier-based)
- [ ] Velocity: max payouts per recipient per day
- [ ] Velocity: max payins per merchant per hour

### 5.2 Operational controls

- [x] KYC schema (business profiles, documents, persons, users)
- [x] Merchant KYC API (GET/PUT business, persons, documents, submit)
- [x] KYC gate (KYC_REQUIRED env – block pay-in/payout until verified)
- [ ] Cooling period (hold funds X hours after pay-in before withdrawal)
- [ ] Withdrawal limits (daily/weekly per merchant)
- [ ] Blacklist (phone, account, merchant)
- [ ] Manual approval for large payouts (optional)

### 5.3 Idempotency

- [x] `Idempotency-Key` header on POST /v1/payins, POST /v1/payouts
- [x] Store key → response for 24h
- [x] Return cached response on duplicate key

---

## Flow: Start to end

```
1. Merchant signs up → gets API key + secret
2. Merchant creates pay-in → we call Payok → return payment URL/VA
3. Customer pays → Payok callback → we credit merchant wallet → webhook to merchant
4. Merchant creates payout → we debit wallet → call Payok → Payok callback → webhook to merchant
5. (Optional) Merchant creates customer wallet → transfers funds → customer can receive/pay
```

---

## Order of work

| Phase | Depends on | Delivers |
|-------|------------|----------|
| 0 | Payok credentials | API 200 |
| 1 | Phase 0 | Schema, merchant auth |
| 2 | Phase 1 | Payok flows working |
| 3 | Phase 2 | Merchant API, webhooks |
| 4 | Phase 3 | Customer wallets |
| 5 | Phase 3 | Fraud, idempotency |

---

*Last updated: when Payok is verified.*
