import type { FastifyInstance } from "fastify";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../src/db/index.js";
import { providerUsers } from "../../src/db/schema/index.js";
import {
  PROVIDER_ROLES,
  canProviderAccess,
  getProviderApiKey,
  hashProviderPassword,
  signProviderToken,
  verifyProviderPassword,
  type ProviderRole,
} from "../../src/lib/provider-auth.js";
import { audit } from "../../src/lib/audit.js";

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
            token: z.string(),
            user: z.object({
              id: z.string(),
              email: z.string(),
              role: z.enum(PROVIDER_ROLES),
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
          passwordHash: providerUsers.passwordHash,
          role: providerUsers.role,
          status: providerUsers.status,
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

      await db
        .update(providerUsers)
        .set({ lastLoginAt: new Date(), updatedAt: new Date() })
        .where(eq(providerUsers.id, user.id));

      const token = signProviderToken({
        providerUserId: user.id,
        email: user.email,
        role: user.role as ProviderRole,
      });

      return {
        token,
        user: {
          id: user.id,
          email: user.email,
          role: user.role as ProviderRole,
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
}

