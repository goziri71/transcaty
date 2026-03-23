-- Backfill merchant_pricing for all merchants without a row.
-- Default: 3% pay-in, 2% pay-out (Bangladesh).
-- Excludes platform merchant (id = 00000000-0000-0000-0000-000000000001).
INSERT INTO "merchant_pricing" (
  "merchant_id",
  "billing_mode",
  "fee_percentage_payin",
  "fee_percentage_payout",
  "fee_min_payin",
  "fee_min_payout",
  "effective_at",
  "created_at",
  "updated_at"
)
SELECT
  m.id,
  'percentage_only',
  3,
  2,
  0,
  0,
  now(),
  now(),
  now()
FROM "merchants" m
LEFT JOIN "merchant_pricing" mp ON mp.merchant_id = m.id
WHERE mp.id IS NULL
  AND m.id != '00000000-0000-0000-0000-000000000001';
