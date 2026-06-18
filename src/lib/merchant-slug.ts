import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { merchants } from "../db/schema/index.js";

/** Turn "Acme Payments Ltd" → "acme-payments-ltd" */
export function slugifyMerchantName(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "merchant";
}

export async function allocateMerchantSlug(baseName: string): Promise<string> {
  const base = slugifyMerchantName(baseName);
  for (let n = 0; n < 200; n++) {
    const candidate = n === 0 ? base : `${base}-${n}`;
    const [taken] = await db
      .select({ id: merchants.id })
      .from(merchants)
      .where(eq(merchants.slug, candidate))
      .limit(1);
    if (!taken) return candidate;
  }
  return `${base}-${randomBytes(3).toString("hex")}`;
}

export async function ensureMerchantSlug(merchantId: string, name: string): Promise<string> {
  const [row] = await db
    .select({ slug: merchants.slug })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);
  if (row?.slug) return row.slug;
  const slug = await allocateMerchantSlug(name);
  await db.update(merchants).set({ slug, updatedAt: new Date() }).where(eq(merchants.id, merchantId));
  return slug;
}
