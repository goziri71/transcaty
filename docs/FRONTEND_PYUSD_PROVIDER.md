# PYUSD — provider admin frontend handoff

How Transacty ops manages the **`pyusd`** market and Tekko PYUSD pay-ins in the admin SPA.

## Markets

| Method | Path |
|--------|------|
| `GET` | `/provider/merchants/:merchantId/markets` |
| `PATCH` | `/provider/merchants/:merchantId/markets/pyusd` |

`MARKET_IDS` includes `pyusd`. Settlement currencies: **`["USDC"]`** (same USDC pocket as Europe when both approved).

Approve example:

```json
{
  "entitlementStatus": "approved",
  "kybStatus": "verified",
  "reason": "PYUSD KYB complete"
}
```

Permission: `merchant.kyc.write`.

## Transactions

- List/detail include `rail: "pyusd"` / `railLabel: "PYUSD pay-in"` for `provider = tekko-pyusd-payin`.
- Filter client-side on `rail === "pyusd"` (provider list has no `?rail=` query today).

## Reconcile (like PayOK)

| Method | Path | Body |
|--------|------|------|
| `POST` | `/provider/tekko/pyusd/reconcile` | `{ "transactionId": "<uuid>" }` |

Permission: `tx.reconcile`.

Polls Tekko; credits merchant **USDC** once when `settlementStatus` is settled (idempotent). Queues merchant `payin.completed` / `payin.failed` when status transitions.

Response `outcome`: `finalized` | `not_terminal` | `skipped` (`already_terminal` | `wrong_rail`).

## UI checklist

- [ ] Payment markets panel: fifth row **PYUSD** (request → approve/suspend)
- [ ] Note: settles to **USDC** (shared with Europe wallet card)
- [ ] Tx detail: show PYUSD rail label; Reconcile button → `POST /provider/tekko/pyusd/reconcile`
- [ ] Live-only upstream (no Tekko sandbox)
