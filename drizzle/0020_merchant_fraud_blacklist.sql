CREATE TYPE "merchant_blacklist_entry_type" AS ENUM('phone', 'account', 'email');

CREATE TABLE IF NOT EXISTS "merchant_blacklist" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "merchant_id" uuid NOT NULL REFERENCES "merchants"("id") ON DELETE CASCADE,
  "environment" "payok_environment" NOT NULL,
  "entry_type" "merchant_blacklist_entry_type" NOT NULL,
  "value_normalized" text NOT NULL,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "merchant_blacklist_uniq"
  ON "merchant_blacklist" ("merchant_id", "environment", "entry_type", "value_normalized");

CREATE INDEX IF NOT EXISTS "merchant_blacklist_merchant_env_idx"
  ON "merchant_blacklist" ("merchant_id", "environment");
