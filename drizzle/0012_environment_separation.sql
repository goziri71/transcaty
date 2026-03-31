DO $$ BEGIN
 CREATE TYPE "public"."payok_environment" AS ENUM('test', 'live');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "environment" "payok_environment" DEFAULT 'test' NOT NULL;
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD COLUMN IF NOT EXISTS "environment" "payok_environment" DEFAULT 'test' NOT NULL;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "environment" "payok_environment" DEFAULT 'test' NOT NULL;
--> statement-breakpoint
UPDATE "transactions"
SET "environment" = CASE
  WHEN "metadata" IS NOT NULL AND ("metadata"::jsonb ->> 'environment') IN ('test', 'live')
    THEN ("metadata"::jsonb ->> 'environment')::payok_environment
  ELSE "environment"
END;
--> statement-breakpoint
UPDATE "ledger_entries" le
SET "environment" = t."environment"
FROM "transactions" t
WHERE le."reference_id" = t."id"::text;
--> statement-breakpoint
INSERT INTO "wallets" (
  "merchant_id",
  "type",
  "environment",
  "balance",
  "currency",
  "status",
  "created_at",
  "updated_at"
)
SELECT
  w."merchant_id",
  'merchant',
  'live',
  '0',
  w."currency",
  'active',
  now(),
  now()
FROM "wallets" w
LEFT JOIN "wallets" wl
  ON wl."merchant_id" = w."merchant_id"
  AND wl."type" = 'merchant'
  AND wl."environment" = 'live'
WHERE w."type" = 'merchant'
  AND w."environment" = 'test'
  AND wl."id" IS NULL
  AND w."merchant_id" <> '00000000-0000-0000-0000-000000000001';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallets_merchant_env_type_idx" ON "wallets" USING btree ("merchant_id","environment","type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_entries_wallet_env_idx" ON "ledger_entries" USING btree ("wallet_id","environment");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_merchant_env_idx" ON "transactions" USING btree ("merchant_id","environment");
