-- Maker-checker approval queue for large merchant-portal payouts (dual control).
DO $$ BEGIN
  CREATE TYPE "portal_payout_rail" AS ENUM('eur', 'cpg', 'br', 'ngn', 'bd');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "portal_payout_approval_status" AS ENUM(
    'pending', 'approved', 'rejected', 'executed', 'expired', 'execution_failed', 'cancelled'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "portal_payout_approval_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "rail" "portal_payout_rail" NOT NULL,
  "status" "portal_payout_approval_status" NOT NULL DEFAULT 'pending',
  "merchant_id" uuid NOT NULL REFERENCES "merchants"("id") ON DELETE CASCADE,
  "environment" "payok_environment" NOT NULL DEFAULT 'test',
  "requested_by" uuid REFERENCES "merchant_users"("id") ON DELETE SET NULL,
  "approved_by" uuid REFERENCES "merchant_users"("id") ON DELETE SET NULL,
  "idempotency_key" text NOT NULL,
  "body_hash" text NOT NULL,
  "payload" text NOT NULL,
  "amount" numeric(18, 2) NOT NULL,
  "currency" text NOT NULL,
  "trigger_reason" text NOT NULL,
  "reason" text,
  "rejected_reason" text,
  "last_error" text,
  "executed_transaction_id" uuid REFERENCES "transactions"("id") ON DELETE SET NULL,
  "expires_at" timestamptz NOT NULL,
  "executed_at" timestamptz,
  "rejected_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "portal_payout_approval_requests_merchant_idem_uniq"
  ON "portal_payout_approval_requests" ("merchant_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "portal_payout_approval_requests_merchant_status_idx"
  ON "portal_payout_approval_requests" ("merchant_id", "status");
CREATE INDEX IF NOT EXISTS "portal_payout_approval_requests_status_idx"
  ON "portal_payout_approval_requests" ("status");
CREATE INDEX IF NOT EXISTS "portal_payout_approval_requests_requested_by_idx"
  ON "portal_payout_approval_requests" ("requested_by");
CREATE INDEX IF NOT EXISTS "portal_payout_approval_requests_expires_at_idx"
  ON "portal_payout_approval_requests" ("expires_at");
