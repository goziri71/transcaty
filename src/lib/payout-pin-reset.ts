/**
 * Email-verified merchant payout PIN reset tokens.
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  merchantPayoutPinResetTokens,
  merchantUsers,
  merchants,
} from "../db/schema/index.js";
import {
  generateRawResetToken,
  hashResetToken,
} from "./password-reset.js";
import { setMerchantPayoutPin } from "./merchant-payout-pin.js";

const DEFAULT_TTL_MIN = 30;

function getTtlMs(): number {
  const n = Number(process.env.PAYOUT_PIN_RESET_TOKEN_TTL_MINUTES ?? DEFAULT_TTL_MIN);
  if (!Number.isFinite(n) || n < 5 || n > 120) return DEFAULT_TTL_MIN * 60 * 1000;
  return n * 60 * 1000;
}

/** Request reset for an admin portal user whose merchant already has a payout PIN. */
export async function createPortalPayoutPinResetToken(email: string): Promise<{
  rawToken: string;
  userId: string;
  merchantId: string;
} | null> {
  const normalized = email.toLowerCase().trim();
  const [user] = await db
    .select({
      id: merchantUsers.id,
      merchantId: merchantUsers.merchantId,
      role: merchantUsers.role,
      payoutPinHash: merchants.payoutPinHash,
    })
    .from(merchantUsers)
    .innerJoin(merchants, eq(merchants.id, merchantUsers.merchantId))
    .where(and(eq(merchantUsers.email, normalized), eq(merchantUsers.status, "active")))
    .limit(1);

  if (!user || user.role !== "admin" || !user.payoutPinHash) return null;

  await db
    .delete(merchantPayoutPinResetTokens)
    .where(
      and(
        eq(merchantPayoutPinResetTokens.merchantId, user.merchantId),
        isNull(merchantPayoutPinResetTokens.usedAt)
      )
    );

  const rawToken = generateRawResetToken();
  const tokenHash = hashResetToken(rawToken);
  const expiresAt = new Date(Date.now() + getTtlMs());

  await db.insert(merchantPayoutPinResetTokens).values({
    merchantId: user.merchantId,
    requestedByUserId: user.id,
    tokenHash,
    expiresAt,
  });

  return { rawToken, userId: user.id, merchantId: user.merchantId };
}

export async function resetMerchantPayoutPinWithToken(params: {
  merchantId: string;
  merchantUserId: string;
  actorEmail: string;
  rawToken: string;
  newPin: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const tokenHash = hashResetToken(params.rawToken.trim());
  const now = new Date();

  const [row] = await db
    .select({
      id: merchantPayoutPinResetTokens.id,
      merchantId: merchantPayoutPinResetTokens.merchantId,
      requestedByUserId: merchantPayoutPinResetTokens.requestedByUserId,
    })
    .from(merchantPayoutPinResetTokens)
    .where(
      and(
        eq(merchantPayoutPinResetTokens.tokenHash, tokenHash),
        gt(merchantPayoutPinResetTokens.expiresAt, now),
        isNull(merchantPayoutPinResetTokens.usedAt)
      )
    )
    .limit(1);

  if (!row || row.merchantId !== params.merchantId) {
    return { ok: false, reason: "Invalid or expired reset link" };
  }

  if (row.requestedByUserId !== params.merchantUserId) {
    return { ok: false, reason: "This reset link was issued to a different admin account" };
  }

  await setMerchantPayoutPin({
    merchantId: params.merchantId,
    pin: params.newPin,
    merchantUserId: params.merchantUserId,
    actorEmail: params.actorEmail,
    auditAction: "merchant.payout_pin.reset",
  });

  await db
    .update(merchantPayoutPinResetTokens)
    .set({ usedAt: now })
    .where(eq(merchantPayoutPinResetTokens.id, row.id));

  return { ok: true };
}
