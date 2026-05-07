-- Audit log of every webhook accepted from a payment processor. Replays
-- are absorbed by the unique index on dedupe_hash so the apply function
-- only runs the first time a given (rail, environment, raw_body) is
-- seen. Failed attempts are kept for forensics.
CREATE TABLE IF NOT EXISTS "webhook_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "rail" text NOT NULL,
  "environment" text NOT NULL,
  "dedupe_hash" text NOT NULL,
  "raw_body" text NOT NULL,
  "signature" text,
  "signature_valid" boolean NOT NULL,
  "external_id" text,
  "transaction_id" uuid,
  "status" text NOT NULL DEFAULT 'received',
  "error" text,
  "attempts" text NOT NULL DEFAULT '0',
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_dedupe_hash_unique" ON "webhook_events" USING btree ("dedupe_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_events_rail_env_idx" ON "webhook_events" USING btree ("rail","environment");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_events_status_idx" ON "webhook_events" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_events_received_at_idx" ON "webhook_events" USING btree ("received_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_events_external_id_idx" ON "webhook_events" USING btree ("external_id");
