CREATE TYPE "public"."kyc_document_status" AS ENUM('pending', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."kyc_person_role" AS ENUM('director', 'ubo', 'authorized_signatory');--> statement-breakpoint
CREATE TYPE "public"."kyc_profile_status" AS ENUM('draft', 'submitted', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."kyc_status" AS ENUM('pending', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."merchant_user_role" AS ENUM('admin', 'finance', 'viewer');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchant_business_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"legal_name" text NOT NULL,
	"trading_name" text,
	"business_type" text NOT NULL,
	"registration_number" text,
	"incorporation_date" timestamp with time zone,
	"industry" text,
	"registered_address" text NOT NULL,
	"operating_address" text,
	"tax_id" text,
	"contact_phone" text NOT NULL,
	"contact_email" text NOT NULL,
	"status" "kyc_profile_status" DEFAULT 'draft' NOT NULL,
	"verified_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_business_profiles_merchant_id_unique" UNIQUE("merchant_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchant_kyc_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"merchant_person_id" uuid,
	"document_type" text NOT NULL,
	"file_reference" text NOT NULL,
	"document_number" text,
	"status" "kyc_document_status" DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchant_persons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"role" "kyc_person_role" NOT NULL,
	"full_name" text NOT NULL,
	"nationality" text NOT NULL,
	"date_of_birth" timestamp with time zone,
	"id_type" text NOT NULL,
	"id_number" text NOT NULL,
	"address" text NOT NULL,
	"ownership_percentage" numeric(5, 2),
	"status" "kyc_document_status" DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchant_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "merchant_user_role" DEFAULT 'viewer' NOT NULL,
	"merchant_person_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "merchant_business_profiles" ADD CONSTRAINT "merchant_business_profiles_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "merchant_kyc_documents" ADD CONSTRAINT "merchant_kyc_documents_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "merchant_kyc_documents" ADD CONSTRAINT "merchant_kyc_documents_merchant_person_id_merchant_persons_id_fk" FOREIGN KEY ("merchant_person_id") REFERENCES "public"."merchant_persons"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "merchant_persons" ADD CONSTRAINT "merchant_persons_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "merchant_users" ADD CONSTRAINT "merchant_users_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "merchant_users" ADD CONSTRAINT "merchant_users_merchant_person_id_merchant_persons_id_fk" FOREIGN KEY ("merchant_person_id") REFERENCES "public"."merchant_persons"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_business_profiles_merchant_id_idx" ON "merchant_business_profiles" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_business_profiles_status_idx" ON "merchant_business_profiles" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_kyc_documents_merchant_id_idx" ON "merchant_kyc_documents" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_kyc_documents_merchant_id_status_idx" ON "merchant_kyc_documents" USING btree ("merchant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_kyc_documents_merchant_person_id_idx" ON "merchant_kyc_documents" USING btree ("merchant_person_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_persons_merchant_id_idx" ON "merchant_persons" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_persons_merchant_id_role_idx" ON "merchant_persons" USING btree ("merchant_id","role");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_persons_status_idx" ON "merchant_persons" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_users_merchant_id_idx" ON "merchant_users" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_users_email_idx" ON "merchant_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_users_merchant_email_idx" ON "merchant_users" USING btree ("merchant_id","email");