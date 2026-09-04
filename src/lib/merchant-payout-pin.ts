/**
 * Merchant payout PIN: bcrypt-hashed 4–6 digit PIN required for portal payout mutations.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { merchants } from "../db/schema/index.js";
import { hashPassword, verifyPassword } from "./portal-auth.js";
import { audit } from "./audit.js";

export const portalPayoutPinSchema = z
  .string()
  .regex(/^\d{4,6}$/, "PIN must be 4–6 digits");

export const portalPayoutPinBodyField = z.object({
  pin: portalPayoutPinSchema,
});

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

function lockUntilFromNow(): Date {
  return new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
}

export async function getMerchantPayoutPinStatus(merchantId: string): Promise<{
  configured: boolean;
  lockedUntil: string | null;
}> {
  const [row] = await db
    .select({
      payoutPinHash: merchants.payoutPinHash,
      payoutPinLockedUntil: merchants.payoutPinLockedUntil,
    })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);

  const lockedUntil = row?.payoutPinLockedUntil;
  const isLocked = lockedUntil != null && lockedUntil.getTime() > Date.now();

  return {
    configured: Boolean(row?.payoutPinHash),
    lockedUntil: isLocked ? lockedUntil!.toISOString() : null,
  };
}

export async function setMerchantPayoutPin(params: {
  merchantId: string;
  pin: string;
  merchantUserId: string;
  actorEmail: string;
  auditAction?: "merchant.payout_pin.set" | "merchant.payout_pin.reset";
}): Promise<void> {
  const hash = await hashPassword(params.pin);
  await db
    .update(merchants)
    .set({
      payoutPinHash: hash,
      payoutPinSetAt: new Date(),
      payoutPinFailedAttempts: 0,
      payoutPinLockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(merchants.id, params.merchantId));

  audit({
    action: params.auditAction ?? "merchant.payout_pin.set",
    merchantId: params.merchantId,
    merchantUserId: params.merchantUserId,
    actorEmail: params.actorEmail,
  });
}

export async function changeMerchantPayoutPin(params: {
  merchantId: string;
  currentPin: string;
  newPin: string;
  merchantUserId: string;
  actorEmail: string;
}): Promise<"ok" | "not_configured" | "invalid_pin" | "locked"> {
  const [row] = await db
    .select({
      payoutPinHash: merchants.payoutPinHash,
      payoutPinLockedUntil: merchants.payoutPinLockedUntil,
    })
    .from(merchants)
    .where(eq(merchants.id, params.merchantId))
    .limit(1);

  if (!row?.payoutPinHash) return "not_configured";
  if (row.payoutPinLockedUntil && row.payoutPinLockedUntil.getTime() > Date.now()) {
    return "locked";
  }

  const valid = await verifyPassword(params.currentPin, row.payoutPinHash);
  if (!valid) {
    await recordPayoutPinFailure(params.merchantId, params.merchantUserId, params.actorEmail);
    return "invalid_pin";
  }

  const hash = await hashPassword(params.newPin);
  await db
    .update(merchants)
    .set({
      payoutPinHash: hash,
      payoutPinSetAt: new Date(),
      payoutPinFailedAttempts: 0,
      payoutPinLockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(merchants.id, params.merchantId));

  audit({
    action: "merchant.payout_pin.changed",
    merchantId: params.merchantId,
    merchantUserId: params.merchantUserId,
    actorEmail: params.actorEmail,
  });
  return "ok";
}

async function recordPayoutPinFailure(
  merchantId: string,
  merchantUserId: string,
  actorEmail: string
): Promise<void> {
  const [row] = await db
    .select({ payoutPinFailedAttempts: merchants.payoutPinFailedAttempts })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);

  const attempts = (row?.payoutPinFailedAttempts ?? 0) + 1;
  const locked = attempts >= MAX_FAILED_ATTEMPTS;

  await db
    .update(merchants)
    .set({
      payoutPinFailedAttempts: attempts,
      payoutPinLockedUntil: locked ? lockUntilFromNow() : null,
      updatedAt: new Date(),
    })
    .where(eq(merchants.id, merchantId));

  audit({
    action: "merchant.payout_pin.failed",
    merchantId,
    merchantUserId,
    actorEmail,
    meta: { attempts, locked },
  });
}

/**
 * Verify payout PIN for a money mutation. Call after session auth and money role checks.
 */
export async function requireMerchantPayoutPin(
  request: FastifyRequest,
  reply: FastifyReply,
  pin: string | undefined
): Promise<boolean> {
  const user = request.portalUser;
  if (!user) {
    reply.status(401).send({ error: "Unauthorized" });
    return false;
  }

  const [row] = await db
    .select({
      payoutPinHash: merchants.payoutPinHash,
      payoutPinLockedUntil: merchants.payoutPinLockedUntil,
    })
    .from(merchants)
    .where(eq(merchants.id, user.merchantId))
    .limit(1);

  if (!row?.payoutPinHash) {
    reply.status(403).send({
      error: "Forbidden",
      message: "Set a payout PIN before initiating payouts",
      payoutPinRequired: true,
      payoutPinConfigured: false,
    });
    return false;
  }

  if (row.payoutPinLockedUntil && row.payoutPinLockedUntil.getTime() > Date.now()) {
    reply.status(403).send({
      error: "Forbidden",
      message: "Payout PIN is temporarily locked due to failed attempts. Try again later.",
      payoutPinLocked: true,
      lockedUntil: row.payoutPinLockedUntil.toISOString(),
    });
    return false;
  }

  if (!pin || typeof pin !== "string") {
    reply.status(400).send({
      error: "Bad Request",
      message: "Payout PIN is required",
      payoutPinRequired: true,
    });
    return false;
  }

  const parsed = portalPayoutPinSchema.safeParse(pin);
  if (!parsed.success) {
    reply.status(400).send({
      error: "Bad Request",
      message: parsed.error.issues[0]?.message ?? "Invalid payout PIN format",
    });
    return false;
  }

  const valid = await verifyPassword(parsed.data, row.payoutPinHash);
  if (!valid) {
    await recordPayoutPinFailure(user.merchantId, user.merchantUserId, user.email);
    reply.status(403).send({
      error: "Forbidden",
      message: "Incorrect payout PIN",
      payoutPinInvalid: true,
    });
    return false;
  }

  await db
    .update(merchants)
    .set({ payoutPinFailedAttempts: 0, payoutPinLockedUntil: null, updatedAt: new Date() })
    .where(eq(merchants.id, user.merchantId));

  return true;
}
