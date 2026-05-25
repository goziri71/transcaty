/**
 * Build TL Pay `merchantDetails` for EU Open Banking create calls.
 */
import { eq } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { merchantBusinessProfiles, merchants } from "../../../src/db/schema/index.js";

export type TyltEurMerchantDetails = {
  merchantName: string;
  merchantUrl: string;
  merchantInternalId: string;
};

export class EurMerchantDetailsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EurMerchantDetailsError";
  }
}

export async function resolveTyltEurMerchantDetails(params: {
  merchantId: string;
  merchantUrl?: string;
  merchantDetails?: {
    merchantName?: string;
    merchantUrl?: string;
    merchantInternalId?: string;
  };
}): Promise<TyltEurMerchantDetails> {
  const override = params.merchantDetails;
  if (override?.merchantName?.trim() && override?.merchantUrl?.trim() && override?.merchantInternalId?.trim()) {
    const merchantUrl = override.merchantUrl.trim();
    if (!merchantUrl.startsWith("https://")) {
      throw new EurMerchantDetailsError("merchantUrl must be a valid HTTPS URL");
    }
    return {
      merchantName: override.merchantName.trim(),
      merchantUrl,
      merchantInternalId: override.merchantInternalId.trim(),
    };
  }

  const [merchant] = await db
    .select({ name: merchants.name })
    .from(merchants)
    .where(eq(merchants.id, params.merchantId))
    .limit(1);

  const [profile] = await db
    .select({ legalName: merchantBusinessProfiles.legalName })
    .from(merchantBusinessProfiles)
    .where(eq(merchantBusinessProfiles.merchantId, params.merchantId))
    .limit(1);

  const merchantName = override?.merchantName?.trim() || profile?.legalName?.trim() || merchant?.name?.trim();
  const merchantUrl = override?.merchantUrl?.trim() || params.merchantUrl?.trim();
  const merchantInternalId = override?.merchantInternalId?.trim() || params.merchantId;

  if (!merchantName) {
    throw new EurMerchantDetailsError(
      "merchantDetails.merchantName is required (submit KYC business profile or pass merchantDetails)"
    );
  }
  if (!merchantUrl || !merchantUrl.startsWith("https://")) {
    throw new EurMerchantDetailsError(
      "merchantUrl is required as HTTPS (pass merchantUrl or merchantDetails.merchantUrl)"
    );
  }

  return { merchantName, merchantUrl, merchantInternalId };
}
