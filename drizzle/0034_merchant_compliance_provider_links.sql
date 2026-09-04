-- Provider-neutral merchant compliance + external provider customer links.
-- Replaces tekko_* columns on merchants for NGN BVN/VA and Tekko customer id.

CREATE TABLE IF NOT EXISTS "merchant_provider_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "merchant_id" uuid NOT NULL REFERENCES "merchants"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "external_customer_id" text NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "merchant_provider_links_merchant_provider_unique" UNIQUE("merchant_id", "provider")
);

CREATE INDEX IF NOT EXISTS "merchant_provider_links_merchant_id_idx"
  ON "merchant_provider_links" ("merchant_id");

CREATE INDEX IF NOT EXISTS "merchant_provider_links_provider_external_idx"
  ON "merchant_provider_links" ("provider", "external_customer_id");

CREATE TABLE IF NOT EXISTS "merchant_market_compliance" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "merchant_id" uuid NOT NULL REFERENCES "merchants"("id") ON DELETE CASCADE,
  "market" text NOT NULL,
  "bvn_enc" text,
  "bvn_first_name" text,
  "bvn_last_name" text,
  "bvn_phone_number" text,
  "bvn_date_of_birth" text,
  "bvn_email" text,
  "bvn_verification_status" text DEFAULT 'not_submitted' NOT NULL,
  "bvn_verified_at" timestamp with time zone,
  "va_status" text,
  "va_account_number" text,
  "va_bank_name" text,
  "va_account_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "merchant_market_compliance_merchant_market_unique" UNIQUE("merchant_id", "market")
);

CREATE INDEX IF NOT EXISTS "merchant_market_compliance_merchant_id_idx"
  ON "merchant_market_compliance" ("merchant_id");

CREATE INDEX IF NOT EXISTS "merchant_market_compliance_va_account_idx"
  ON "merchant_market_compliance" ("va_account_number")
  WHERE "va_account_number" IS NOT NULL;

-- Backfill Tekko customer ids from legacy merchants.tekko_customer_id
INSERT INTO "merchant_provider_links" ("merchant_id", "provider", "external_customer_id", "updated_at")
SELECT "id", 'tekko', trim("tekko_customer_id"), now()
FROM "merchants"
WHERE "tekko_customer_id" IS NOT NULL AND trim("tekko_customer_id") <> ''
ON CONFLICT ("merchant_id", "provider") DO UPDATE SET
  "external_customer_id" = EXCLUDED."external_customer_id",
  "updated_at" = now();

-- Backfill Nigeria VA/BVN status from legacy merchants.tekko_* columns (BVN value was never stored)
INSERT INTO "merchant_market_compliance" (
  "merchant_id",
  "market",
  "bvn_verification_status",
  "va_status",
  "va_account_number",
  "va_bank_name",
  "va_account_name",
  "updated_at"
)
SELECT
  "id",
  'nigeria',
  COALESCE(NULLIF(trim("tekko_bvn_status"), ''), 'not_submitted'),
  "tekko_ngn_va_status",
  NULLIF(trim("tekko_ngn_va_account_number"), ''),
  NULLIF(trim("tekko_ngn_va_bank_name"), ''),
  NULLIF(trim("tekko_ngn_va_account_name"), ''),
  now()
FROM "merchants"
WHERE
  ("tekko_bvn_status" IS NOT NULL AND trim("tekko_bvn_status") <> '')
  OR ("tekko_ngn_va_account_number" IS NOT NULL AND trim("tekko_ngn_va_account_number") <> '')
  OR ("tekko_ngn_va_status" IS NOT NULL AND trim("tekko_ngn_va_status") <> '')
ON CONFLICT ("merchant_id", "market") DO UPDATE SET
  "bvn_verification_status" = COALESCE(NULLIF(EXCLUDED."bvn_verification_status", 'not_submitted'), "merchant_market_compliance"."bvn_verification_status"),
  "va_status" = COALESCE(EXCLUDED."va_status", "merchant_market_compliance"."va_status"),
  "va_account_number" = COALESCE(EXCLUDED."va_account_number", "merchant_market_compliance"."va_account_number"),
  "va_bank_name" = COALESCE(EXCLUDED."va_bank_name", "merchant_market_compliance"."va_bank_name"),
  "va_account_name" = COALESCE(EXCLUDED."va_account_name", "merchant_market_compliance"."va_account_name"),
  "updated_at" = now();
