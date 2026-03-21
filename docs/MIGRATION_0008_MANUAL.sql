-- Manual fallback if db:migrate isn't available. Run against your production DB.
-- Migration 0008: MFA columns for merchant_users and provider_users

ALTER TABLE "merchant_users" ADD COLUMN IF NOT EXISTS "mfa_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE "merchant_users" ADD COLUMN IF NOT EXISTS "mfa_pending" boolean DEFAULT false NOT NULL;
ALTER TABLE "merchant_users" ADD COLUMN IF NOT EXISTS "mfa_secret_enc" text;

ALTER TABLE "provider_users" ADD COLUMN IF NOT EXISTS "mfa_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE "provider_users" ADD COLUMN IF NOT EXISTS "mfa_pending" boolean DEFAULT false NOT NULL;
ALTER TABLE "provider_users" ADD COLUMN IF NOT EXISTS "mfa_secret_enc" text;
