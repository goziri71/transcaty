CREATE TYPE "public"."provider_action_status" AS ENUM('pending', 'approved', 'rejected', 'executed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."provider_action_type" AS ENUM('wallet_adjustment', 'transaction_status_change');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_action_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_type" "provider_action_type" NOT NULL,
	"status" "provider_action_status" DEFAULT 'pending' NOT NULL,
	"requested_by" uuid,
	"approved_by" uuid,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"payload" text NOT NULL,
	"reason" text,
	"ticket_id" text,
	"risk_level" text DEFAULT 'normal' NOT NULL,
	"rejected_reason" text,
	"executed_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_action_requests" ADD CONSTRAINT "provider_action_requests_requested_by_provider_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."provider_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_action_requests" ADD CONSTRAINT "provider_action_requests_approved_by_provider_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."provider_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_action_requests_status_idx" ON "provider_action_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_action_requests_action_type_idx" ON "provider_action_requests" USING btree ("action_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_action_requests_requested_by_idx" ON "provider_action_requests" USING btree ("requested_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_action_requests_approved_by_idx" ON "provider_action_requests" USING btree ("approved_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_action_requests_created_at_idx" ON "provider_action_requests" USING btree ("created_at");