ALTER TABLE "merchant_users" ADD COLUMN IF NOT EXISTS "mfa_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_users" ADD COLUMN IF NOT EXISTS "mfa_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_users" ADD COLUMN IF NOT EXISTS "mfa_secret_enc" text;--> statement-breakpoint
ALTER TABLE "provider_users" ADD COLUMN IF NOT EXISTS "mfa_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_users" ADD COLUMN IF NOT EXISTS "mfa_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_users" ADD COLUMN IF NOT EXISTS "mfa_secret_enc" text;
