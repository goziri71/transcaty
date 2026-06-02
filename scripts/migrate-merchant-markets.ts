#!/usr/bin/env npx tsx
/**
 * Apply merchant_markets table + seed/backfill (drizzle/0021_merchant_markets.sql).
 *
 * Usage:
 *   npm run db:migrate-merchant-markets
 *   npx tsx scripts/migrate-merchant-markets.ts
 *   npx tsx scripts/migrate-merchant-markets.ts --dry-run
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ensureDbSsl, getSecret } from "../src/lib/encryption.js";

const MIGRATION_FILE = "0021_merchant_markets.sql";

export function merchantMarketsMigrationSqlPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle", MIGRATION_FILE);
}

export function loadMerchantMarketsMigrationSql(): string {
  const path = merchantMarketsMigrationSqlPath();
  return readFileSync(path, "utf8");
}

function connectionString(): string {
  const raw = getSecret("DATABASE_URL", "DATABASE_URL_ENC");
  const base =
    raw ?? (process.env.RENDER ? "" : "postgresql://localhost:5432/transacty");
  if (!base) {
    throw new Error(
      "DATABASE_URL or DATABASE_URL_ENC must be set (e.g. in .env or Render environment)."
    );
  }
  return ensureDbSsl(base);
}

export type RunMerchantMarketsMigrationOptions = {
  /** Log SQL and exit without connecting. */
  dryRun?: boolean;
  /** Custom pg Client (for tests). */
  client?: pg.Client;
};

/**
 * Creates merchant_markets, seeds three markets per merchant, backfills approval from wallets.
 * Safe to re-run: uses IF NOT EXISTS / ON CONFLICT DO NOTHING.
 */
export async function runMerchantMarketsMigration(
  options: RunMerchantMarketsMigrationOptions = {}
): Promise<void> {
  const sql = loadMerchantMarketsMigrationSql();
  const path = merchantMarketsMigrationSqlPath();

  if (options.dryRun) {
    console.log(`[dry-run] Would apply: ${path}`);
    console.log(sql);
    return;
  }

  const ownedClient = options.client == null;
  const client =
    options.client ??
    new pg.Client({
      connectionString: connectionString(),
    });

  if (ownedClient) {
    await client.connect();
  }

  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log(`Applied ${MIGRATION_FILE}`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    if (ownedClient) {
      await client.end();
    }
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  await runMerchantMarketsMigration({ dryRun });
}

const isMain =
  process.argv[1] != null &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
