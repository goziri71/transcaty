-- Session epoch for portal revoke-all: bump to invalidate JWTs that carry sv.
ALTER TABLE "merchant_users" ADD COLUMN IF NOT EXISTS "session_version" integer NOT NULL DEFAULT 0;
