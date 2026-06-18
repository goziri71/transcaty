#!/usr/bin/env npx tsx
/**
 * Print which database migrate/scripts will use and verify connectivity.
 *
 * Usage: npm run db:check
 */
import "dotenv/config";
import pg from "pg";
import {
  describeDatabaseTarget,
  isLocalDefaultUrl,
  resolveDatabaseUrl,
} from "../src/lib/db-connection.js";

async function main() {
  const url = resolveDatabaseUrl();
  const target = describeDatabaseTarget(url);

  console.log("Database target (from DATABASE_URL or decrypted DATABASE_URL_ENC):");
  console.log(`  host:     ${target.host}`);
  console.log(`  port:     ${target.port}`);
  console.log(`  database: ${target.database}`);
  console.log(`  user:     ${target.user}`);

  const plain = process.env.DATABASE_URL?.trim();
  const hasEnc = !!process.env.DATABASE_URL_ENC?.trim();
  if (plain && hasEnc && isLocalDefaultUrl(plain) && !isLocalDefaultUrl(url)) {
    console.log("");
    console.log(
      "Note: plain DATABASE_URL looks like the localhost placeholder; decrypted DATABASE_URL_ENC is used when plain is unset or encrypted."
    );
  } else if (plain && hasEnc && isLocalDefaultUrl(url)) {
    console.log("");
    console.warn(
      "Warning: using localhost/transacty from plain DATABASE_URL. If your real DB is in DATABASE_URL_ENC, remove or comment out the placeholder DATABASE_URL line in .env."
    );
  }

  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    const r = await client.query("select current_database() as db, version()");
    console.log("");
    console.log(`Connected OK → database "${r.rows[0]?.db}"`);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error("");
    console.error("Connection failed:", e.message ?? err);
    if (e.code === "3D000") {
      console.error("");
      console.error("The database does not exist on that server.");
      if (target.host === "localhost" || target.host === "127.0.0.1") {
        console.error("Local fix:  createdb transacty");
        console.error("Or point .env at your remote Postgres (see DATABASE_URL / DATABASE_URL_ENC).");
      } else {
        console.error("Create the database on your host or fix the database name in DATABASE_URL.");
      }
    }
    process.exit(1);
  } finally {
    await client.end().catch(() => undefined);
  }
}

main();
