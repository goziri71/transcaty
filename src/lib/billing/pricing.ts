import { db } from "../../db/index.js";
import { merchantPricing } from "../../db/schema/index.js";
import { eq } from "drizzle-orm";

export type BillingMode = "percentage_only" | "monthly_only" | "both";

export interface MerchantPricingRow {
  billingMode: BillingMode;
  feePercentagePayin: string | null;
  feePercentagePayout: string | null;
  feeMinPayin: string | null;
  feeMaxPayin: string | null;
  feeMinPayout: string | null;
  feeMaxPayout: string | null;
  monthlyAmount: string | null;
}

export async function getMerchantPricing(
  merchantId: string
): Promise<MerchantPricingRow | null> {
  const [row] = await db
    .select({
      billingMode: merchantPricing.billingMode,
      feePercentagePayin: merchantPricing.feePercentagePayin,
      feePercentagePayout: merchantPricing.feePercentagePayout,
      feeMinPayin: merchantPricing.feeMinPayin,
      feeMaxPayin: merchantPricing.feeMaxPayin,
      feeMinPayout: merchantPricing.feeMinPayout,
      feeMaxPayout: merchantPricing.feeMaxPayout,
      monthlyAmount: merchantPricing.monthlyAmount,
    })
    .from(merchantPricing)
    .where(eq(merchantPricing.merchantId, merchantId))
    .limit(1);

  return row ?? null;
}
