-- Session epoch for provider revoke-all: bump to invalidate JWTs that carry sv.
-- Mirrors 0026_merchant_session_version.sql for the portal realm.
ALTER TABLE "provider_users" ADD COLUMN IF NOT EXISTS "session_version" integer NOT NULL DEFAULT 0;
