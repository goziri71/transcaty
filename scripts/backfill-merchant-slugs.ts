#!/usr/bin/env npx tsx
/** Backfill merchants.slug for rows created before migration 0023; shorten slugs over max length. */
import "dotenv/config";
import { eq, isNull, or, gt, sql } from "drizzle-orm";
import { closeDb, db } from "../src/db/index.js";
import { describeDatabaseTarget, resolveDatabaseUrl } from "../src/lib/db-connection.js";
import { merchants } from "../src/db/schema/index.js";
import {
  MERCHANT_SLUG_MAX_LENGTH,
  allocateMerchantSlug,
} from "../src/lib/merchant-slug.js";

async function main() {
  const target = describeDatabaseTarget(resolveDatabaseUrl());
  console.log(`Using database "${target.database}" on ${target.host}:${target.port}`);

  const rows = await db
    .select({ id: merchants.id, name: merchants.name, slug: merchants.slug })
    .from(merchants)
    .where(
      or(
        isNull(merchants.slug),
        gt(sql`length(${merchants.slug})`, MERCHANT_SLUG_MAX_LENGTH)
      )
    );

  for (const row of rows) {
    const slug = await allocateMerchantSlug(row.name);
    await db.update(merchants).set({ slug, updatedAt: new Date() }).where(eq(merchants.id, row.id));
    console.log(`${row.id} → ${slug}`);
  }
  console.log(`Updated ${rows.length} merchant slug(s).`);
  await closeDb();
}

main().catch(async (e) => {
  const cause = (e as { cause?: { code?: string } })?.cause;
  console.error(e);
  if (cause?.code === "3D000") {
    console.error("");
    console.error("Database does not exist. Run: npm run db:check");
    console.error("Then either createdb transacty (local) or fix DATABASE_URL / DATABASE_URL_ENC in .env.");
  }
  await closeDb().catch(() => undefined);
  process.exit(1);
});
