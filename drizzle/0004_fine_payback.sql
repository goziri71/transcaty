ALTER TYPE "public"."transaction_type" ADD VALUE 'refund';--> statement-breakpoint
ALTER TYPE "public"."wallet_status" ADD VALUE 'pending' BEFORE 'closed';--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "wallet_id" uuid;--> statement-breakpoint
ALTER TABLE "wallets" ADD COLUMN "label" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_wallet_id_idx" ON "transactions" USING btree ("wallet_id");