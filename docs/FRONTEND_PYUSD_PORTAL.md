# PYUSD — merchant portal frontend handoff

Portal JWT surfaces for **one-time PYUSD** checkout (Tekko). Settles to merchant **USDC**. Live-only (no Tekko sandbox).

## Markets & wallets

| Action | Endpoint |
|--------|----------|
| List markets | `GET /portal/me/markets` — includes `market: "pyusd"` |
| Request access | `POST /portal/me/markets/pyusd/request` |
| Wallets / balance | `GET /portal/me/wallets` / `GET /portal/me/balance` — after approve, **USDC** pocket (shared with Europe) |

Do **not** invent a PYUSD merchant balance card. Copy: “PYUSD collects → USDC settles”.

## Create & poll (money routes)

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/portal/me/pyusd/payment-intents` | Requires money role + MFA step-up per existing portal money guards; send `Idempotency-Key` |
| `GET` | `/portal/me/pyusd/payment-intents/:transactionId` | Poll; may settle USDC if webhook missed |

**Create body:**

```json
{
  "environment": "live",
  "amount": "25.00",
  "merchantReference": "order-4821",
  "expiresInMinutes": 30,
  "metadata": { "orderId": "4821" }
}
```

`environment: "test"` fails closed (`payment_unavailable`) — Tekko has no sandbox.

**Create response highlights:** `depositAddress`, `amount`, `currency: "PYUSD"`, `settlementCurrency: "USDC"`, `network: "ethereum"`, `paymentIntentId`, `expiresAt`.

UI: show Ethereum deposit address + amount (QR/copy). No payout wizard for PYUSD.

## Transaction history

`GET /portal/me/transactions?rail=pyusd` — filter `provider = tekko-pyusd-payin`.  
Detail: `rail: "pyusd"`, `railLabel: "PYUSD pay-in"`.

## Checklist

- [ ] Markets card for `pyusd` + request CTA
- [ ] Create payment intent form (live only, amount, merchantReference)
- [ ] Show deposit address / expiry; poll status endpoint
- [ ] Tx list chip `rail=pyusd`
- [ ] USDC wallet shows settled proceeds (no separate PYUSD wallet)
