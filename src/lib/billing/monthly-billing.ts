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
import { addAmount, cmpAmount, subAmount, toCents } from "../money.js";

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

  const monthlyMerchants = pricingRows.filter((p) => {
    const v = p.monthlyAmount;
    return typeof v === "string" && v.length > 0 && toCents(v) > 0n;
  });

  let billed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const pricing of monthlyMerchants) {
    const merchantId = pricing.merchantId;
    const amount = String(pricing.monthlyAmount ?? "0");
    if (toCents(amount) <= 0n) continue;

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

    try {
      const result = await db.transaction(async (tx) => {
        const [merchantWallet] = await tx
          .select()
          .from(wallets)
          .where(
            and(
              eq(wallets.merchantId, merchantId),
              eq(wallets.environment, "live"),
              eq(wallets.type, "merchant"),
              eq(wallets.status, "active")
            )
          )
          .for("update")
          .limit(1);

        if (!merchantWallet) {
          return { kind: "wallet_missing" as const };
        }

        if (cmpAmount(merchantWallet.balance, amount) < 0) {
          return {
            kind: "insufficient_balance" as const,
            balance: merchantWallet.balance,
          };
        }

        const [platformWallet] = await tx
          .select()
          .from(wallets)
          .where(eq(wallets.id, PLATFORM_WALLET_ID))
          .for("update")
          .limit(1);

        if (!platformWallet) {
          return { kind: "platform_wallet_missing" as const };
        }

        const refId = `monthly:${merchantId}:${billingMonth}`;

        const [creditEntry] = await tx
          .insert(ledgerEntries)
          .values({
            walletId: platformWallet.id,
            environment: "live",
            amount,
            direction: "credit",
            type: "monthly_fee",
            referenceId: refId,
          })
          .returning();

        await tx.insert(ledgerEntries).values({
          walletId: merchantWallet.id,
          environment: "live",
          amount,
          direction: "debit",
          type: "monthly_fee",
          referenceId: refId,
        });

        await tx
          .update(wallets)
          .set({
            balance: subAmount(merchantWallet.balance, amount),
            updatedAt: new Date(),
          })
          .where(eq(wallets.id, merchantWallet.id));

        await tx
          .update(wallets)
          .set({
            balance: addAmount(platformWallet.balance, amount),
            updatedAt: new Date(),
          })
          .where(eq(wallets.id, platformWallet.id));

        await tx.insert(monthlyBillingRecords).values({
          merchantId,
          billingMonth,
          amount,
          ledgerEntryId: creditEntry?.id ?? null,
        });

        return { kind: "billed" as const };
      });

      if (result.kind === "wallet_missing") {
        errors.push(`Merchant ${merchantId}: wallet not found`);
        continue;
      }
      if (result.kind === "platform_wallet_missing") {
        errors.push(`Merchant ${merchantId}: platform wallet not found`);
        continue;
      }
      if (result.kind === "insufficient_balance") {
        errors.push(`Merchant ${merchantId}: insufficient balance (${result.balance} < ${amount})`);
        continue;
      }

      billed++;
      audit({
        action: "billing.fee_applied",
        resource: merchantId,
        merchantId,
        meta: { type: "monthly", billingMonth, amount },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Merchant ${merchantId}: ${msg}`);
    }
  }

  return { billed, skipped, errors };
}
