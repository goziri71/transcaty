# Fraud & velocity policy

Bangladesh BDT **pay-in** and **pay-out** flows enforce optional limits via environment variables. All limits are **off** when unset or `0`.

## Environment variables

| Variable | Effect |
|----------|--------|
| `FRAUD_MAX_PAYINS_PER_HOUR` | Max pay-in **creates** per merchant per hour (all environments) |
| `FRAUD_MAX_PAYOUTS_PER_RECIPIENT_PER_DAY` | Max payout attempts to the same beneficiary account per 24h |
| `FRAUD_COOLING_PERIOD_HOURS` | Block payout if a **successful BDT pay-in** completed within this window |
| `FRAUD_MAX_PAYOUT_AMOUNT_PER_DAY_BDT` | Sum of pending+successful BDT payouts in 24h cannot exceed this |

Rejected requests return **403** with `code` such as `payin_velocity_exceeded`, `cooling_period`, `blacklisted`.

## Blacklist

Table `merchant_blacklist` (phone, account, email) per merchant and `test`/`live` environment.

**Provider admin API** (JWT, role with `merchant.status.write` — e.g. risk, super_admin):

- `GET /provider/merchants/:merchantId/blacklist?environment=test`
- `POST /provider/merchants/:merchantId/blacklist` — body: `{ environment, entryType, value, reason? }`
- `DELETE /provider/merchants/:merchantId/blacklist/:entryId`

Run migration `drizzle/0020_merchant_fraud_blacklist.sql` before use.

## India / EU

Tylt lanes are not gated by this module yet (amount limits still apply via `LIMITS`). Extend `fraud-policy.ts` when product requires cross-border velocity.
