# NGN (Tekko) — merchant integration guide

How to accept **permanent NGN virtual-account** deposits and send **NGN bank payouts** via Transacty. Settled proceeds credit the merchant **NGN** wallet.

| Audience | Surface | Auth |
|----------|---------|------|
| **Merchant backend** | `/v1/ngn/*` | **HMAC** (same as all `/v1/*`) |
| **Merchant dashboard** | `/portal/me/ngn/*` + markets/txs | **Portal JWT** |
| **Inbound callbacks** | Tekko → Transacty `/webhooks/tekko/live` | Tekko HMAC — Transacty verifies; merchants receive normal outbound webhooks |

> **Live only:** Tekko has no sandbox. Use a **live** API key / portal `environment: "live"`. `test` returns `503` `payment_unavailable`.

> Market gate: merchant must have the **`nigeria`** market **approved** and KYC **verified**. Settlement currency is **`NGN`**.

> Happy-path responses never mention Tekko. Do not build UI or client copy around Tekko brand names.

SPA handoff: [`FRONTEND_NGN_PORTAL.md`](./FRONTEND_NGN_PORTAL.md) · Provider admin: [`FRONTEND_NGN_PROVIDER.md`](./FRONTEND_NGN_PROVIDER.md)

---

## 1. Model

| Concept | Meaning |
|---------|---------|
| **Virtual account** | One reusable Nigerian bank account per Transacty merchant |
| **BVN Basic** | Required once to provision the VA (`bvn` + name; **no** face image) |
| **Collect** | Payer transfers **any amount** to the VA; Transacty creates a pay-in and credits **NGN** |
| **Payout** | Debit merchant **NGN** wallet → Nigerian bank account |
| **Credit rule** | On `customer.wallet.credited` (NGN) for the merchant’s Tekko customer id — deduped by webhook claim + ledger reference |
| **Not in product** | Exact-amount temporary collections, amount/expiry pay instructions, MoMo, swaps |

**Limits (major units):**

| Flow | Min | Max |
|------|-----|-----|
| Pay-in (per inbound credit) | 100 | 5,000,000 |
| Payout | 100 | 5,000,000 |

Pay-in limits apply when a credit settles, not when the VA is created.

---

## 2. Auth

### HMAC (`/v1`)

Same as other `/v1` routes. Money writes require **`Idempotency-Key`**.

| Route family | Scope |
|--------------|-------|
| Virtual account GET/POST | `payin:create` (or `*`) |
| Banks list | `payin:create` or `payout:create` (or `*`) |
| Verify account / payouts | `payout:create` (or `*`) |

### Portal JWT (`/portal`)

Same session as other dashboard money routes. Writes require portal money role + existing step-up/MFA guards. Send **`Idempotency-Key`** on VA provision and payout create.

---

## 3. Virtual account

### Get status / details

| Surface | Path |
|---------|------|
| API | `GET /v1/ngn/virtual-account` |
| Portal | `GET /portal/me/ngn/virtual-account?environment=live` |

**Response (200):**

```json
{
  "status": "active",
  "bvnStatus": "verified",
  "accountNumber": "0123456789",
  "bankName": "Wema Bank",
  "accountName": "ADA OKAFOR",
  "currency": "NGN",
  "ready": true,
  "environment": "live"
}
```

| `status` | `ready` | Action |
|----------|---------|--------|
| `bvn_required` | `false` | Call POST with BVN Basic fields |
| `pending` | `false` | Poll GET |
| `active` (or bank details present) | `true` | Show details to payers; accept transfers |

No `expiryDate`, no `amount`.

### Provision (BVN Basic + VA)

| Surface | Path |
|---------|------|
| API | `POST /v1/ngn/virtual-account` |
| Portal | `POST /portal/me/ngn/virtual-account` |

**API body:**

```json
{
  "bvn": "22123456789",
  "firstName": "Ada",
  "lastName": "Okafor",
  "phoneNumber": "+2348012345678",
  "dateOfBirth": "1990-01-15",
  "customerEmail": "ada@example.com"
}
```

**Portal body:** same fields plus `"environment": "live"`.

