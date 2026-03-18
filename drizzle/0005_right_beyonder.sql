CREATE TYPE "public"."provider_user_role" AS ENUM('super_admin', 'ops', 'risk', 'finance', 'support');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"full_name" text,
	"password_hash" text NOT NULL,
	"role" "provider_user_role" DEFAULT 'ops' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_users_email_idx" ON "provider_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_users_role_idx" ON "provider_users" USING btree ("role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_users_status_idx" ON "provider_users" USING btree ("status");