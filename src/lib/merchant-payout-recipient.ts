import { z } from "zod";

export const merchantPayoutBenificiarySchema = z.object({
  number: z.string(),
  orgId: z.string(),
  orgCode: z.string(),
  orgName: z.string(),
  holderName: z.string(),
});

export const merchantPayoutCardHolderSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  phone: z.string(),
});

export const merchantPayoutRecipientSchema = z.object({
  benificiaryAccountInfo: merchantPayoutBenificiarySchema,
  cardHolderInfo: merchantPayoutCardHolderSchema.optional(),
});

export type MerchantPayoutRecipient = z.infer<typeof merchantPayoutRecipientSchema>;

export function parsePayoutRecipientFromMetadata(
  metadata: string | null
): MerchantPayoutRecipient | null {
  if (!metadata?.trim()) return null;
  try {
    const parsed = JSON.parse(metadata) as {
      benificiaryAccountInfo?: unknown;
      cardHolderInfo?: unknown;
    };
    const benificiary = merchantPayoutBenificiarySchema.safeParse(parsed.benificiaryAccountInfo);
    if (!benificiary.success) return null;
    const cardHolder = merchantPayoutCardHolderSchema.safeParse(parsed.cardHolderInfo);
    return {
      benificiaryAccountInfo: benificiary.data,
      ...(cardHolder.success ? { cardHolderInfo: cardHolder.data } : {}),
    };
  } catch {
    return null;
  }
}
