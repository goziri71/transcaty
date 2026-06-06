-- Least-privilege application role for Transacty API (run as DB superuser / owner).
--
-- Usage (Render Postgres shell or psql):
--   1. Replace passwords before running.
--   2. Run this script once against the target database.
--   3. Point DATABASE_URL at transacty_app (not the owner role).
--
-- See docs/SECURITY_HARDENING.md for Render notes and rollback.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'transacty_app') THEN
    CREATE ROLE transacty_app LOGIN PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE transacty TO transacty_app;

GRANT USAGE ON SCHEMA public TO transacty_app;

-- Application tables: read/write, no DDL.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO transacty_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO transacty_app;

-- Future tables created by migrations (owner role).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO transacty_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO transacty_app;

-- Explicitly deny dangerous capabilities (app role must not own schema).
REVOKE CREATE ON SCHEMA public FROM transacty_app;

-- Migrations run as owner/superuser via drizzle-kit, not transacty_app.
