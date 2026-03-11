# Transcaty Roadmap

> Real money flows. Merchants build fintechs. Customers under merchants. Do it right.

---

## Phase 0: Payok verified ✓

**Gate:** Payok API returns 200 before we proceed.

- [ ] Receive Payok credentials (merchantId, keys, base URL)
- [ ] Implement signature util (sign requests, verify callbacks)
- [ ] Call one Payok endpoint (e.g. balance inquiry) – confirm 200
- [ ] Document base URL, env vars, test flow

---

## Phase 1: Foundation

### 1.1 Database schema

- [ ] `merchants` – id, name, status, kyc_status, created_at
- [ ] `merchant_api_keys` – merchant_id, key_hash, secret_enc, scopes, status
- [ ] `wallets` – merchant_id, type (merchant|customer), parent_id (for customer), balance, currency, status
- [ ] `ledger_entries` – wallet_id, amount, direction, type, reference_id, created_at
- [ ] `transactions` – id, merchant_id, type (payin|payout|transfer), status, amount, currency, external_id (Payok), metadata
- [ ] `idempotency_keys` – key, merchant_id, response_snapshot, expires_at

### 1.2 Merchant authentication

- [ ] API key + secret model (live/test)
- [ ] HMAC request signing (X-Transcaty-Key, X-Transcaty-Signature, X-Transcaty-Timestamp)
- [ ] Replay protection (±5 min timestamp)
- [ ] Scope-based authorization (payin:create, payout:create, etc.)

---

## Phase 2: Payok flows

### 2.1 Payok client

- [ ] Sign all outbound requests
- [ ] Verify all inbound callbacks
- [ ] Retry logic, error handling
- [ ] Log requests/responses (no secrets)

### 2.2 Pay-in flow (customer → merchant)

- [ ] Create order via Payok
- [ ] **Use `paidAmount` (not `amount`) when crediting wallet** – Payok alert: response amount vs paidAmount may differ; paidAmount = actual received
- [ ] Store transaction (PENDING)
- [ ] Receive Payok callback → verify signature
- [ ] Credit merchant wallet (ledger entry)
- [ ] Update transaction (SUCCESS/FAILED)
- [ ] Return SUCCESS to Payok
- [ ] Emit webhook to merchant (if configured)

### 2.3 Payout flow (merchant → recipient)

- [ ] Validate merchant balance
- [ ] Bank account inquiry via Payok
- [ ] Create payout via Payok (with inquiryToken)
- [ ] Debit merchant wallet (ledger entry)
- [ ] Store transaction (PENDING)
- [ ] Receive Payok callback → verify signature
- [ ] Update transaction (SUCCESS/FAILED)
- [ ] Return SUCCESS to Payok
- [ ] Emit webhook to merchant

---

## Phase 3: Merchant API

### 3.1 Merchant-facing endpoints

- [ ] `POST /v1/payins` – create pay-in order
- [ ] `GET /v1/payins/:id` – inquiry pay-in status
- [ ] `POST /v1/payouts` – create payout (inquiry + create in one or two steps)
- [ ] `GET /v1/payouts/:id` – inquiry payout status
- [ ] `GET /v1/balance` – merchant wallet balance
- [ ] `GET /v1/transactions` – list transactions (paginated)

### 3.2 Our webhooks to merchants

- [ ] Webhook URL per merchant
- [ ] Sign payload (HMAC or similar)
- [ ] Events: payin.completed, payin.failed, payout.completed, payout.failed
- [ ] Retry policy (exponential backoff)
- [ ] Idempotent delivery (merchant dedupes by event_id)

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

- [ ] Cooling period (hold funds X hours after pay-in before withdrawal)
- [ ] Withdrawal limits (daily/weekly per merchant)
- [ ] Blacklist (phone, account, merchant)
- [ ] Manual approval for large payouts (optional)

### 5.3 Idempotency

- [ ] `Idempotency-Key` header on all mutation endpoints
- [ ] Store key → response for 24h
- [ ] Return cached response on duplicate key

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
