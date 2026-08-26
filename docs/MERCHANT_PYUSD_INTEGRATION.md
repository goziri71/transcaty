# PYUSD (Tekko) — merchant integration guide

How to accept **one-time PYUSD** payments on **Ethereum** via Transacty. Settled proceeds credit a dedicated **PYUSD USDC** wallet (`PYUSD-USDC`), not Europe **USDC**.

| Audience | Surface | Auth |
|----------|---------|------|
| **Merchant backend** | `POST/GET /v1/pyusd/payment-intents` | **HMAC** (same as all `/v1/*`) |
| **Merchant dashboard** | `POST/GET /portal/me/pyusd/payment-intents` + markets/txs | **Portal JWT** |
| **Inbound callbacks** | Configure Tekko → Transacty `/webhooks/tekko/live` | Tekko HMAC (`whsec_…`) — Transacty verifies; merchants receive normal outbound webhooks |

> **Live only:** Tekko has no sandbox. Use a **live** API key / portal `environment: "live"`. `test` returns a fail-safe unavailable error.

> Market gate: merchant must have the **`pyusd`** market **approved**. Settlement uses **`PYUSD-USDC`** (display **PYUSD USDC**). Europe **USDC** is a separate pocket; EUR payouts cannot spend PYUSD proceeds.

SPA handoff: [`FRONTEND_PYUSD_PORTAL.md`](./FRONTEND_PYUSD_PORTAL.md) · Provider admin: [`FRONTEND_PYUSD_PROVIDER.md`](./FRONTEND_PYUSD_PROVIDER.md)

---

## 1. Model

| Concept | Meaning |
|---------|---------|
| **Collect** | Payer sends **PYUSD** on **Ethereum** to a Tekko deposit address |
| **Settle** | After Tekko reports settlement complete, Transacty credits **PYUSD-USDC** once |
| **Spend** | PYUSD-USDC is not EUR-payoutable. No merchant Tekko withdraw in this phase |
| **Credit rule** | Funds are **not** spendable on unpaid/`customer.wallet.credited` alone. Credit happens when `settlementStatus` is `settled` (webhook or poll) |
| **Network** | **Ethereum only** in this phase |

**Limits:** PYUSD **1 – 500,000** per intent.

---

## 2. Auth

### HMAC (`/v1`)

Same as other `/v1` routes. Money writes require **`Idempotency-Key`**. Scope: `payin:create` (or `*`).

### Portal JWT (`/portal`)

Same session as other dashboard money routes. Create requires portal money role + existing step-up/MFA guards. Send **`Idempotency-Key`** on create.

---

## 3. Create payment intent

### API

`POST /v1/pyusd/payment-intents`

```json
{
  "amount": "25.00",
  "merchantReference": "order-4821",
  "expiresInMinutes": 30,
  "metadata": { "orderId": "4821" }
}
```

### Portal (dashboard)

`POST /portal/me/pyusd/payment-intents`

```json
{
  "environment": "live",
  "amount": "25.00",
  "merchantReference": "order-4821",
  "expiresInMinutes": 30,
  "metadata": { "orderId": "4821" }
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `amount` | yes | PYUSD string |
| `merchantReference` | yes | Your reference (max 128) |
| `expiresInMinutes` | no | 5–1440, default 30 |
| `metadata` | no | Opaque object echoed upstream |
| `environment` | portal only | Must be `live` for Tekko |

**Response (200):**

```json
{
  "transactionId": "…",
  "paymentIntentId": "…",
  "status": "awaiting_payment",
  "settlementStatus": "awaiting_payment",
  "amount": "25.00",
  "currency": "PYUSD",
  "settlementCurrency": "PYUSD-USDC",
  "settlementCurrencyLabel": "PYUSD USDC",
  "network": "ethereum",
  "depositAddress": "0x…",
  "expiresAt": "…",
  "environment": "live"
}
```

Show the payer the **deposit address** + **amount** (QR / copy). Network is always Ethereum.

---

## 4. Poll status

| Surface | Path |
|---------|------|
| API | `GET /v1/pyusd/payment-intents/:transactionId` |
| Portal | `GET /portal/me/pyusd/payment-intents/:transactionId` |

Returns Transacty status plus upstream payment/settlement fields. When settlement completes (including if a webhook was missed), Transacty may settle **PYUSD-USDC** on poll.

`settled: true` means the PYUSD-USDC ledger credit succeeded.

Also: `GET /portal/me/transactions?rail=pyusd`.

---

## 5. Outbound merchant webhooks

After settlement Transacty sends your configured merchant webhook:

- `payin.completed` — PYUSD-USDC credited (`currency: "PYUSD-USDC"`, `paidAmount` = net USDC equivalent)
- `payin.failed` — expired / failed intent

Configure your webhook URL in the portal / `/v1/me/webhook` (HTTPS only).

---

## 6. Ops notes

- Inbound Tekko URL (provider-facing): `{APP_BASE_URL}/webhooks/tekko/live`
- Env (platform): `TEKKO_LIVE_KEY_ID`, `TEKKO_LIVE_PRIVATE_KEY` (Ed25519 PEM), `TEKKO_WEBHOOK_SECRET`

### Signing keys + webhook secret

1. Upload **public** PEM in the Tekko dashboard; set `TEKKO_LIVE_KEY_ID` from the UI.
2. Encrypt private PEM: `npm run encrypt -- --file path/to/private.pem --name TEKKO_LIVE_PRIVATE_KEY_ENC`
3. Copy webhook secret from Tekko → encrypt → `TEKKO_WEBHOOK_SECRET` / `_ENC`.
4. Webhook URL: `{APP_BASE_URL}/webhooks/tekko/live`.
5. Tekko IP allowlist: set `TEKKO_STATIC_PROXY_URL` (QuotaGuard HTTP CONNECT). Allowlist **both** QuotaGuard IPs with Tekko. Do not set process-wide `HTTP_PROXY`.

- Provider: approve `pyusd` market; reconcile with `POST /provider/tekko/pyusd/reconcile`
- **Wallet split:** new settles credit `PYUSD-USDC` only. EUR payouts debit Europe `USDC` only. Any PYUSD that already settled to shared `USDC` before this split stays on that Europe row (not moved automatically).
