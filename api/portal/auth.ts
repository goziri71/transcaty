/**
 * Portal auth routes: signup, login, logout.
 * No auth required for signup/login.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  merchants,
  merchantUsers,
  wallets,
} from "../../src/db/schema/index.js";
import {
  hashPassword,
  verifyPassword,
  signPortalToken,
} from "../../src/lib/portal-auth.js";

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

      await db.insert(wallets).values({
        merchantId: merchant.id,
        type: "merchant",
        balance: "0",
        currency: "BDT",
        status: "active",
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
      const body = request.body as { email: string; password: string };

      const [existing] = await db
        .select({
          id: merchantUsers.id,
          merchantId: merchantUsers.merchantId,
          email: merchantUsers.email,
          passwordHash: merchantUsers.passwordHash,
          role: merchantUsers.role,
          status: merchantUsers.status,
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

      const token = signPortalToken({
        merchantUserId: existing.id,
        merchantId: existing.merchantId,
        email: existing.email,
        role: existing.role,
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
}
