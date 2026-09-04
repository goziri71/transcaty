#!/usr/bin/env npx tsx
/** Apply merchant_api_keys.key_hint (0033). Usage: npm run db:migrate-api-key-hint */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { resolveDatabaseUrl } from "../src/lib/db-connection.js";

const FILE = "0033_merchant_api_key_hint.sql";

async function main(): Promise<void> {
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle", FILE), "utf8");
  const client = new pg.Client({ connectionString: resolveDatabaseUrl() });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log(`Applied ${FILE}`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
