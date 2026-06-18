CREATE TABLE IF NOT EXISTS "fx_rate_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "product" text NOT NULL,
  "settled_currency" text NOT NULL,
  "network_symbol" text,
  "quote_currency" text,
  "source" text NOT NULL DEFAULT 'manual_fixed',
  "manual_rate" numeric(18, 8),
  "spread_bps" integer NOT NULL DEFAULT 0,
  "spread_mode" text NOT NULL DEFAULT 'on_output',
  "effective_from" timestamp with time zone NOT NULL DEFAULT now(),
  "effective_to" timestamp with time zone,
  "status" text NOT NULL DEFAULT 'active',
  "created_by" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fx_rate_profiles_lookup_idx"
  ON "fx_rate_profiles" ("product", "settled_currency", "status", "effective_from");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchant_fx_overrides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "merchant_id" uuid NOT NULL REFERENCES "merchants"("id") ON DELETE CASCADE,
  "environment" text NOT NULL,
  "product" text NOT NULL,
  "settled_currency" text NOT NULL,
  "network_symbol" text,
  "spread_bps_override" integer,
  "manual_rate_override" numeric(18, 8),
  "disabled" boolean NOT NULL DEFAULT false,
  "effective_from" timestamp with time zone NOT NULL DEFAULT now(),
  "effective_to" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "merchant_fx_overrides_uniq"
  ON "merchant_fx_overrides" (
    "merchant_id",
    "environment",
    "product",
    "settled_currency",
    COALESCE("network_symbol", '')
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_fx_overrides_merchant_idx"
  ON "merchant_fx_overrides" ("merchant_id", "environment");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchant_fee_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "merchant_id" uuid NOT NULL REFERENCES "merchants"("id") ON DELETE CASCADE,
  "environment" text NOT NULL,
  "rail" text NOT NULL,
  "currency" text NOT NULL,
  "fee_type" text NOT NULL,
  "billing_mode" text NOT NULL DEFAULT 'percentage_only',
  "fee_percentage" numeric(5, 4) DEFAULT '0',
  "fee_flat" numeric(18, 2) DEFAULT '0',
  "fee_min" numeric(18, 2) DEFAULT '0',
  "fee_max" numeric(18, 2),
  "effective_from" timestamp with time zone NOT NULL DEFAULT now(),
  "effective_to" timestamp with time zone,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "merchant_fee_schedules_lookup_idx"
  ON "merchant_fee_schedules" (
    "merchant_id",
    "environment",
    "rail",
    "currency",
    "fee_type",
    "status",
    "effective_from"
  );
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "merchant_api_ip_rules" (
  "merchant_id" uuid NOT NULL REFERENCES "merchants"("id") ON DELETE CASCADE,
  "environment" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT false,
  "enforce_mode" text NOT NULL DEFAULT 'strict',
  "cidrs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "notes" text,
  "updated_by" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("merchant_id", "environment")
);
--> statement-breakpoint
INSERT INTO "merchant_fee_schedules" (
  "merchant_id", "environment", "rail", "currency", "fee_type",
  "billing_mode", "fee_percentage", "fee_flat", "fee_min", "fee_max",
  "effective_from", "status", "created_at", "updated_at"
)
SELECT mp.merchant_id, 'test', 'bangladesh', 'BDT', 'payin',
  mp.billing_mode, COALESCE(mp.fee_percentage_payin, 0), 0,
  COALESCE(mp.fee_min_payin, 0), mp.fee_max_payin,
  COALESCE(mp.effective_at, now()), 'active', now(), now()
FROM "merchant_pricing" mp
WHERE mp.merchant_id != '00000000-0000-0000-0000-000000000001'
  AND NOT EXISTS (
    SELECT 1 FROM "merchant_fee_schedules" s
    WHERE s.merchant_id = mp.merchant_id AND s.environment = 'test'
      AND s.rail = 'bangladesh' AND s.currency = 'BDT' AND s.fee_type = 'payin'
  );
--> statement-breakpoint
INSERT INTO "merchant_fee_schedules" (
  "merchant_id", "environment", "rail", "currency", "fee_type",
  "billing_mode", "fee_percentage", "fee_flat", "fee_min", "fee_max",
  "effective_from", "status", "created_at", "updated_at"
)
SELECT mp.merchant_id, 'test', 'bangladesh', 'BDT', 'payout',
  mp.billing_mode, COALESCE(mp.fee_percentage_payout, 0), 0,
  COALESCE(mp.fee_min_payout, 0), mp.fee_max_payout,
  COALESCE(mp.effective_at, now()), 'active', now(), now()
FROM "merchant_pricing" mp
WHERE mp.merchant_id != '00000000-0000-0000-0000-000000000001'
  AND NOT EXISTS (
    SELECT 1 FROM "merchant_fee_schedules" s
    WHERE s.merchant_id = mp.merchant_id AND s.environment = 'test'
      AND s.rail = 'bangladesh' AND s.currency = 'BDT' AND s.fee_type = 'payout'
  );
--> statement-breakpoint
INSERT INTO "merchant_fee_schedules" (
  "merchant_id", "environment", "rail", "currency", "fee_type",
  "billing_mode", "fee_percentage", "fee_flat", "fee_min", "fee_max",
  "effective_from", "status", "created_at", "updated_at"
)
SELECT mp.merchant_id, 'live', 'bangladesh', 'BDT', 'payin',
  mp.billing_mode, COALESCE(mp.fee_percentage_payin, 0), 0,
  COALESCE(mp.fee_min_payin, 0), mp.fee_max_payin,
  COALESCE(mp.effective_at, now()), 'active', now(), now()
FROM "merchant_pricing" mp
WHERE mp.merchant_id != '00000000-0000-0000-0000-000000000001'
  AND NOT EXISTS (
    SELECT 1 FROM "merchant_fee_schedules" s
    WHERE s.merchant_id = mp.merchant_id AND s.environment = 'live'
      AND s.rail = 'bangladesh' AND s.currency = 'BDT' AND s.fee_type = 'payin'
  );
--> statement-breakpoint
INSERT INTO "merchant_fee_schedules" (
  "merchant_id", "environment", "rail", "currency", "fee_type",
  "billing_mode", "fee_percentage", "fee_flat", "fee_min", "fee_max",
  "effective_from", "status", "created_at", "updated_at"
)
SELECT mp.merchant_id, 'live', 'bangladesh', 'BDT', 'payout',
  mp.billing_mode, COALESCE(mp.fee_percentage_payout, 0), 0,
  COALESCE(mp.fee_min_payout, 0), mp.fee_max_payout,
  COALESCE(mp.effective_at, now()), 'active', now(), now()
FROM "merchant_pricing" mp
WHERE mp.merchant_id != '00000000-0000-0000-0000-000000000001'
  AND NOT EXISTS (
    SELECT 1 FROM "merchant_fee_schedules" s
    WHERE s.merchant_id = mp.merchant_id AND s.environment = 'live'
      AND s.rail = 'bangladesh' AND s.currency = 'BDT' AND s.fee_type = 'payout'
  );
