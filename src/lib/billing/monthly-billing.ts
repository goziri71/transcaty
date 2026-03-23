import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  ledgerEntries,
  merchantPricing,
  monthlyBillingRecords,
  wallets,
} from "../../db/schema/index.js";
import { PLATFORM_WALLET_ID } from "./platform-wallet.js";
import { audit } from "../audit.js";

/**
 * Run monthly billing for merchants with monthly_only or both mode.
 * Bills for the current month (YYYY-MM). Skips if already billed.
 */
export async function runMonthlyBilling(): Promise<{
  billed: number;
  skipped: number;
  errors: string[];
}> {
  const now = new Date();
  const billingMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const pricingRows = await db
    .select()
    .from(merchantPricing)
    .where(inArray(merchantPricing.billingMode, ["monthly_only", "both"]));

  const monthlyMerchants = pricingRows.filter(
    (p) => p.monthlyAmount && Number(p.monthlyAmount) > 0
  );

  let billed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const pricing of monthlyMerchants) {
    const merchantId = pricing.merchantId;
    const amount = Number(pricing.monthlyAmount ?? 0);
    if (amount <= 0) continue;

    const [existing] = await db
      .select()
      .from(monthlyBillingRecords)
      .where(
        and(
          eq(monthlyBillingRecords.merchantId, merchantId),
          eq(monthlyBillingRecords.billingMonth, billingMonth)
        )
      )
      .limit(1);

    if (existing) {
      skipped++;
      continue;
    }

    const [merchantWallet] = await db
      .select()
      .from(wallets)
      .where(
        and(
          eq(wallets.merchantId, merchantId),
          eq(wallets.type, "merchant"),
          eq(wallets.status, "active")
        )
      )
      .limit(1);

    if (!merchantWallet) {
      errors.push(`Merchant ${merchantId}: wallet not found`);
      continue;
    }

    const balance = Number(merchantWallet.balance);
    if (balance < amount) {
      errors.push(`Merchant ${merchantId}: insufficient balance (${balance} < ${amount})`);
      continue;
    }

    try {
      await db.transaction(async (tx) => {
        const refId = `monthly:${merchantId}:${billingMonth}`;

        const [creditEntry] = await tx
          .insert(ledgerEntries)
          .values({
            walletId: PLATFORM_WALLET_ID,
            amount: String(amount),
            direction: "credit",
            type: "monthly_fee",
            referenceId: refId,
          })
          .returning();

        await tx
          .insert(ledgerEntries)
          .values({
            walletId: merchantWallet.id,
            amount: String(amount),
            direction: "debit",
            type: "monthly_fee",
            referenceId: refId,
          });

        await tx
          .update(wallets)
          .set({
            balance: String(balance - amount),
            updatedAt: new Date(),
          })
          .where(eq(wallets.id, merchantWallet.id));

        const [plat] = await tx
          .select({ balance: wallets.balance })
          .from(wallets)
          .where(eq(wallets.id, PLATFORM_WALLET_ID))
          .limit(1);
        const platBalance = plat ? Number(plat.balance) : 0;
        await tx
          .update(wallets)
          .set({
            balance: String(platBalance + amount),
            updatedAt: new Date(),
          })
          .where(eq(wallets.id, PLATFORM_WALLET_ID));

        await tx.insert(monthlyBillingRecords).values({
          merchantId,
          billingMonth,
          amount: String(amount),
          ledgerEntryId: creditEntry?.id ?? null,
        });
      });

      billed++;
      audit({
        action: "billing.fee_applied",
        resource: merchantId,
        meta: { type: "monthly", billingMonth, amount: String(amount) },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Merchant ${merchantId}: ${msg}`);
    }
  }

  return { billed, skipped, errors };
}