| Field | Required | Notes |
|-------|----------|-------|
| `bvn` | yes | 11 digits. Encrypt in transit; **do not store** raw BVN at rest in your systems if avoidable |
| `firstName` / `lastName` | yes | BVN Basic name match |
| `phoneNumber` | no | |
| `dateOfBirth` | no | `YYYY-MM-DD` |
| `customerEmail` | no | |
| `faceImage` | — | **Not supported** — omit always |

Response shape matches GET. When `ready: true`, share `accountNumber` / `bankName` / `accountName` with payers.

---

## 4. Inbound payments (no create-per-payment)

After the VA is ready, payers transfer NGN to those bank details. Transacty:

1. Receives the credit webhook
2. Creates a `payin` (`provider: tekko-ngn-va`)
3. Credits the merchant **NGN** wallet (fees applied)
4. Sends your merchant webhook `payin.completed`

There is **no** `POST …/collections` or payment-intent create for NGN collect.

List history: `GET /portal/me/transactions?rail=nigeria` (or your existing HMAC transactions list if exposed).

---

## 5. Banks, verify, payout

### List banks

| Surface | Path |
|---------|------|
| API | `GET /v1/ngn/banks?search=` |
| Portal | `GET /portal/me/ngn/banks?environment=live&search=` |

```json
{ "items": [{ "bankCode": "035", "bankName": "Wema Bank" }] }
```

### Name enquiry

| Surface | Path |
|---------|------|
| API | `POST /v1/ngn/verify-account` |
| Portal | `POST /portal/me/ngn/verify-account` |

```json
{
  "accountNumber": "0123456789",
  "bankCode": "035"
}
```

Portal may also send `"environment": "live"`.

```json
{
  "accountNumber": "0123456789",
  "bankCode": "035",
  "accountName": "ADA OKAFOR"
}
```

### Create payout

| Surface | Path |
|---------|------|
| API | `POST /v1/ngn/payouts` |
| Portal | `POST /portal/me/ngn/payouts` |

```json
{
  "amount": "5000.00",
  "merchantReference": "wd-1001",
  "description": "Supplier payment",
  "beneficiary": {
    "accountNumber": "0123456789",
    "bankCode": "035",
    "accountName": "ADA OKAFOR",
    "bankName": "Wema Bank"
  }
}
```

Portal: add `"environment": "live"`. Require **`Idempotency-Key`**.

**API response (200):**

```json
{
  "transactionId": "…",
  "reference": "…",
  "status": "pending",
  "amount": "5000.00",
  "currency": "NGN",
  "environment": "live"
}
```

Portal create returns **201** and may include fee breakdown + masked recipient.

### Poll payout

| Surface | Path |
|---------|------|
| API | `GET /v1/ngn/payouts/:transactionId` |
| Portal | `GET /portal/me/ngn/payouts/:transactionId` |

Includes `withdrawalStatus`, `settled`, and beneficiary snapshot.

---

## 6. Outbound merchant webhooks

Configure your webhook URL in the portal / `/v1/me/webhook` (HTTPS only).

| Event | When |
|-------|------|
| `payin.completed` | VA credit settled to **NGN** |
| `payin.failed` | Rare for VA path; mainly legacy collect |
| `payout.completed` / `payout.failed` | Bank withdraw finalized |

Payload currency for NGN money movements is **`NGN`**.

---

## 7. Ops notes (platform)

- Inbound Tekko URL: `{APP_BASE_URL}/webhooks/tekko/live`
- Same Tekko Platform credentials as PYUSD (`TEKKO_LIVE_KEY_ID`, private key, `TEKKO_WEBHOOK_SECRET`, static proxy)
- Partner entitlements: `ngn_collections` (VA) + `ngn_payouts` (withdraw). Probe: `npm run tekko:ngn-entitlement-check`
- DB: migration `0030` adds merchant VA status columns (no raw BVN stored)
- Provider: approve `nigeria` market; `POST /provider/tekko/ngn/reconcile` for stuck txs
- **Liquidity:** VA deposits fund Tekko **customer** NGN; payouts debit Tekko **master**. Confirm funding/sweep with Tekko before production volume on both rails together
