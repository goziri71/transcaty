/**
 * External payment-rail customer ids per merchant (Tekko endUserId, etc.).
 */
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { merchantProviderLinks, merchants } from "../db/schema/index.js";

export const TEKKO_PROVIDER = "tekko" as const;

export type PaymentProviderId = typeof TEKKO_PROVIDER | string;

export async function getMerchantProviderExternalId(
  merchantId: string,
  provider: PaymentProviderId
): Promise<string | null> {
  const [row] = await db
    .select({ externalCustomerId: merchantProviderLinks.externalCustomerId })
    .from(merchantProviderLinks)
    .where(
      and(
        eq(merchantProviderLinks.merchantId, merchantId),
        eq(merchantProviderLinks.provider, provider)
      )
    )
    .limit(1);

  if (row?.externalCustomerId?.trim()) return row.externalCustomerId.trim();

  // Legacy fallback until migration 0034 backfill has run everywhere.
  if (provider === TEKKO_PROVIDER) {
    const [legacy] = await db
      .select({ tekkoCustomerId: merchants.tekkoCustomerId })
      .from(merchants)
      .where(eq(merchants.id, merchantId))
      .limit(1);
    const legacyId = legacy?.tekkoCustomerId?.trim();
    return legacyId || null;
  }

  return null;
}

export async function setMerchantProviderExternalId(params: {
  merchantId: string;
  provider: PaymentProviderId;
  externalCustomerId: string;
}): Promise<void> {
  const externalCustomerId = params.externalCustomerId.trim();
  if (!externalCustomerId) throw new Error("externalCustomerId required");

  const now = new Date();
  await db
    .insert(merchantProviderLinks)
    .values({
      merchantId: params.merchantId,
      provider: params.provider,
      externalCustomerId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [merchantProviderLinks.merchantId, merchantProviderLinks.provider],
      set: { externalCustomerId, updatedAt: now },
    });
}

export async function findMerchantIdByProviderExternalId(
  provider: PaymentProviderId,
  externalCustomerId: string
): Promise<string | null> {
  const id = externalCustomerId.trim();
  if (!id) return null;

  const [row] = await db
    .select({ merchantId: merchantProviderLinks.merchantId })
    .from(merchantProviderLinks)
    .where(
      and(
        eq(merchantProviderLinks.provider, provider),
        eq(merchantProviderLinks.externalCustomerId, id)
      )
    )
    .limit(1);

  if (row?.merchantId) return row.merchantId;

  if (provider === TEKKO_PROVIDER) {
    const [legacy] = await db
      .select({ id: merchants.id })
      .from(merchants)
      .where(eq(merchants.tekkoCustomerId, id))
      .limit(1);
    return legacy?.id ?? null;
  }

  return null;
}
