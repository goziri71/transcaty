# Provider Treasury API — admin dashboard

Endpoint for the **Transacty admin (provider) dashboard** to show the platform's own money: retained earnings per currency, gross revenue, processed volume, and gross take-rate.

> **Read this first:** the numbers are **GROSS** (platform fees + subscriptions). **Net margin is not available yet** because provider cost (PayOK `transFee` / Tylt rate) is not persisted and the FX spread is not ledgered. The response carries `disclosures` flags — **the UI must label revenue "gross" and not imply profit.** Background: `docs/TREASURY_MANAGEMENT_RESEARCH.md`.

---

## Endpoint

```
GET /provider/treasury/overview
```

**Auth:** provider session (JWT or provider API key), **permission `treasury.read`** — granted only to the **`super_admin`** and **`finance`** roles. Other roles (`ops`, `support`, `risk`) get `403`. This keeps company revenue restricted.

**Query params**

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `environment` | `test` \| `live` | `test` | Which ledger to report. |
| `from` | ISO datetime | now − 30 days | Start of the revenue/volume window (inclusive). |
| `to` | ISO datetime | now | End of the window (exclusive). |

`400` if `from` is after `to`.

---

## Response `200`

```jsonc
{
  "environment": "live",
  "from": "2026-06-03T00:00:00.000Z",
  "to": "2026-07-03T00:00:00.000Z",

  // Retained earnings currently held in the platform wallets, per currency.
  // Point-in-time (NOT windowed). Lifetime, since no sweep/withdrawal exists yet.
  "platformBalances": [
    { "currency": "BDT", "balance": "1250000.00" },
    { "currency": "BRL", "balance": "8400.00" },
    { "currency": "USDC", "balance": "3120.50" },
    { "currency": "USDT", "balance": "5010.00" }
  ],

  // Gross revenue earned in the window, per currency.
  "revenue": {
    "byCurrency": [
      { "currency": "BDT", "platformFee": "42000.00", "monthlyFee": "5000.00", "total": "47000.00" },
      { "currency": "USDC", "platformFee": "310.00", "monthlyFee": "0.00", "total": "310.00" }
    ]
  },

  // Processed volume (successful pay-in + payout) in the window.
  // Note: `key` is the currency in byCurrency, and the rail name in byRail.
  "volume": {
    "byCurrency": [
      { "key": "BDT", "payin": "3800000.00", "payout": "1200000.00", "total": "5000000.00" }
    ],
    "byRail": [
      { "key": "bangladesh", "payin": "3800000.00", "payout": "1200000.00", "total": "5000000.00" },
      { "key": "brazil",     "payin": "60000.00",   "payout": "12000.00",   "total": "72000.00" }
    ]
  },

  // Gross take rate per currency = revenue.total / volume.total, in basis points.
  // 100 bps = 1%. null when volume is 0.
  "takeRate": [
    { "currency": "BDT", "revenue": "47000.00", "volume": "5000000.00", "takeRateBps": 94 }
  ],

  // Honesty flags — drive UI labeling.
  "disclosures": {
    "basis": "gross",
    "netMarginAvailable": false,
    "providerCostTracked": false,
    "fxSpreadLedgered": false,
    "note": "Revenue is GROSS platform fees + subscriptions. Provider cost ... net margin is not computable."
  }
}
```

### Field reference

| Field | Meaning |
|-------|---------|
| `platformBalances[]` | Money Transacty has **retained and still holds** in each currency's platform wallet. Point-in-time. |
| `revenue.byCurrency[]` | Gross revenue in the window: `platformFee` (transaction fees) + `monthlyFee` (subscriptions) = `total`. |
| `volume.byCurrency[]` / `volume.byRail[]` | Successful processed value. `byRail` keys: `bangladesh`, `brazil`, `india`, `europe`, `cpg_crypto`. |
| `takeRate[].takeRateBps` | Gross take in basis points (revenue ÷ volume × 10000). `null` if no volume. |
| `disclosures` | What is / isn't measurable. **Use these to label the UI.** |

All monetary values are **decimal strings** (2 dp) — never sum different currencies into one number.

---

## Suggested dashboard UI

- **Retained earnings cards** — one per currency from `platformBalances`, labeled "Retained (gross, not yet swept)".
- **Revenue for period** — `revenue.byCurrency`, split fees vs subscription, with the date-range picker driving `from`/`to`.
- **Volume + take-rate** — `volume.byRail` bar chart; `takeRate` shown as `bps/100`% per currency.
- **A persistent banner/badge** driven by `disclosures.netMarginAvailable === false`: *"Gross figures — provider cost & FX spread not yet tracked; net margin unavailable."* Do not display any "profit" number.

---

## Roadmap (what unlocks net margin)

When the Stage-1 data-capture work lands (persist provider cost, ledger the FX spread — see the research doc), this same endpoint will gain `providerCost`, `fxSpreadRevenue`, and `netMargin` fields and flip the `disclosures` flags to `true`. Build the UI so those are additive, and so the "gross" labeling is removed only when `netMarginAvailable` becomes `true`.
