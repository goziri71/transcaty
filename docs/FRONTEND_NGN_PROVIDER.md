# NGN — provider admin frontend handoff

How Transacty ops manages the **`nigeria`** market and Tekko NGN virtual-account pay-ins / bank payouts in the admin SPA.

Related: [`FRONTEND_NGN_PORTAL.md`](./FRONTEND_NGN_PORTAL.md) · Merchant API: [`MERCHANT_NGN_INTEGRATION.md`](./MERCHANT_NGN_INTEGRATION.md) · Ops entitlement: [`TEKKO_NGN_OPS_ENTITLEMENT.md`](./TEKKO_NGN_OPS_ENTITLEMENT.md)

## Markets

| Method | Path |
|--------|------|
| `GET` | `/provider/merchants/:merchantId/markets` |
| `GET` | `/provider/merchants/:merchantId/services?environment=live` |
| `PATCH` | `/provider/merchants/:merchantId/markets/nigeria` |

`MARKET_IDS` includes `nigeria`. Settlement currencies: **`["NGN"]`**.

Approve example:

```json
{
  "entitlementStatus": "approved",
  "kybStatus": "verified",
  "reason": "Nigeria KYB complete"
}
```

Permission: `merchant.kyc.write`.

Approving provisions the merchant **NGN** settlement wallet (live only). Merchants still must complete **BVN Basic** + VA provision on portal/HMAC before they receive bank details.

## Product model (ops copy)

- **Collect:** one permanent **customer** NGN VA per Transacty merchant (not shared master VA, not temp exact-amount collect).
- **Credit:** `customer.wallet.credited` + NGN → Transacty NGN wallet (`provider: tekko-ngn-va`).
- **Payout:** Tekko master `ng/withdraw` (`provider: tekko-ngn-payout`). Fail closed on insufficient master balance.
- **Liquidity risk:** customer VA credits Tekko customer sub-ledger; withdraw debits master. Confirm sweep/funding with Tekko before treating VA+payout as production-ready together. See ops doc.

## Transactions

- List/detail include `rail: "nigeria"` for `tekko-ngn-va`, `tekko-ngn-payout`, and legacy `tekko-ngn-collect`.
- Provider list supports `?rail=nigeria` (and services/ops queues group under Nigeria).
- Labels:
  - `Nigeria NGN virtual account`
  - `Nigeria NGN payout`
  - `Nigeria NGN collect (legacy)` — historical temp collect only; no new creates

## Reconcile

| Method | Path | Body |
|--------|------|------|
| `POST` | `/provider/tekko/ngn/reconcile` | `{ "transactionId": "<uuid>" }` |

Permission: `tx.reconcile`.

Routes by provider:

- Legacy **collect** pay-in → status pull + settle if credited
- **Payout** → finalize success/failure from Tekko withdraw status
- Permanent VA credits are primarily webhook-driven (`customer.wallet.credited`); reconcile still accepts Tekko NGN tx ids and returns `finalized` | `not_terminal` | `skipped`

Response `outcome`: `finalized` | `not_terminal` | `skipped` (`already_terminal` | `wrong_rail`). May include `collectionStatus` or `withdrawalStatus` and `merchantWebhookQueued`.

## UI checklist

- [ ] Payment markets panel: **Nigeria (NGN)** row (request → approve/suspend)
- [ ] Note: settles to **NGN** (native), live-only upstream
- [ ] Tx detail: Nigeria rail label; Reconcile → `POST /provider/tekko/ngn/reconcile`
- [ ] Distinguish VA pay-in vs payout vs legacy collect in filters/chips
- [ ] Ops reminder: customer VA liquidity ≠ master withdraw balance until Tekko confirms funding path
