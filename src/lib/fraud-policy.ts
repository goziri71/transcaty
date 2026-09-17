/**
 * Merchant fraud & velocity policy (Bangladesh BDT flows + shared payin/payout gates).
 * Limits are disabled when env is unset or 0.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { merchantBlacklist, transactions } from "../db/schema/index.js";
import { audit } from "./audit.js";

export class FraudPolicyRejectedError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "FraudPolicyRejectedError";
  }
}

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}

export function fraudPolicyConfig() {
  return {
    maxPayinsPerHour: envInt("FRAUD_MAX_PAYINS_PER_HOUR", 0),
    maxPayoutsPerRecipientPerDay: envInt("FRAUD_MAX_PAYOUTS_PER_RECIPIENT_PER_DAY", 0),
    coolingPeriodHours: envInt("FRAUD_COOLING_PERIOD_HOURS", 0),
    maxPayoutAmountPerDayBdt: envInt("FRAUD_MAX_PAYOUT_AMOUNT_PER_DAY_BDT", 0),
  };
}

function normalizeValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

export async function assertNotBlacklisted(params: {
  merchantId: string;
  environment: "test" | "live";
  phone?: string;
  email?: string;
  accountNumber?: string;
}): Promise<void> {
  const checks: { entryType: "phone" | "email" | "account"; value: string }[] = [];
  if (params.phone?.trim()) checks.push({ entryType: "phone", value: normalizeValue(params.phone) });
  if (params.email?.trim()) checks.push({ entryType: "email", value: normalizeValue(params.email) });
  if (params.accountNumber?.trim()) {
    checks.push({ entryType: "account", value: normalizeValue(params.accountNumber) });
  }
  if (checks.length === 0) return;

  for (const c of checks) {
    const [hit] = await db
      .select({ id: merchantBlacklist.id })
      .from(merchantBlacklist)
      .where(
        and(
          eq(merchantBlacklist.merchantId, params.merchantId),
          eq(merchantBlacklist.environment, params.environment),
          eq(merchantBlacklist.entryType, c.entryType),
          eq(merchantBlacklist.valueNormalized, c.value)
        )
      )
      .limit(1);
    if (hit) {
      throw new FraudPolicyRejectedError(
        "This payment is not permitted due to a risk policy on your account.",
        "blacklisted"
      );
    }
  }
}

export async function assertPayinVelocityAllowed(params: {
  merchantId: string;
  environment: "test" | "live";
}): Promise<void> {
  const { maxPayinsPerHour } = fraudPolicyConfig();
  if (maxPayinsPerHour <= 0) return;

  const since = new Date(Date.now() - 60 * 60 * 1000);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(transactions)
    .where(
      and(
        eq(transactions.merchantId, params.merchantId),
        eq(transactions.environment, params.environment),
        eq(transactions.type, "payin"),
        gte(transactions.createdAt, since)
      )
    );

  const count = Number(row?.count ?? 0);
  if (count >= maxPayinsPerHour) {
    throw new FraudPolicyRejectedError(
      `Pay-in limit reached (${maxPayinsPerHour} per hour). Try again later.`,
      "payin_velocity_exceeded"
    );
  }
}

export async function assertPayoutAllowed(params: {
  merchantId: string;
  environment: "test" | "live";
  amount: string;
  beneficiaryAccountNumber: string;
  payerPhone?: string;
  payerEmail?: string;
}): Promise<void> {
  const cfg = fraudPolicyConfig();

  await assertNotBlacklisted({
    merchantId: params.merchantId,
    environment: params.environment,
    phone: params.payerPhone,
    email: params.payerEmail,
    accountNumber: params.beneficiaryAccountNumber,
  });

  if (cfg.coolingPeriodHours > 0) {
    const since = new Date(Date.now() - cfg.coolingPeriodHours * 60 * 60 * 1000);
    const [recentPayin] = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.merchantId, params.merchantId),
          eq(transactions.environment, params.environment),
          eq(transactions.type, "payin"),
          eq(transactions.status, "success"),
          eq(transactions.currency, "BDT"),
          gte(transactions.updatedAt, since)
        )
      )
      .limit(1);
    if (recentPayin) {
      throw new FraudPolicyRejectedError(
        `Payouts are blocked for ${cfg.coolingPeriodHours} hour(s) after a successful pay-in.`,
        "cooling_period"
      );
    }
  }

  if (cfg.maxPayoutsPerRecipientPerDay > 0) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const acct = normalizeValue(params.beneficiaryAccountNumber);
    const rows = await db
      .select({ metadata: transactions.metadata })
      .from(transactions)
      .where(
        and(
          eq(transactions.merchantId, params.merchantId),
          eq(transactions.environment, params.environment),
          eq(transactions.type, "payout"),
          gte(transactions.createdAt, since)
        )
      );
    let recipientCount = 0;
    for (const r of rows) {
      if (!r.metadata) continue;
      try {
        const meta = JSON.parse(r.metadata) as {
          benificiaryAccountInfo?: { number?: string };
        };
        const num = meta.benificiaryAccountInfo?.number;
        if (num && normalizeValue(num) === acct) recipientCount += 1;
      } catch {
        /* ignore */
      }
    }
    if (recipientCount >= cfg.maxPayoutsPerRecipientPerDay) {
      throw new FraudPolicyRejectedError(
        `Payout limit for this recipient reached (${cfg.maxPayoutsPerRecipientPerDay} per day).`,
        "payout_recipient_velocity_exceeded"
      );
    }
  }

  if (cfg.maxPayoutAmountPerDayBdt > 0) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [row] = await db
      .select({
        total: sql<string>`coalesce(sum(case when ${transactions.status} in ('pending','success') then ${transactions.amount}::numeric else 0 end), 0)`,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.merchantId, params.merchantId),
          eq(transactions.environment, params.environment),
          eq(transactions.type, "payout"),
          eq(transactions.currency, "BDT"),
          gte(transactions.createdAt, since)
        )
      );
    const total = parseFloat(String(row?.total ?? "0"));
    const next = parseFloat(params.amount);
    if (Number.isFinite(total) && Number.isFinite(next) && total + next > cfg.maxPayoutAmountPerDayBdt) {
      throw new FraudPolicyRejectedError(
        `Daily payout volume limit exceeded (${cfg.maxPayoutAmountPerDayBdt} BDT per day).`,
        "payout_daily_limit_exceeded"
      );
    }
  }
}

