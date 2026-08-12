#!/usr/bin/env npx tsx
/**
 * Apply merchant_webhook_deliveries table (drizzle/0028_merchant_webhook_deliveries.sql).
 *
 * Usage:
 *   npx tsx scripts/migrate-merchant-webhook-deliveries.ts
 *   npx tsx scripts/migrate-merchant-webhook-deliveries.ts --dry-run
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { resolveDatabaseUrl } from "../src/lib/db-connection.js";

const MIGRATION_FILE = "0028_merchant_webhook_deliveries.sql";

export async function runMerchantWebhookDeliveriesMigration(options: {
  dryRun?: boolean;
} = {}): Promise<void> {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle", MIGRATION_FILE);
  const sql = readFileSync(path, "utf8");
  if (options.dryRun) {
    console.log(`[dry-run] Would apply: ${path}`);
    console.log(sql);
    return;
  }
  const client = new pg.Client({ connectionString: resolveDatabaseUrl() });
  await client.connect();
  try {
    await client.query(sql);
    console.log(`Applied ${MIGRATION_FILE}`);
  } finally {
    await client.end();
  }
}

const isMain = process.argv[1]?.includes("migrate-merchant-webhook-deliveries");
if (isMain) {
  runMerchantWebhookDeliveriesMigration({ dryRun: process.argv.includes("--dry-run") }).catch(
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}
