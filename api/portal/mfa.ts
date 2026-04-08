/**
 * Portal TOTP MFA: setup, confirm, disable, cancel.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { merchantUsers } from "../../src/db/schema/index.js";
import { verifyPassword } from "../../src/lib/portal-auth.js";
import {
  buildKeyUri,
  encryptTotpSecret,
  decryptTotpSecret,
  generateTotpSecret,
  verifyTotp,
  getMasterKeyForMfa,
} from "../../src/lib/mfa-totp.js";
import { audit } from "../../src/lib/audit.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

const issuer =
  process.env.PORTAL_MFA_ISSUER?.trim() ||
  process.env.EMAIL_APP_NAME?.trim() ||
  "Transacty Portal";

export async function registerPortalMfaRoutes(app: FastifyInstance) {
  app.get(
    "/portal/me/mfa/status",
    {
      schema: {
        response: {
          200: z.object({
            enabled: z.boolean(),
            pendingSetup: z.boolean(),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const [row] = await db
        .select({
          mfaEnabled: merchantUsers.mfaEnabled,
          mfaPending: merchantUsers.mfaPending,
        })
        .from(merchantUsers)
        .where(eq(merchantUsers.id, user.merchantUserId))
        .limit(1);

      if (!row) return reply.status(401).send({ error: "Unauthorized" });

      return {
        enabled: row.mfaEnabled,
        pendingSetup: row.mfaPending && !row.mfaEnabled,
      };
    }
  );

  app.post(
    "/portal/me/mfa/setup",
    {
      schema: {
        response: {
          200: z.object({
            otpauthUrl: z.string(),
            issuer: z.string(),
            accountEmail: z.string(),
          }),
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      try {
        getMasterKeyForMfa();
      } catch (e) {
        return reply.status(400).send({
          error: "Bad Request",
          message: e instanceof Error ? e.message : "MFA not configured",
        });
      }

      const [existing] = await db
        .select({
          mfaEnabled: merchantUsers.mfaEnabled,
        })
        .from(merchantUsers)
        .where(eq(merchantUsers.id, user.merchantUserId))
        .limit(1);

      if (!existing) return reply.status(401).send({ error: "Unauthorized" });
      if (existing.mfaEnabled) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "MFA is already enabled. Disable it first to re-enroll.",
        });
      }

      const secret = generateTotpSecret();
      const enc = encryptTotpSecret(secret);
      const now = new Date();

      await db
        .update(merchantUsers)
        .set({
          mfaSecretEnc: enc,
          mfaPending: true,
          mfaEnabled: false,
          updatedAt: now,
        })
        .where(eq(merchantUsers.id, user.merchantUserId));

      const otpauthUrl = buildKeyUri({
        email: user.email,
        issuer,
        secret,
      });

      audit({
        action: "config.changed",
        actor: user.merchantUserId,
        resource: user.merchantId,
        merchantId: user.merchantId,
        merchantUserId: user.merchantUserId,
        actorEmail: user.email,
        meta: { mfa: "portal_setup_started" },
      });

      return {
        otpauthUrl,
        issuer,
        accountEmail: user.email,
      };
    }
  );

  app.post(
    "/portal/me/mfa/confirm",
    {
      schema: {
        body: z.object({ code: z.string().min(6).max(12) }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const body = request.body as { code: string };

      const [row] = await db
        .select({
          mfaSecretEnc: merchantUsers.mfaSecretEnc,
          mfaPending: merchantUsers.mfaPending,
          mfaEnabled: merchantUsers.mfaEnabled,
        })
        .from(merchantUsers)
        .where(eq(merchantUsers.id, user.merchantUserId))
        .limit(1);

      if (!row?.mfaSecretEnc || !row.mfaPending) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "No MFA setup in progress. Call POST /portal/me/mfa/setup first.",
        });
      }
      if (row.mfaEnabled) {
        return reply.status(400).send({ error: "Bad Request", message: "MFA already enabled" });
      }

      let secret: string;
      try {
        secret = decryptTotpSecret(row.mfaSecretEnc);
      } catch {
        return reply.status(400).send({ error: "Bad Request", message: "Could not read MFA secret" });
      }

      if (!verifyTotp(secret, body.code)) {
        return reply.status(400).send({ error: "Bad Request", message: "Invalid authenticator code" });
      }

      const now = new Date();
      await db
        .update(merchantUsers)
        .set({
          mfaEnabled: true,
          mfaPending: false,
          updatedAt: now,
        })
        .where(eq(merchantUsers.id, user.merchantUserId));

      audit({
        action: "config.changed",
        actor: user.merchantUserId,
        resource: user.merchantId,
        merchantId: user.merchantId,
        merchantUserId: user.merchantUserId,
        actorEmail: user.email,
        meta: { mfa: "portal_enabled" },
      });

      return reply.send({ ok: true });
    }
  );

  app.post(
    "/portal/me/mfa/cancel",
    {
      schema: {
        response: {
          200: z.object({ ok: z.literal(true) }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const now = new Date();
      await db
        .update(merchantUsers)
        .set({
          mfaSecretEnc: null,
          mfaPending: false,
          mfaEnabled: false,
          updatedAt: now,
        })
        .where(eq(merchantUsers.id, user.merchantUserId));

      audit({
        action: "config.changed",
        actor: user.merchantUserId,
        resource: user.merchantId,
        merchantId: user.merchantId,
        merchantUserId: user.merchantUserId,
        actorEmail: user.email,
        meta: { mfa: "portal_setup_cancelled" },
      });

      return reply.send({ ok: true });
    }
  );

  app.post(
    "/portal/me/mfa/disable",
    {
      schema: {
        body: z.object({
          password: z.string().min(1),
          code: z.string().min(6).max(12),
        }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const body = request.body as { password: string; code: string };

      const [row] = await db
        .select({
          passwordHash: merchantUsers.passwordHash,
          mfaSecretEnc: merchantUsers.mfaSecretEnc,
          mfaEnabled: merchantUsers.mfaEnabled,
        })
        .from(merchantUsers)
        .where(eq(merchantUsers.id, user.merchantUserId))
        .limit(1);

      if (!row?.passwordHash) {
        return reply.status(400).send({ error: "Bad Request", message: "No password on account" });
      }

      const pwOk = await verifyPassword(body.password, row.passwordHash);
      if (!pwOk) {
        return reply.status(401).send({ error: "Unauthorized", message: "Invalid password" });
      }

      if (!row.mfaEnabled || !row.mfaSecretEnc) {
        return reply.status(400).send({ error: "Bad Request", message: "MFA is not enabled" });
      }

      let secret: string;
      try {
        secret = decryptTotpSecret(row.mfaSecretEnc);
      } catch {
        return reply.status(400).send({ error: "Bad Request", message: "Could not read MFA secret" });
      }

      if (!verifyTotp(secret, body.code)) {
        return reply.status(400).send({ error: "Bad Request", message: "Invalid authenticator code" });
      }

      const now = new Date();
      await db
        .update(merchantUsers)
        .set({
          mfaSecretEnc: null,
          mfaPending: false,
          mfaEnabled: false,
          updatedAt: now,
        })
        .where(eq(merchantUsers.id, user.merchantUserId));

      audit({
        action: "config.changed",
        actor: user.merchantUserId,
        resource: user.merchantId,
        merchantId: user.merchantId,
        merchantUserId: user.merchantUserId,
        actorEmail: user.email,
        meta: { mfa: "portal_disabled" },
      });

      return reply.send({ ok: true });
    }
  );
}