export type PayoutVelocityMode = "monitor" | "block" | "review";

export function payoutVelocityMode(): PayoutVelocityMode {
  const v = process.env.PAYOUT_VELOCITY_MODE?.trim().toLowerCase();
  return v === "block" || v === "review" ? v : "monitor";
}

/** Review mode: caller should queue the payout for dual-control-style
 * manual review instead of rejecting it or letting it through. */
export class PayoutVelocityReviewRequiredError extends Error {
  constructor(
    message: string,
    public readonly window: "1h" | "24h",
    public readonly totalAfter: string,
    public readonly ceiling: number
  ) {
    super(message);
    this.name = "PayoutVelocityReviewRequiredError";
  }
}

function payoutVelocityCeiling(currency: string, window: "1h" | "24h"): number {
  const suffix = window === "1h" ? "1H" : "24H";
  return envInt(`PAYOUT_VELOCITY_CEILING_${currency.toUpperCase()}_${suffix}`, 0);
}

/** Test seam: stub the platform payout-volume lookup without a live DB. */
type PayoutVolumeSumFn = (params: {
  environment: "test" | "live";
  currency: string;
  since: Date;
}) => Promise<number>;
let payoutVolumeSumOverride: PayoutVolumeSumFn | null = null;
export function __setPayoutVelocitySumForTesting(fn: PayoutVolumeSumFn | null): void {
  payoutVolumeSumOverride = fn;
}

async function sumPayoutVolumeSince(params: {
  environment: "test" | "live";
  currency: string;
  since: Date;
}): Promise<number> {
  if (payoutVolumeSumOverride) return payoutVolumeSumOverride(params);
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(case when ${transactions.status} in ('pending','success') then ${transactions.amount}::numeric else 0 end), 0)`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.environment, params.environment),
        eq(transactions.type, "payout"),
        eq(transactions.currency, params.currency),
        gte(transactions.createdAt, params.since)
      )
    );
  const total = parseFloat(String(row?.total ?? "0"));
  return Number.isFinite(total) ? total : 0;
}

/**
 * Platform-wide (all merchants) payout velocity check, scoped by currency
 * and environment, built entirely from Transacty's own ledger — no
 * dependency on any upstream provider's balance/liquidity API. Currency
 * is already rail-specific (EUR only ever comes from the EUR rail, NGN
 * only from NGN, etc.), so this is rail-agnostic by construction.
 *
 * Checks the 1h window before the 24h window (only windows with a
 * configured ceiling > 0 are evaluated at all).
 *
 * - "monitor" (default): never throws. Emits an audit log entry when a
 *   configured ceiling would have fired, so operators can see real
 *   traffic against candidate ceilings before switching to block/review.
 * - "block": throws FraudPolicyRejectedError at/over the ceiling — hard
 *   reject, already mapped to a merchant-facing error by
 *   merchant-facing-errors.ts.
 * - "review": throws PayoutVelocityReviewRequiredError — the caller
 *   (the portal payout dual-control gate) catches this and queues the
 *   payout for manual approval instead of executing or rejecting it.
 */
export async function assertPayoutVelocityAllowed(params: {
  environment: "test" | "live";
  currency: string;
  amount: string;
}): Promise<void> {
  const mode = payoutVelocityMode();
  const amount = parseFloat(params.amount);
  if (!Number.isFinite(amount)) return;

  const windows: Array<{ window: "1h" | "24h"; hours: number }> = [
    { window: "1h", hours: 1 },
    { window: "24h", hours: 24 },
  ];

  for (const { window, hours } of windows) {
    const ceiling = payoutVelocityCeiling(params.currency, window);
    if (ceiling <= 0) continue;

    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const total = await sumPayoutVolumeSince({
      environment: params.environment,
      currency: params.currency,
      since,
    });
    const totalAfter = total + amount;
    if (totalAfter <= ceiling) continue;

    if (mode === "monitor") {
      audit({
        action: "portal.payout_velocity.exceeded_log_only",
        meta: {
          window,
          currency: params.currency,
          environment: params.environment,
          ceiling,
          totalAfter: totalAfter.toFixed(2),
        },
      });
      continue;
    }

    if (mode === "review") {
      throw new PayoutVelocityReviewRequiredError(
        `Platform ${window} payout velocity ceiling would be exceeded for ${params.currency} (${totalAfter.toFixed(2)} > ${ceiling}); queued for review.`,
        window,
        totalAfter.toFixed(2),
        ceiling
      );
    }

    throw new FraudPolicyRejectedError(
      `Platform payout volume limit reached for ${params.currency} in the last ${window}. Try again later.`,
      "payout_velocity_exceeded"
    );
  }
}

export async function assertPayinAllowed(params: {
  merchantId: string;
  environment: "test" | "live";
  customerPhone?: string;
  customerEmail?: string;
}): Promise<void> {
  await assertNotBlacklisted({
    merchantId: params.merchantId,
    environment: params.environment,
    phone: params.customerPhone,
    email: params.customerEmail,
  });
  await assertPayinVelocityAllowed(params);
}
