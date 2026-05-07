-- Add a provider/rail label to transactions and enforce uniqueness of
-- (provider, environment, external_id) for rows where both are set.
-- This prevents duplicate transaction rows from being created when a
-- provider replays a callback or when retries race in our own code.
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "provider" text;
--> statement-breakpoint

-- Best-effort backfill so existing rows participate in the unique index.
-- Inferences come from transactions.metadata (JSON) and type. Anything
-- we can't classify confidently stays NULL and is therefore excluded
-- from the partial unique index (existing duplicates, if any, remain).
UPDATE "transactions"
SET "provider" = CASE
  WHEN "type" = 'payin'  AND "currency" = 'BDT' THEN 'payok-bd-payin'
  WHEN "type" = 'payout' AND "currency" = 'BDT' THEN 'payok-bd-payout'
  WHEN "type" = 'transfer' THEN 'internal-transfer'
  WHEN "type" = 'refund'   THEN 'internal-refund'
  ELSE "provider"
END
WHERE "provider" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "transactions_provider_external_id_idx" ON "transactions" USING btree ("provider","external_id");
--> statement-breakpoint

-- Partial unique index: only enforce when both provider and external_id
-- are present. Multi-rail correctness: same external_id under a
-- different provider is allowed (different processors).
CREATE UNIQUE INDEX IF NOT EXISTS "transactions_provider_env_external_id_uniq" ON "transactions" USING btree ("provider","environment","external_id") WHERE "provider" IS NOT NULL AND "external_id" IS NOT NULL;
