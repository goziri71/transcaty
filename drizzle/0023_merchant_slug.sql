-- Merchant human-readable slug (unique public id; UUID remains canonical).
ALTER TABLE "merchants" ADD COLUMN IF NOT EXISTS "slug" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "merchants_slug_unique" ON "merchants" ("slug") WHERE "slug" IS NOT NULL;
