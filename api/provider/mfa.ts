/**
 * Provider admin TOTP MFA (JWT users only).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { providerUsers } from "../../src/db/schema/index.js";
import { verifyProviderPassword, type ProviderRole } from "../../src/lib/provider-auth.js";
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
  process.env.PROVIDER_MFA_ISSUER?.trim() ||
  process.env.EMAIL_APP_NAME?.trim() ||
  "Transacty Provider";

type ProviderJwtActor = {
  providerUserId: string;
  email: string;
  role: ProviderRole;
};

function requireProviderJwt(request: FastifyRequest): ProviderJwtActor | null {
  const p = request.provider;
  if (!p || p.authType !== "jwt" || !p.providerUserId) {
    return null;
  }
  return {
    providerUserId: p.providerUserId,
    email: p.email ?? "",
    role: p.role,
  };
}

export async function registerProviderMfaRoutes(app: FastifyInstance) {
  app.get(
    "/provider/me/mfa/status",
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
      const actor = requireProviderJwt(request);
      if (!actor) {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "JWT required for MFA management",
        });
      }

      const [row] = await db
        .select({
          mfaEnabled: providerUsers.mfaEnabled,
          mfaPending: providerUsers.mfaPending,
        })
        .from(providerUsers)
        .where(eq(providerUsers.id, actor.providerUserId))
        .limit(1);

      if (!row) return reply.status(401).send({ error: "Unauthorized" });

      return {
        enabled: row.mfaEnabled,
        pendingSetup: row.mfaPending && !row.mfaEnabled,
      };
    }
  );

  app.post(
    "/provider/me/mfa/setup",
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
      const actor = requireProviderJwt(request);
      if (!actor) {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "JWT required for MFA management",
        });
      }

      try {
        getMasterKeyForMfa();
      } catch (e) {
        return reply.status(400).send({
          error: "Bad Request",
          message: e instanceof Error ? e.message : "MFA not configured",
        });
      }

      const [existing] = await db
        .select({ mfaEnabled: providerUsers.mfaEnabled, email: providerUsers.email })
        .from(providerUsers)
        .where(eq(providerUsers.id, actor.providerUserId))
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
        .update(providerUsers)
        .set({
          mfaSecretEnc: enc,
          mfaPending: true,
          mfaEnabled: false,
          updatedAt: now,
        })
        .where(eq(providerUsers.id, actor.providerUserId));

      const otpauthUrl = buildKeyUri({
        email: existing.email,
        issuer,
        secret,
      });

      audit({
        action: "config.changed",
        actor: actor.providerUserId,
        resource: actor.providerUserId,
        meta: { mfa: "provider_setup_started" },
      });

      return {
        otpauthUrl,
        issuer,
        accountEmail: existing.email,
      };
    }
  );

  app.post(
    "/provider/me/mfa/confirm",
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
      const actor = requireProviderJwt(request);
      if (!actor) {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "JWT required for MFA management",
        });
      }

      const body = request.body as { code: string };

      const [row] = await db
        .select({
          mfaSecretEnc: providerUsers.mfaSecretEnc,
          mfaPending: providerUsers.mfaPending,
          mfaEnabled: providerUsers.mfaEnabled,
        })
        .from(providerUsers)
        .where(eq(providerUsers.id, actor.providerUserId))
        .limit(1);

      if (!row?.mfaSecretEnc || !row.mfaPending) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "No MFA setup in progress. Call POST /provider/me/mfa/setup first.",
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
        .update(providerUsers)
        .set({
          mfaEnabled: true,
          mfaPending: false,
          updatedAt: now,
        })
        .where(eq(providerUsers.id, actor.providerUserId));

      audit({
        action: "config.changed",
        actor: actor.providerUserId,
        resource: actor.providerUserId,
        meta: { mfa: "provider_enabled" },
      });

      return reply.send({ ok: true });
    }
  );

  app.post(
    "/provider/me/mfa/cancel",
    {
      schema: {
        response: {
          200: z.object({ ok: z.literal(true) }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const actor = requireProviderJwt(request);
      if (!actor) {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "JWT required for MFA management",
        });
      }

      const now = new Date();
      await db
        .update(providerUsers)
        .set({
          mfaSecretEnc: null,
          mfaPending: false,
          mfaEnabled: false,
          updatedAt: now,
        })
        .where(eq(providerUsers.id, actor.providerUserId));

      audit({
        action: "config.changed",
        actor: actor.providerUserId,
        resource: actor.providerUserId,
        meta: { mfa: "provider_setup_cancelled" },
      });

      return reply.send({ ok: true });
    }
  );

  app.post(
    "/provider/me/mfa/disable",
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
      const actor = requireProviderJwt(request);
      if (!actor) {
        return reply.status(401).send({
          error: "Unauthorized",
          message: "JWT required for MFA management",
        });
      }

      const body = request.body as { password: string; code: string };

      const [row] = await db
        .select({
          passwordHash: providerUsers.passwordHash,
          mfaSecretEnc: providerUsers.mfaSecretEnc,
          mfaEnabled: providerUsers.mfaEnabled,
        })
        .from(providerUsers)
        .where(eq(providerUsers.id, actor.providerUserId))
        .limit(1);

      if (!row?.passwordHash) {
        return reply.status(400).send({ error: "Bad Request", message: "No password on account" });
      }

      const pwOk = await verifyProviderPassword(body.password, row.passwordHash);
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
        .update(providerUsers)
        .set({
          mfaSecretEnc: null,
          mfaPending: false,
          mfaEnabled: false,
          updatedAt: now,
        })
        .where(eq(providerUsers.id, actor.providerUserId));

      audit({
        action: "config.changed",
        actor: actor.providerUserId,
        resource: actor.providerUserId,
        meta: { mfa: "provider_disabled" },
      });

      return reply.send({ ok: true });
    }
  );
}
