-- Platform revenue wallets for Brazil (BRL) fee collection — test + live
INSERT INTO "wallets" ("id", "merchant_id", "type", "environment", "balance", "currency", "status", "created_at", "updated_at")
VALUES
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'merchant', 'test', 0, 'BRL', 'active', now(), now()),
  ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', 'merchant', 'live', 0, 'BRL', 'active', now(), now())
ON CONFLICT (id) DO NOTHING;
