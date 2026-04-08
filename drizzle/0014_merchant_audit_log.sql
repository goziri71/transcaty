CREATE TABLE IF NOT EXISTS "merchant_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"merchant_user_id" uuid,
	"actor_email" text,
	"action" text NOT NULL,
	"resource" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchant_audit_log" ADD CONSTRAINT "merchant_audit_log_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "merchant_audit_log" ADD CONSTRAINT "merchant_audit_log_merchant_user_id_merchant_users_id_fk" FOREIGN KEY ("merchant_user_id") REFERENCES "public"."merchant_users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_audit_log_merchant_created_idx" ON "merchant_audit_log" USING btree ("merchant_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_audit_log_action_idx" ON "merchant_audit_log" USING btree ("merchant_id","action");
