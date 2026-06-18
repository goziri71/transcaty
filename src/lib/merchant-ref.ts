import { z } from "zod";
import type { FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { merchants } from "../db/schema/index.js";
import { ensureMerchantSlug, isMerchantUuid } from "./merchant-slug.js";

/** Path/query param: UUID or slug (case-insensitive for slug). */
export const merchantRefParamSchema = z.string().min(1).max(64);

export const merchantRefParamsSchema = z.object({
  merchantId: merchantRefParamSchema,
});

export const merchantIdentitySchema = z.object({
  id: z.string(),
  slug: z.string(),
  businessName: z.string(),
  name: z.string(),
  status: z.string(),
  kycStatus: z.string(),
  createdAt: z.string().optional(),
});

export type MerchantRow = typeof merchants.$inferSelect;

export async function resolveMerchantByRef(ref: string): Promise<MerchantRow | null> {
  const trimmed = ref.trim();
  if (!trimmed) return null;

  if (isMerchantUuid(trimmed)) {
    const [row] = await db.select().from(merchants).where(eq(merchants.id, trimmed)).limit(1);
    return row ?? null;
  }

  const slug = trimmed.toLowerCase();
  const [row] = await db.select().from(merchants).where(eq(merchants.slug, slug)).limit(1);
  return row ?? null;
}

export async function resolveMerchantId(ref: string): Promise<string | null> {
  const merchant = await resolveMerchantByRef(ref);
  return merchant?.id ?? null;
}

/** Resolve `:merchantId` route param (UUID or slug). Sends 404 when not found. */
export async function resolveMerchantParam(
  merchantRef: string,
  reply: FastifyReply
): Promise<{ merchantId: string; merchant: MerchantRow } | null> {
  const merchant = await resolveMerchantByRef(merchantRef);
  if (!merchant) {
    reply.status(404).send({ error: "Not found", message: "Merchant not found" });
    return null;
  }
  return { merchantId: merchant.id, merchant };
}

export async function buildMerchantIdentity(
  merchant: Pick<MerchantRow, "id" | "slug" | "name" | "status" | "kycStatus" | "createdAt">
): Promise<{
  id: string;
  slug: string;
  businessName: string;
  name: string;
  status: string;
  kycStatus: string;
  createdAt: string;
}> {
  const slug = merchant.slug ?? (await ensureMerchantSlug(merchant.id, merchant.name));
  return {
    id: merchant.id,
    slug,
    businessName: merchant.name,
    name: merchant.name,
    status: merchant.status,
    kycStatus: merchant.kycStatus ?? "pending",
    createdAt: merchant.createdAt.toISOString(),
  };
}
