#!/usr/bin/env npx tsx
/** Backfill merchants.slug for rows created before migration 0023. */
import "dotenv/config";
import { eq, isNull } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { merchants } from "../src/db/schema/index.js";
import { allocateMerchantSlug } from "../src/lib/merchant-slug.js";

async function main() {
  const rows = await db
    .select({ id: merchants.id, name: merchants.name })
    .from(merchants)
    .where(isNull(merchants.slug));

  for (const row of rows) {
    const slug = await allocateMerchantSlug(row.name);
    await db.update(merchants).set({ slug, updatedAt: new Date() }).where(eq(merchants.id, row.id));
    console.log(`${row.id} → ${slug}`);
  }
  console.log(`Backfilled ${rows.length} merchant slug(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
