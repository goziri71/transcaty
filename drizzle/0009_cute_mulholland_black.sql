CREATE TYPE "public"."billing_mode" AS ENUM('percentage_only', 'monthly_only', 'both');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchant_pricing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"billing_mode" "billing_mode" DEFAULT 'percentage_only' NOT NULL,
	"fee_percentage_payin" numeric(5, 4) DEFAULT '0',
	"fee_percentage_payout" numeric(5, 4) DEFAULT '0',
	"fee_min_payin" numeric(18, 2) DEFAULT '0',
	"fee_max_payin" numeric(18, 2),
	"fee_min_payout" numeric(18, 2) DEFAULT '0',
	"fee_max_payout" numeric(18, 2),
	"monthly_amount" numeric(18, 2) DEFAULT '0',
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchant_pricing_merchant_id_unique" UNIQUE("merchant_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monthly_billing_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"billing_month" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"ledger_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monthly_billing_records_merchant_id_billing_month_unique" UNIQUE("merchant_id","billing_month")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "merchant_pricing" ADD CONSTRAINT "merchant_pricing_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monthly_billing_records" ADD CONSTRAINT "monthly_billing_records_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monthly_billing_records" ADD CONSTRAINT "monthly_billing_records_ledger_entry_id_ledger_entries_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_pricing_merchant_id_idx" ON "merchant_pricing" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monthly_billing_records_merchant_month_idx" ON "monthly_billing_records" USING btree ("merchant_id","billing_month");
