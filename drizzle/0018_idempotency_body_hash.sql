-- Tighten merchant request idempotency.
--
-- New columns:
--   body_hash         SHA-256 hex digest of the canonical request body.
--                     Allows runIdempotent() to detect a same-key /
--                     different-body collision and return 409.
--   status            'in_progress' | 'completed'. Set when the slot is
--                     claimed (before the upstream call) and promoted
--                     to 'completed' once the response snapshot is
--                     persisted. Lets a concurrent caller distinguish
--                     "still in flight" from "already complete".
--   updated_at        Useful for diagnosing stuck in_progress rows.
--
-- response_snapshot becomes nullable in spirit (default empty string for
-- in-progress claims) but stays NOT NULL with a default so legacy code
-- that doesn't yet pass it keeps working.

ALTER TABLE "idempotency_keys"
  ADD COLUMN IF NOT EXISTS "body_hash" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "idempotency_keys"
  ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'completed';
--> statement-breakpoint
ALTER TABLE "idempotency_keys"
  ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone NOT NULL DEFAULT now();
--> statement-breakpoint

ALTER TABLE "idempotency_keys"
  ALTER COLUMN "response_snapshot" SET DEFAULT '';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idempotency_keys_status_idx" ON "idempotency_keys" USING btree ("status");
