#!/usr/bin/env npx tsx
/**
 * Apply merchant compliance + provider link tables (0034) with legacy tekko_* backfill.
 *
 * Usage: npm run db:migrate-merchant-compliance
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { resolveDatabaseUrl } from "../src/lib/db-connection.js";

const MIGRATION_FILE = "0034_merchant_compliance_provider_links.sql";

function loadSql(): string {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle", MIGRATION_FILE);
  return readFileSync(path, "utf8");
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) {
    console.log(`[dry-run] Would apply: drizzle/${MIGRATION_FILE}`);
    console.log(loadSql());
    return;
  }

  const client = new pg.Client({ connectionString: resolveDatabaseUrl() });
  await client.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(loadSql());
      await client.query("COMMIT");
      console.log(`Applied ${MIGRATION_FILE}`);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
