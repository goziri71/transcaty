-- Merchant-level transaction PIN for portal payout operations (bcrypt hash; never store plaintext).
ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "payout_pin_hash" text;
ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "payout_pin_set_at" timestamptz;
ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "payout_pin_failed_attempts" integer NOT NULL DEFAULT 0;
ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "payout_pin_locked_until" timestamptz;
