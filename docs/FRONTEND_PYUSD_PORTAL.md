# PYUSD — merchant portal frontend handoff

Portal JWT surfaces for **one-time PYUSD** checkout (Tekko). Settles to merchant **PYUSD USDC** (`currency: "PYUSD-USDC"`). Live-only (no Tekko sandbox).

## Markets & wallets

| Action | Endpoint |
|--------|----------|
| List markets | `GET /portal/me/markets` — includes `market: "pyusd"` |
| Request access | `POST /portal/me/markets/pyusd/request` |
| Wallets / balance | `GET /portal/me/wallets` / `GET /portal/me/balance` — after approve, a **PYUSD USDC** card (`currency: "PYUSD-USDC"`, `region: "pyusd"`). Europe **USDC** is a separate card. Use **`environment=live`**. Test has no PYUSD pocket (`live_only`). |

Show two USDC-related cards when both markets are enabled: **USDC** (Europe) and **PYUSD USDC** (Tekko). Do not merge them. Copy: “PYUSD collects → PYUSD USDC settles. EUR payouts use Europe USDC only.”

If `entitlementStatus` is `approved` but the test catalog shows `walletActivated: false` + `live_only`, the market is approved — switch the dashboard to **live**. Do not treat that as “not approved.”

## Create & poll (money routes)

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/portal/me/pyusd/payment-intents` | Requires money role + MFA step-up per existing portal money guards; send `Idempotency-Key` |
| `GET` | `/portal/me/pyusd/payment-intents/:transactionId` | Poll; may settle PYUSD-USDC if webhook missed |

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

`environment: "test"` (create body or GET query) fails closed with `503` `payment_unavailable` — Tekko has no sandbox. Omit GET `environment` or send `live`.

**Create response highlights:** `depositAddress`, `amount`, `currency: "PYUSD"`, `settlementCurrency: "PYUSD-USDC"`, `settlementCurrencyLabel: "PYUSD USDC"`, `network: "ethereum"`, `paymentIntentId`, `expiresAt`.

UI: show Ethereum deposit address + amount (QR/copy). No payout wizard for PYUSD.

## Transaction history

`GET /portal/me/transactions?rail=pyusd` — filter `provider = tekko-pyusd-payin`.  
Detail: `rail: "pyusd"`, `railLabel: "PYUSD pay-in"`.

## Checklist

- [ ] Markets card for `pyusd` + request CTA
- [ ] Create payment intent form (live only, amount, merchantReference)
- [ ] Show deposit address / expiry; poll status endpoint
- [ ] Tx list chip `rail=pyusd`
- [ ] PYUSD USDC wallet (`PYUSD-USDC`) shows settled proceeds; Europe USDC is unchanged
