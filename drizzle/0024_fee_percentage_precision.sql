-- fee_percentage was numeric(5,4) → max 9.9999; product uses whole percents (10 = 10%).
ALTER TABLE "merchant_fee_schedules"
  ALTER COLUMN "fee_percentage" TYPE numeric(6, 4);
--> statement-breakpoint
ALTER TABLE "merchant_pricing"
  ALTER COLUMN "fee_percentage_payin" TYPE numeric(6, 4);
--> statement-breakpoint
ALTER TABLE "merchant_pricing"
  ALTER COLUMN "fee_percentage_payout" TYPE numeric(6, 4);
