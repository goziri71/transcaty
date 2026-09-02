-- Per-merchant Tekko permanent NGN virtual account (customer VA). Do not store raw BVN.
ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "tekko_bvn_status" text;
ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "tekko_ngn_va_status" text;
ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "tekko_ngn_va_account_number" text;
ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "tekko_ngn_va_bank_name" text;
ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "tekko_ngn_va_account_name" text;
