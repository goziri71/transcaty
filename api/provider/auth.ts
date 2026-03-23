import type { FastifyInstance } from "fastify";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../src/db/index.js";
import { providerUsers } from "../../src/db/schema/index.js";
import {
  PROVIDER_ROLES,
  canProviderAccess,
  getProviderApiKey,
  getProviderPermissions,
  hashProviderPassword,
  signProviderToken,
  signProviderMfaPendingToken,
  verifyProviderMfaPendingToken,
  verifyProviderPassword,
  type ProviderRole,
} from "../../src/lib/provider-auth.js";
import { decryptTotpSecret, verifyTotp } from "../../src/lib/mfa-totp.js";
import { audit } from "../../src/lib/audit.js";
import { checkRedisRateLimit } from "../../src/lib/rate-limit-redis.js";
import {
  createProviderPasswordResetToken,
  consumeProviderResetToken,
} from "../../src/lib/password-reset.js";
import { queueTransactionalEmail } from "../../src/lib/transactional-email-queue.js";
import { getClientIp } from "../../src/lib/request-ip.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

export async function registerProviderAuthRoutes(app: FastifyInstance) {
  app.post(
    "/provider/auth/login",
    {
      schema: {
        body: z.object({
          email: z.string().email(),
          password: z.string().min(8).max(128),
        }),
        response: {
          200: z.object({
            requiresMfa: z.boolean().optional(),
            mfaToken: z.string().optional(),
            token: z.string().optional(),
            authType: z.literal("jwt"),
            tokenType: z.literal("Bearer"),
            expiresIn: z.string(),
            user: z.object({
              id: z.string(),
              email: z.string(),
              fullName: z.string().nullable(),
              role: z.enum(PROVIDER_ROLES),
              status: z.string(),
              lastLoginAt: z.string(),
              permissions: z.array(z.string()),
            }),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { email: string; password: string };
      const email = body.email.toLowerCase().trim();

      const [user] = await db
        .select({
          id: providerUsers.id,
          email: providerUsers.email,
          fullName: providerUsers.fullName,
          passwordHash: providerUsers.passwordHash,
          role: providerUsers.role,
          status: providerUsers.status,
          mfaEnabled: providerUsers.mfaEnabled,
        })
        .from(providerUsers)
        .where(eq(providerUsers.email, email))
        .limit(1);

      if (!user || user.status !== "active") {
        return reply.status(401).send({ error: "Unauthorized", message: "Invalid credentials" });
      }

      const valid = await verifyProviderPassword(body.password, user.passwordHash);
      if (!valid) {
        return reply.status(401).send({ error: "Unauthorized", message: "Invalid credentials" });
      }

      const now = new Date();
      await db
        .update(providerUsers)
        .set({ lastLoginAt: now, updatedAt: now })
        .where(eq(providerUsers.id, user.id));

      if (user.mfaEnabled) {
        const mfaToken = signProviderMfaPendingToken({
          providerUserId: user.id,
          email: user.email,
          role: user.role as ProviderRole,
        });
        return {
          requiresMfa: true,
          mfaToken,
          authType: "jwt" as const,
          tokenType: "Bearer" as const,
          expiresIn: "5m",
          user: {
            id: user.id,
            email: user.email,
            fullName: user.fullName,
            role: user.role as ProviderRole,
            status: user.status,
            lastLoginAt: now.toISOString(),
            permissions: getProviderPermissions(user.role as ProviderRole),
          },
        };
      }

      const token = signProviderToken({
        providerUserId: user.id,
        email: user.email,
        role: user.role as ProviderRole,
      });

      const providerBase = (
        process.env.PROVIDER_PUBLIC_URL ??
        process.env.APP_BASE_URL ??
        `http://localhost:${process.env.PORT ?? 3000}`
      ).replace(/\/$/, "");
      const changePasswordUrl = `${providerBase}/provider/forgot-password`;

      console.log(`[email] Queueing provider_login to ${user.email}`);
      queueTransactionalEmail({
        kind: "provider_login",
        to: user.email,
        ip: getClientIp(request),
        timestamp: new Date().toISOString(),
        changePasswordUrl,
      }).catch((e) => {
        console.error("[email] Failed to queue provider_login:", e);
      });

      return {
        token,
        authType: "jwt" as const,
        tokenType: "Bearer" as const,
        expiresIn: "12h",
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          role: user.role as ProviderRole,
          status: user.status,
          lastLoginAt: now.toISOString(),
          permissions: getProviderPermissions(user.role as ProviderRole),
        },
      };
    }
  );

  app.post(
    "/provider/auth/mfa/verify",
    {
      schema: {
        body: z.object({
          mfaToken: z.string().min(1),
          code: z.string().min(6).max(12),
        }),
        response: {
          200: z.object({
            token: z.string(),
            authType: z.literal("jwt"),
            tokenType: z.literal("Bearer"),
            expiresIn: z.string(),
            user: z.object({
              id: z.string(),
              email: z.string(),
              fullName: z.string().nullable(),
              role: z.enum(PROVIDER_ROLES),
              status: z.string(),
              lastLoginAt: z.string(),
              permissions: z.array(z.string()),
            }),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { mfaToken: string; code: string };
      const pending = verifyProviderMfaPendingToken(body.mfaToken);
      if (!pending) {
        return reply.status(401).send({ error: "Unauthorized", message: "Invalid or expired MFA token" });
      }

      const [u] = await db
        .select({
          mfaEnabled: providerUsers.mfaEnabled,
          mfaSecretEnc: providerUsers.mfaSecretEnc,
          fullName: providerUsers.fullName,
          status: providerUsers.status,
        })
        .from(providerUsers)
        .where(eq(providerUsers.id, pending.providerUserId))
        .limit(1);

      if (!u?.mfaEnabled || !u.mfaSecretEnc) {
        return reply.status(401).send({ error: "Unauthorized", message: "MFA not enabled for this account" });
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
          meta: { reason: "provider_mfa_invalid_code", providerUserId: pending.providerUserId },
        });
        return reply.status(401).send({ error: "Unauthorized", message: "Invalid authenticator code" });
      }

      const now = new Date();
      await db
        .update(providerUsers)
        .set({ lastLoginAt: now, updatedAt: now })
        .where(eq(providerUsers.id, pending.providerUserId));

      const token = signProviderToken({
        providerUserId: pending.providerUserId,
        email: pending.email,
        role: pending.role,
      });

      const providerBase = (
        process.env.PROVIDER_PUBLIC_URL ??
        process.env.APP_BASE_URL ??
        `http://localhost:${process.env.PORT ?? 3000}`
      ).replace(/\/$/, "");
      const changePasswordUrl = `${providerBase}/provider/forgot-password`;

      console.log(`[email] Queueing provider_login (MFA) to ${pending.email}`);
      queueTransactionalEmail({
        kind: "provider_login",
        to: pending.email,
        ip: getClientIp(request),
        timestamp: new Date().toISOString(),
        changePasswordUrl,
      }).catch((e) => {
        console.error("[email] Failed to queue provider_login (MFA):", e);
      });

      return {
        token,
        authType: "jwt" as const,
        tokenType: "Bearer" as const,
        expiresIn: "12h",
        user: {
          id: pending.providerUserId,
          email: pending.email,
          fullName: u.fullName,
          role: pending.role,
          status: u.status,
          lastLoginAt: now.toISOString(),
          permissions: getProviderPermissions(pending.role),
        },
      };
    }
  );

  app.post(
    "/provider/auth/bootstrap",
    {
      schema: {
        body: z.object({
          email: z.string().email(),
          password: z.string().min(8).max(128),
          fullName: z.string().max(200).optional(),
        }),
        response: {
          201: z.object({
            id: z.string(),
            email: z.string(),
            role: z.literal("super_admin"),
          }),
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      // Bootstrap is intentionally protected by provider API key only.
      const apiKey = getProviderApiKey();
      const headerKey = request.headers["x-provider-key"] as string | undefined;
      const bearer = request.headers.authorization?.startsWith("Bearer ")
        ? request.headers.authorization.slice(7).trim()
        : undefined;
      const provided = headerKey ?? bearer;
      if (!apiKey || !provided || provided !== apiKey) {
        return reply.status(401).send({ error: "Unauthorized", message: "Provider API key required for bootstrap" });
      }

      const [existingSuper] = await db
        .select({ id: providerUsers.id })
        .from(providerUsers)
        .where(eq(providerUsers.role, "super_admin"))
        .limit(1);
      if (existingSuper) {
        return reply.status(400).send({ error: "Bad Request", message: "Super admin already exists" });
      }

      const body = request.body as { email: string; password: string; fullName?: string };
      const email = body.email.toLowerCase().trim();
      const hash = await hashProviderPassword(body.password);
      const [created] = await db
        .insert(providerUsers)
        .values({
          email,
          passwordHash: hash,
          fullName: body.fullName?.trim() || null,
          role: "super_admin",
          status: "active",
        })
        .returning({
          id: providerUsers.id,
          email: providerUsers.email,
          role: providerUsers.role,
        });

      audit({
        action: "config.changed",
        actor: "provider:bootstrap",
        resource: created.id,
        meta: { email: created.email, role: created.role },
      });

      return reply.status(201).send({
        id: created.id,
        email: created.email,
        role: "super_admin",
      });
    }
  );

  app.get(
    "/provider/auth/users",
    {
      schema: {
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                email: z.string(),
                fullName: z.string().nullable(),
                role: z.enum(PROVIDER_ROLES),
                status: z.string(),
                lastLoginAt: z.string().nullable(),
                createdAt: z.string(),
              })
            ),
          }),
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const actor = request.provider;
      if (!actor) return reply.status(401).send({ error: "Unauthorized" });
      if (!canProviderAccess(actor.role, "provider.users.manage")) {
        return reply.status(403).send({ error: "Forbidden", message: "Insufficient role permission" });
      }

      const rows = await db
        .select({
          id: providerUsers.id,
          email: providerUsers.email,
          fullName: providerUsers.fullName,
          role: providerUsers.role,
          status: providerUsers.status,
          lastLoginAt: providerUsers.lastLoginAt,
          createdAt: providerUsers.createdAt,
        })
        .from(providerUsers)
        .orderBy(desc(providerUsers.createdAt));

      return {
        items: rows.map((r) => ({
          id: r.id,
          email: r.email,
          fullName: r.fullName,
          role: r.role as ProviderRole,
          status: r.status,
          lastLoginAt: r.lastLoginAt ? r.lastLoginAt.toISOString() : null,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    }
  );

  app.post(
    "/provider/auth/users",
    {
      schema: {
        body: z.object({
          email: z.string().email(),
          password: z.string().min(8).max(128),
          fullName: z.string().max(200).optional(),
          role: z.enum(PROVIDER_ROLES),
        }),
        response: {
          201: z.object({
            id: z.string(),
            email: z.string(),
            role: z.enum(PROVIDER_ROLES),
            status: z.string(),
          }),
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const actor = request.provider;
      if (!actor) return reply.status(401).send({ error: "Unauthorized" });
      if (!canProviderAccess(actor.role, "provider.users.manage")) {
        return reply.status(403).send({ error: "Forbidden", message: "Insufficient role permission" });
      }

      const body = request.body as {
        email: string;
        password: string;
        fullName?: string;
        role: ProviderRole;
      };
      const email = body.email.toLowerCase().trim();
      const [exists] = await db
        .select({ id: providerUsers.id })
        .from(providerUsers)
        .where(eq(providerUsers.email, email))
        .limit(1);
      if (exists) {
        return reply.status(400).send({ error: "Bad Request", message: "Email already exists" });
      }

      const hash = await hashProviderPassword(body.password);
      const [created] = await db
        .insert(providerUsers)
        .values({
          email,
          passwordHash: hash,
          fullName: body.fullName?.trim() || null,
          role: body.role,
          status: "active",
        })
        .returning({
          id: providerUsers.id,
          email: providerUsers.email,
          role: providerUsers.role,
          status: providerUsers.status,
        });

      audit({
        action: "config.changed",
        actor: actor.providerUserId ?? "provider:api_key",
        resource: created.id,
        meta: { createdProviderUser: created.email, role: created.role },
      });

      return reply.status(201).send({
        id: created.id,
        email: created.email,
        role: created.role as ProviderRole,
        status: created.status,
      });
    }
  );

  app.patch(
    "/provider/auth/users/:userId",
    {
      schema: {
        params: z.object({ userId: z.string().uuid() }),
        body: z.object({
          role: z.enum(PROVIDER_ROLES).optional(),
          status: z.enum(["active", "suspended"]).optional(),
          fullName: z.string().max(200).optional(),
          password: z.string().min(8).max(128).optional(),
        }),
        response: {
          200: z.object({
            id: z.string(),
            role: z.enum(PROVIDER_ROLES),
            status: z.string(),
          }),
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const actor = request.provider;
      if (!actor) return reply.status(401).send({ error: "Unauthorized" });
      if (!canProviderAccess(actor.role, "provider.users.manage")) {
        return reply.status(403).send({ error: "Forbidden", message: "Insufficient role permission" });
      }

      const { userId } = request.params as { userId: string };
      const body = request.body as {
        role?: ProviderRole;
        status?: "active" | "suspended";
        fullName?: string;
        password?: string;
      };
      if (!body.role && !body.status && body.fullName == null && !body.password) {
        return reply.status(400).send({ error: "Bad Request", message: "No fields to update" });
      }

      const [existing] = await db
        .select({
          id: providerUsers.id,
          role: providerUsers.role,
          status: providerUsers.status,
        })
        .from(providerUsers)
        .where(eq(providerUsers.id, userId))
        .limit(1);
      if (!existing) {
        return reply.status(404).send({ error: "Not found", message: "Provider user not found" });
      }

      if (existing.role === "super_admin" && body.status === "suspended") {
        const [superAdminsCount] = await db
          .select({ count: count() })
          .from(providerUsers)
          .where(and(eq(providerUsers.role, "super_admin"), eq(providerUsers.status, "active")));
        if (Number(superAdminsCount?.count ?? 0) <= 1) {
          return reply.status(400).send({
            error: "Bad Request",
            message: "Cannot suspend the last active super admin",
          });
        }
      }

      const patch: {
        role?: ProviderRole;
        status?: "active" | "suspended";
        fullName?: string | null;
        passwordHash?: string;
        updatedAt: Date;
      } = { updatedAt: new Date() };

      if (body.role) patch.role = body.role;
      if (body.status) patch.status = body.status;
      if (body.fullName != null) patch.fullName = body.fullName.trim() || null;
      if (body.password) patch.passwordHash = await hashProviderPassword(body.password);

      const [updated] = await db
        .update(providerUsers)
        .set(patch)
        .where(eq(providerUsers.id, userId))
        .returning({
          id: providerUsers.id,
          role: providerUsers.role,
          status: providerUsers.status,
        });

      audit({
        action: "config.changed",
        actor: actor.providerUserId ?? "provider:api_key",
        resource: userId,
        meta: {
          previousRole: existing.role,
          newRole: updated.role,
          previousStatus: existing.status,
          newStatus: updated.status,
          passwordChanged: !!body.password,
        },
      });

      return {
        id: updated.id,
        role: updated.role as ProviderRole,
        status: updated.status,
      };
    }
  );

  app.post(
    "/provider/auth/forgot-password",
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
        `provider:forgot:${ip}`,
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
      const created = await createProviderPasswordResetToken(email);
      const message =
        "If an account exists for this email, you will receive reset instructions shortly.";

      if (created) {
        const base = (
          process.env.PROVIDER_PUBLIC_URL ??
          process.env.APP_BASE_URL ??
          "http://localhost:3000"
        ).replace(/\/$/, "");
        const resetUrl = `${base}/provider/reset-password?token=${encodeURIComponent(created.rawToken)}`;

        await queueTransactionalEmail({
          kind: "provider_password_reset",
          to: email,
          resetUrl,
        });

        audit({
          action: "auth.password_reset_requested",
          meta: { realm: "provider" },
        });
      }

      return reply.send({ ok: true, message });
    }
  );

  app.post(
    "/provider/auth/reset-password",
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
        `provider:reset:${ip}`,
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
      const result = await consumeProviderResetToken(body.token, body.password);
      if (!result.ok) {
        return reply.status(400).send({ error: "Bad Request", message: result.reason });
      }

      audit({
        action: "auth.password_reset_completed",
        resource: result.userId,
        meta: { realm: "provider" },
      });

      return reply.send({ ok: true });
    }
  );
}

