-- Platform merchant and wallet for fee collection
-- Uses fixed UUID for deterministic lookup
INSERT INTO "merchants" ("id", "name", "status", "kyc_status", "created_at", "updated_at")
VALUES ('00000000-0000-0000-0000-000000000001', 'Transcaty Platform', 'active', 'verified', now(), now())
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO "wallets" ("id", "merchant_id", "type", "balance", "currency", "status", "created_at", "updated_at")
VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'merchant', 0, 'BDT', 'active', now(), now())
ON CONFLICT (id) DO NOTHING;
