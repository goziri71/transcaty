-- Per-market entitlements and KYB (Bangladesh / India / Europe are separate products).
CREATE TABLE IF NOT EXISTS "merchant_markets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "merchant_id" uuid NOT NULL REFERENCES "merchants"("id") ON DELETE CASCADE,
  "market" text NOT NULL,
  "entitlement_status" text NOT NULL DEFAULT 'disabled',
  "kyb_status" text NOT NULL DEFAULT 'not_started',
  "requested_at" timestamp with time zone,
  "approved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "merchant_markets_merchant_market_unique" UNIQUE("merchant_id", "market")
);

CREATE INDEX IF NOT EXISTS "merchant_markets_merchant_id_idx" ON "merchant_markets" ("merchant_id");

-- Seed all merchants with three markets (disabled until requested / approved).
INSERT INTO "merchant_markets" ("merchant_id", "market", "entitlement_status", "kyb_status")
SELECT m."id", v.market, 'disabled', 'not_started'
FROM "merchants" m
CROSS JOIN (VALUES ('bangladesh'), ('india'), ('europe')) AS v(market)
ON CONFLICT ("merchant_id", "market") DO NOTHING;

-- Backfill: approve markets where an active merchant wallet already exists for that region.
UPDATE "merchant_markets" mm
SET
  "entitlement_status" = 'approved',
  "kyb_status" = 'verified',
  "approved_at" = COALESCE(mm."approved_at", now()),
  "updated_at" = now()
FROM "wallets" w
WHERE w."merchant_id" = mm."merchant_id"
  AND w."type" = 'merchant'
  AND w."status" = 'active'
  AND (
    (mm."market" = 'bangladesh' AND w."currency" = 'BDT')
    OR (mm."market" = 'india' AND w."currency" IN ('INR', 'USDT'))
    OR (mm."market" = 'europe' AND w."currency" = 'USDC')
  );
