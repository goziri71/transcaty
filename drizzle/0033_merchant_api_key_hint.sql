-- Display suffix for API key list (last 8 chars of plaintext key at creation; never the full key).
ALTER TABLE "merchant_api_keys" ADD COLUMN IF NOT EXISTS "key_hint" text;
