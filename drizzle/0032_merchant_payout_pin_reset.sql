-- Email-verified payout PIN reset tokens (hashed at rest).
CREATE TABLE IF NOT EXISTS "merchant_payout_pin_reset_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "merchant_id" uuid NOT NULL REFERENCES "merchants"("id") ON DELETE CASCADE,
  "requested_by_user_id" uuid NOT NULL REFERENCES "merchant_users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "merchant_payout_pin_reset_tokens_merchant_idx"
  ON "merchant_payout_pin_reset_tokens" ("merchant_id");

CREATE INDEX IF NOT EXISTS "merchant_payout_pin_reset_tokens_expires_idx"
  ON "merchant_payout_pin_reset_tokens" ("expires_at");
