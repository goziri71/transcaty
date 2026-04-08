/**
 * Secure password reset tokens (hashed at rest). Used by portal and provider flows.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  merchantUsers,
  passwordResetTokens,
  providerUsers,
} from "../db/schema/index.js";
import { hashPassword } from "./portal-auth.js";
import { hashProviderPassword } from "./provider-auth.js";

const DEFAULT_TTL_MIN = 60;

export function hashResetToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function generateRawResetToken(): string {
  return randomBytes(32).toString("hex");
}

function getTtlMs(): number {
  const n = Number(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES ?? DEFAULT_TTL_MIN);
  if (!Number.isFinite(n) || n < 5 || n > 24 * 60) return DEFAULT_TTL_MIN * 60 * 1000;
  return n * 60 * 1000;
}

export async function createPortalPasswordResetToken(email: string): Promise<{
  rawToken: string;
  userId: string;
  merchantId: string;
} | null> {
  const normalized = email.toLowerCase().trim();
  const [user] = await db
    .select({ id: merchantUsers.id, merchantId: merchantUsers.merchantId })
    .from(merchantUsers)
    .where(and(eq(merchantUsers.email, normalized), eq(merchantUsers.status, "active")))
    .limit(1);

  if (!user) return null;

  await db
    .delete(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.realm, "portal"),
        eq(passwordResetTokens.userId, user.id),
        isNull(passwordResetTokens.usedAt)
      )
    );

  const rawToken = generateRawResetToken();
  const tokenHash = hashResetToken(rawToken);
  const expiresAt = new Date(Date.now() + getTtlMs());

  await db.insert(passwordResetTokens).values({
    realm: "portal",
    userId: user.id,
    tokenHash,
    expiresAt,
  });

  return { rawToken, userId: user.id, merchantId: user.merchantId };
}

export async function createProviderPasswordResetToken(email: string): Promise<{
  rawToken: string;
  userId: string;
} | null> {
  const normalized = email.toLowerCase().trim();
  const [user] = await db
    .select({ id: providerUsers.id })
    .from(providerUsers)
    .where(and(eq(providerUsers.email, normalized), eq(providerUsers.status, "active")))
    .limit(1);

  if (!user) return null;

  await db
    .delete(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.realm, "provider"),
        eq(passwordResetTokens.userId, user.id),
        isNull(passwordResetTokens.usedAt)
      )
    );

  const rawToken = generateRawResetToken();
  const tokenHash = hashResetToken(rawToken);
  const expiresAt = new Date(Date.now() + getTtlMs());

  await db.insert(passwordResetTokens).values({
    realm: "provider",
    userId: user.id,
    tokenHash,
    expiresAt,
  });

  return { rawToken, userId: user.id };
}

export async function consumePortalResetToken(
  rawToken: string,
  newPassword: string
): Promise<{ ok: true; userId: string } | { ok: false; reason: string }> {
  if (newPassword.length < 8 || newPassword.length > 128) {
    return { ok: false, reason: "Password must be 8–128 characters" };
  }

  const tokenHash = hashResetToken(rawToken);
  const now = new Date();

  const [row] = await db
    .select()
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.realm, "portal"),
        eq(passwordResetTokens.tokenHash, tokenHash),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, now)
      )
    )
    .limit(1);

  if (!row) {
    return { ok: false, reason: "Invalid or expired reset link" };
  }

  const passwordHash = await hashPassword(newPassword);

  await db.transaction(async (tx) => {
    await tx
      .update(merchantUsers)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(merchantUsers.id, row.userId));

    await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(eq(passwordResetTokens.id, row.id));
  });

  return { ok: true, userId: row.userId };
}

export async function consumeProviderResetToken(
  rawToken: string,
  newPassword: string
): Promise<{ ok: true; userId: string } | { ok: false; reason: string }> {
  if (newPassword.length < 8 || newPassword.length > 128) {
    return { ok: false, reason: "Password must be 8–128 characters" };
  }

  const tokenHash = hashResetToken(rawToken);
  const now = new Date();

  const [row] = await db
    .select()
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.realm, "provider"),
        eq(passwordResetTokens.tokenHash, tokenHash),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, now)
      )
    )
    .limit(1);

  if (!row) {
    return { ok: false, reason: "Invalid or expired reset link" };
  }

  const passwordHash = await hashProviderPassword(newPassword);

  await db.transaction(async (tx) => {
    await tx
      .update(providerUsers)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(providerUsers.id, row.userId));

    await tx
      .update(passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(eq(passwordResetTokens.id, row.id));
  });

  return { ok: true, userId: row.userId };
}
