-- Ledger immutability. ledger_entries is the source of truth for money
-- movement; we want database-level enforcement that nothing in the
-- application layer can tamper with prior entries.
--
-- 1. Block UPDATE and DELETE on ledger_entries via trigger. An escape
--    hatch is provided via the session variable `app.allow_ledger_mutation`
--    so DBA-supervised data fixes are still possible (e.g. via psql with
--    `SET LOCAL app.allow_ledger_mutation = 'true'`).
-- 2. Replace the wallets -> ledger_entries CASCADE with RESTRICT so
--    deleting a wallet cannot silently wipe its audit trail.

CREATE OR REPLACE FUNCTION enforce_ledger_immutability() RETURNS trigger AS $$
DECLARE
  override text;
BEGIN
  BEGIN
    override := current_setting('app.allow_ledger_mutation', true);
  EXCEPTION WHEN others THEN
    override := NULL;
  END;
  IF override = 'true' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'ledger_entries is append-only (set app.allow_ledger_mutation=true to override)'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS ledger_entries_no_update ON "ledger_entries";
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_update
BEFORE UPDATE ON "ledger_entries"
FOR EACH ROW EXECUTE FUNCTION enforce_ledger_immutability();
--> statement-breakpoint

DROP TRIGGER IF EXISTS ledger_entries_no_delete ON "ledger_entries";
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_delete
BEFORE DELETE ON "ledger_entries"
FOR EACH ROW EXECUTE FUNCTION enforce_ledger_immutability();
--> statement-breakpoint

ALTER TABLE "ledger_entries" DROP CONSTRAINT IF EXISTS "ledger_entries_wallet_id_wallets_id_fk";
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_wallet_id_wallets_id_fk"
  FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
