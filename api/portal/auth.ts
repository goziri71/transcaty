/**
 * Portal auth routes: signup, login, logout, forgot/reset password.
 * No auth required for signup/login/forgot/reset.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  merchants,
  merchantPricing,
  merchantUsers,
  wallets,
} from "../../src/db/schema/index.js";
import {
  hashPassword,
  verifyPassword,
  signPortalToken,
  signPortalMfaPendingToken,
  verifyPortalMfaPendingToken,
} from "../../src/lib/portal-auth.js";
import { decryptTotpSecret, verifyTotp } from "../../src/lib/mfa-totp.js";
import { audit } from "../../src/lib/audit.js";
import { checkRedisRateLimit } from "../../src/lib/rate-limit-redis.js";
import {
  createPortalPasswordResetToken,
  consumePortalResetToken,
} from "../../src/lib/password-reset.js";
import { queueTransactionalEmail } from "../../src/lib/transactional-email-queue.js";
import { getClientIp } from "../../src/lib/request-ip.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

export async function registerPortalAuthRoutes(app: FastifyInstance) {
  app.post(
    "/portal/auth/signup",
    {
      schema: {
        body: z.object({
          businessName: z.string().min(1).max(200),
          email: z.string().email(),
          password: z.string().min(8).max(128),
        }),
        response: {
          201: z.object({
            token: z.string(),
            merchantId: z.string(),
            email: z.string(),
            role: z.string(),
            needsActivation: z.boolean(),
            merchant: z.object({
              name: z.string(),
              status: z.string(),
              kycStatus: z.string(),
            }),
          }),
          400: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        businessName: string;
        email: string;
        password: string;
      };

      const [existing] = await db
        .select({ id: merchantUsers.id })
        .from(merchantUsers)
        .where(eq(merchantUsers.email, body.email.toLowerCase().trim()))
        .limit(1);

      if (existing) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Email already registered",
        });
      }

      const passwordHash = await hashPassword(body.password);

      const [merchant] = await db
        .insert(merchants)
        .values({
          name: body.businessName.trim(),
          status: "pending",
          kycStatus: "pending",
        })
        .returning({ id: merchants.id });

      if (!merchant) {
        return reply.status(500).send({
          error: "Internal",
          message: "Failed to create merchant",
        });
      }

      const [user] = await db
        .insert(merchantUsers)
        .values({
          merchantId: merchant.id,
          email: body.email.toLowerCase().trim(),
          passwordHash,
          role: "admin",
        })
        .returning({ id: merchantUsers.id, email: merchantUsers.email });

      if (!user) {
        return reply.status(500).send({
          error: "Internal",
          message: "Failed to create user",
        });
      }

      await db.insert(wallets).values([
        {
          merchantId: merchant.id,
          type: "merchant",
          environment: "test",
          balance: "0",
          currency: "BDT",
          status: "active",
        },
        {
          merchantId: merchant.id,
          type: "merchant",
          environment: "live",
          balance: "0",
          currency: "BDT",
          status: "active",
        },
      ]);

      await db.insert(merchantPricing).values({
        merchantId: merchant.id,
        billingMode: "percentage_only",
        feePercentagePayin: "3",
        feePercentagePayout: "2",
        feeMinPayin: "0",
        feeMinPayout: "0",
      });

      const token = signPortalToken({
        merchantUserId: user.id,
        merchantId: merchant.id,
        email: user.email,
        role: "admin",
      });

      return reply.status(201).send({
        token,
        merchantId: merchant.id,
        email: user.email,
        role: "admin",
        needsActivation: true,
        merchant: {
          name: body.businessName.trim(),
          status: "pending",
          kycStatus: "pending",
        },
      });
    }
  );

  app.post(
    "/portal/auth/login",
    {
      schema: {
        body: z.object({
          email: z.string().email(),
          password: z.string().min(1),
        }),
        response: {
          200: z.object({
            requiresMfa: z.boolean().optional(),
            mfaToken: z.string().optional(),
            token: z.string().optional(),
            merchantId: z.string(),
            email: z.string(),
            role: z.string().optional(),
            needsActivation: z.boolean().optional(),
            merchant: z
              .object({
                name: z.string(),
                status: z.string(),
                kycStatus: z.string(),
              })
              .optional(),
          }),
          401: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { email: string; password: string };

      const [existing] = await db
        .select({
          id: merchantUsers.id,
          merchantId: merchantUsers.merchantId,
          email: merchantUsers.email,
          passwordHash: merchantUsers.passwordHash,
          role: merchantUsers.role,
          status: merchantUsers.status,
          mfaEnabled: merchantUsers.mfaEnabled,
        })
        .from(merchantUsers)
        .where(eq(merchantUsers.email, body.email.toLowerCase().trim()))
        .limit(1);

      if (!existing) {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "Invalid email or password",
        });
      }

      if (existing.status !== "active") {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "Account suspended",
        });
      }

      if (!existing.passwordHash) {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "Account has no password set",
        });
      }

      const valid = await verifyPassword(body.password, existing.passwordHash);
      if (!valid) {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "Invalid email or password",
        });
      }

      const [merchant] = await db
        .select({
          name: merchants.name,
          status: merchants.status,
          kycStatus: merchants.kycStatus,
        })
        .from(merchants)
        .where(eq(merchants.id, existing.merchantId))
        .limit(1);

      if (!merchant) {
        return reply.status(500).send({
          error: "Internal",
          message: "Merchant not found",
        });
      }

      const needsActivation = merchant.kycStatus !== "verified";

      if (existing.mfaEnabled) {
        const mfaToken = signPortalMfaPendingToken({
          merchantUserId: existing.id,
          merchantId: existing.merchantId,
          email: existing.email,
          role: existing.role,
        });
        return reply.send({
          requiresMfa: true,
          mfaToken,
          merchantId: existing.merchantId,
          email: existing.email,
        });
      }

      const token = signPortalToken({
        merchantUserId: existing.id,
        merchantId: existing.merchantId,
        email: existing.email,
        role: existing.role,
      });

      const portalBase = (
        process.env.PORTAL_PUBLIC_URL ??
        process.env.APP_BASE_URL ??
        `http://localhost:${process.env.PORT ?? 3000}`
      ).replace(/\/$/, "");
      const changePasswordUrl = `${portalBase}/forgot-password`;

      console.log(`[email] Queueing portal_login to ${existing.email}`);
      queueTransactionalEmail({
        kind: "portal_login",
        to: existing.email,
        ip: getClientIp(request),
        timestamp: new Date().toISOString(),
        changePasswordUrl,
      }).catch((e) => {
        console.error("[email] Failed to queue portal_login:", e);
      });

      return reply.send({
        token,
        merchantId: existing.merchantId,
        email: existing.email,
        role: existing.role,
        needsActivation,
        merchant: {
          name: merchant.name,
          status: merchant.status,
          kycStatus: merchant.kycStatus ?? "pending",
        },
      });
    }
  );

  app.post(
    "/portal/auth/mfa/verify",
    {
      schema: {
        body: z.object({
          mfaToken: z.string().min(1),
          code: z.string().min(6).max(12),
        }),
        response: {
          200: z.object({
            token: z.string(),
            merchantId: z.string(),
            email: z.string(),
            role: z.string(),
            needsActivation: z.boolean(),
            merchant: z.object({
              name: z.string(),
              status: z.string(),
              kycStatus: z.string(),
            }),
          }),
          401: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { mfaToken: string; code: string };
      const pending = verifyPortalMfaPendingToken(body.mfaToken);
      if (!pending) {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "Invalid or expired MFA token",
        });
      }

      const [u] = await db
        .select({
          mfaEnabled: merchantUsers.mfaEnabled,
          mfaSecretEnc: merchantUsers.mfaSecretEnc,
        })
        .from(merchantUsers)
        .where(eq(merchantUsers.id, pending.merchantUserId))
        .limit(1);

      if (!u?.mfaEnabled || !u.mfaSecretEnc) {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "MFA not enabled for this account",
        });
      }

      let secret: string;
      try {
        secret = decryptTotpSecret(u.mfaSecretEnc);
      } catch {
        return reply.status(401).send({ error: "Unauthorized", message: "MFA misconfigured" });
      }

      if (!verifyTotp(secret, body.code)) {
        audit({
          action: "auth.failed",
          meta: { reason: "portal_mfa_invalid_code", merchantUserId: pending.merchantUserId },
        });
        return reply.status(401).send({
          error: "Unauthorized",
          message: "Invalid authenticator code",
        });
      }

      const [merchant] = await db
        .select({
          name: merchants.name,
          status: merchants.status,
          kycStatus: merchants.kycStatus,
        })
        .from(merchants)
        .where(eq(merchants.id, pending.merchantId))
        .limit(1);

      if (!merchant) {
        return reply.status(500).send({ error: "Internal", message: "Merchant not found" });
      }

      const needsActivation = merchant.kycStatus !== "verified";
      const token = signPortalToken({
        merchantUserId: pending.merchantUserId,
        merchantId: pending.merchantId,
        email: pending.email,
        role: pending.role,
      });

      const portalBase = (
        process.env.PORTAL_PUBLIC_URL ??
        process.env.APP_BASE_URL ??
        `http://localhost:${process.env.PORT ?? 3000}`
      ).replace(/\/$/, "");
      const changePasswordUrl = `${portalBase}/forgot-password`;

      console.log(`[email] Queueing portal_login (MFA) to ${pending.email}`);
      queueTransactionalEmail({
        kind: "portal_login",
        to: pending.email,
        ip: getClientIp(request),
        timestamp: new Date().toISOString(),
        changePasswordUrl,
      }).catch((e) => {
        console.error("[email] Failed to queue portal_login (MFA):", e);
      });

      return reply.send({
        token,
        merchantId: pending.merchantId,
        email: pending.email,
        role: pending.role,
        needsActivation,
        merchant: {
          name: merchant.name,
          status: merchant.status,
          kycStatus: merchant.kycStatus ?? "pending",
        },
      });
    }
  );

  app.post(
    "/portal/auth/logout",
    {
      schema: {
        response: {
          200: z.object({ ok: z.boolean() }),
        },
      },
    },
    async (_request, reply) => {
      return reply.send({ ok: true });
    }
  );

  app.post(
    "/portal/auth/forgot-password",
    {
      schema: {
        body: z.object({ email: z.string().email() }),
        response: {
          200: z.object({
            ok: z.literal(true),
            message: z.string(),
          }),
          429: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const ip = getClientIp(request);
      const perHour = Number(process.env.PASSWORD_RESET_REQUESTS_PER_IP_PER_HOUR ?? 5);
      const { allowed } = await checkRedisRateLimit(
        `portal:forgot:${ip}`,
        Number.isFinite(perHour) && perHour > 0 ? perHour : 5,
        3600
      );
      if (!allowed) {
        return reply.status(429).send({
          error: "Too Many Requests",
          message: "Try again later",
        });
      }

      const body = request.body as { email: string };
      const email = body.email.toLowerCase().trim();
      const created = await createPortalPasswordResetToken(email);
      const message =
        "If an account exists for this email, you will receive reset instructions shortly.";

      if (created) {
        const base = (
          process.env.PORTAL_PUBLIC_URL ??
          process.env.APP_BASE_URL ??
          "http://localhost:3000"
        ).replace(/\/$/, "");
        const resetUrl = `${base}/reset-password?token=${encodeURIComponent(created.rawToken)}`;

        await queueTransactionalEmail({
          kind: "portal_password_reset",
          to: email,
          resetUrl,
        });

        audit({
          action: "auth.password_reset_requested",
          meta: { realm: "portal" },
        });
      }

      return reply.send({ ok: true, message });
    }
  );

  app.post(
    "/portal/auth/reset-password",
    {
      schema: {
        body: z.object({
          token: z.string().min(1),
          password: z.string().min(8).max(128),
        }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          400: errorResponse,
          429: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const ip = getClientIp(request);
      const perHour = Number(process.env.PASSWORD_RESET_ATTEMPTS_PER_IP_PER_HOUR ?? 30);
      const { allowed } = await checkRedisRateLimit(
        `portal:reset:${ip}`,
        Number.isFinite(perHour) && perHour > 0 ? perHour : 30,
        3600
      );
      if (!allowed) {
        return reply.status(429).send({
          error: "Too Many Requests",
          message: "Try again later",
        });
      }

      const body = request.body as { token: string; password: string };
      const result = await consumePortalResetToken(body.token, body.password);
      if (!result.ok) {
        return reply.status(400).send({ error: "Bad Request", message: result.reason });
      }

      audit({
        action: "auth.password_reset_completed",
        resource: result.userId,
        meta: { realm: "portal" },
      });

      return reply.send({ ok: true });
    }
  );
}
