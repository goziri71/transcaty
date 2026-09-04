#!/usr/bin/env npx tsx
/**
 * Apply payout PIN columns + reset-token table (0031, 0032).
 *
 * Usage: npm run db:migrate-payout-pin
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { resolveDatabaseUrl } from "../src/lib/db-connection.js";

const MIGRATION_FILES = ["0031_merchant_payout_pin.sql", "0032_merchant_payout_pin_reset.sql"] as const;

function loadSql(file: string): string {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle", file);
  return readFileSync(path, "utf8");
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const client = new pg.Client({ connectionString: resolveDatabaseUrl() });

  if (dryRun) {
    for (const file of MIGRATION_FILES) {
      console.log(`[dry-run] Would apply: drizzle/${file}`);
      console.log(loadSql(file));
    }
    return;
  }

  await client.connect();
  try {
    for (const file of MIGRATION_FILES) {
      await client.query("BEGIN");
      try {
        await client.query(loadSql(file));
        await client.query("COMMIT");
        console.log(`Applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
