# PYUSD (Tekko) — merchant integration guide

How to accept **one-time PYUSD** payments on **Ethereum** via Transacty. Settled proceeds credit your merchant **USDC** wallet (not a PYUSD balance).

| Audience | Surface | Auth |
|----------|---------|------|
| **Merchant backend** | `POST/GET /v1/pyusd/payment-intents` | **HMAC** (same as all `/v1/*`) |
| **Inbound callbacks** | Configure Tekko → Transacty `/webhooks/tekko/live` | Tekko HMAC (`whsec_…`) — Transacty verifies; merchants receive normal outbound webhooks |

> **Live only:** Tekko has no sandbox. Use a **live** API key. `test` environment returns a fail-safe unavailable error.

> Market gate: merchant must have the **`pyusd`** market **approved**. Settlement uses the same **USDC** pocket as Europe.

---

## 1. Model

| Concept | Meaning |
|---------|---------|
| **Collect** | Payer sends **PYUSD** on **Ethereum** to a Tekko deposit address |
| **Settle** | After Tekko reports settlement complete, Transacty credits **USDC** once |
| **Spend** | Use existing USDC balance / payouts — no merchant PYUSD withdraw via Tekko |
| **Credit rule** | Funds are **not** spendable on unpaid/`customer.wallet.credited` alone. Credit happens when `settlementStatus` is `settled` (webhook or poll) |
| **Network** | **Ethereum only** in this phase |

**Limits:** PYUSD **1 – 500,000** per intent.

---

## 2. Auth

Same HMAC as other `/v1` routes. Money writes require **`Idempotency-Key`**.

Scope: `payin:create` (or `*`).

---

## 3. Create payment intent

`POST /v1/pyusd/payment-intents`

```json
{
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

**Response (200):**

```json
{
  "transactionId": "…",
  "paymentIntentId": "…",
  "status": "awaiting_payment",
  "settlementStatus": "awaiting_payment",
  "amount": "25.00",
  "currency": "PYUSD",
  "settlementCurrency": "USDC",
  "network": "ethereum",
  "depositAddress": "0x…",
  "expiresAt": "…",
  "environment": "live"
}
```

Show the payer the **deposit address** + **amount** (QR / copy). Network is always Ethereum.

---

## 4. Poll status

`GET /v1/pyusd/payment-intents/:transactionId`

Returns Transacty status plus upstream payment/settlement fields. When settlement completes (including if a webhook was missed), Transacty may settle USDC on poll.

`settled: true` means the USDC ledger credit succeeded.

---

## 5. Outbound merchant webhooks

After settlement Transacty sends your configured merchant webhook:

- `payin.completed` — USDC credited (`currency: "USDC"`, `paidAmount` = net USDC)
- `payin.failed` — expired / failed intent

Configure your webhook URL in the portal / `/v1/me/webhook` (HTTPS only).

---

## 6. Ops notes

- Inbound Tekko URL (provider-facing): `{APP_BASE_URL}/webhooks/tekko/live`
- Env (platform): `TEKKO_LIVE_KEY_ID`, `TEKKO_LIVE_PRIVATE_KEY` (Ed25519 PEM), `TEKKO_WEBHOOK_SECRET`
- Portal create UI is out of scope for phase 1; credited pays appear on the transaction list once ledgered
