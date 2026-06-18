import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { merchants } from "../db/schema/index.js";

/** Max slug length (total, including collision suffix). */
export const MERCHANT_SLUG_MAX_LENGTH = 32;

/** Max base segment derived from business name before collision suffix. */
export const MERCHANT_SLUG_BASE_MAX = 24;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isMerchantUuid(ref: string): boolean {
  return UUID_RE.test(ref.trim());
}

function trimSlug(candidate: string): string {
  if (candidate.length <= MERCHANT_SLUG_MAX_LENGTH) return candidate;
  const trimmed = candidate.slice(0, MERCHANT_SLUG_MAX_LENGTH).replace(/-+$/, "");
  return trimmed || "merchant";
}

/** Turn "Acme Payments Ltd" → "acme-payments-ltd" (max 24 chars base). */
export function slugifyMerchantName(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MERCHANT_SLUG_BASE_MAX);
  return trimSlug(base || "merchant");
}

export async function allocateMerchantSlug(baseName: string): Promise<string> {
  const base = slugifyMerchantName(baseName);
  for (let n = 0; n < 200; n++) {
    const candidate = trimSlug(n === 0 ? base : `${base}-${n}`);
    const [taken] = await db
      .select({ id: merchants.id })
      .from(merchants)
      .where(eq(merchants.slug, candidate))
      .limit(1);
    if (!taken) return candidate;
  }
  return trimSlug(`${base.slice(0, 16)}-${randomBytes(2).toString("hex")}`);
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
