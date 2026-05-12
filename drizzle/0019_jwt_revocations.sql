-- JWT revocation list (P4 Auth Hardening).
--
-- We sign access tokens with a `jti` (JWT id). On logout, MFA token
-- exchange, or admin-initiated session kill, we insert the jti here.
-- Auth middleware checks this list (via an in-process TTL cache) on
-- every request and rejects revoked tokens.
--
-- `expires_at` mirrors the original token's `exp` claim so we can
-- safely garbage-collect rows whose tokens have already expired.
CREATE TABLE IF NOT EXISTS "jwt_revocations" (
  "jti" text PRIMARY KEY NOT NULL,
  "realm" text NOT NULL,
  "subject_id" uuid,
  "reason" text,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jwt_revocations_realm_idx" ON "jwt_revocations" USING btree ("realm");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jwt_revocations_subject_idx" ON "jwt_revocations" USING btree ("subject_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jwt_revocations_expires_at_idx" ON "jwt_revocations" USING btree ("expires_at");
