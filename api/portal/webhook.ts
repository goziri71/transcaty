/**
 * Portal webhook settings: configure callback URL for merchant dashboard (JWT auth).
 * Same persistence as PATCH /v1/me/webhook; use this route from the SPA (no HMAC).
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { merchants } from "../../src/db/schema/index.js";
import { encrypt } from "../../src/lib/encryption.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

export async function registerPortalWebhookRoutes(app: FastifyInstance) {
  app.get(
    "/portal/me/webhook",
    {
      schema: {
        response: {
          200: z.object({
            webhookUrl: z.string().nullable(),
          }),
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const [merchant] = await db
        .select({ kycStatus: merchants.kycStatus })
        .from(merchants)
        .where(eq(merchants.id, user.merchantId))
        .limit(1);

      if (merchant?.kycStatus !== "verified") {
        return reply.status(403).send({
          error: "Forbidden",
          message: "KYC verification required to view webhook settings",
        });
      }

      const [row] = await db
        .select({ webhookUrl: merchants.webhookUrl })
        .from(merchants)
        .where(eq(merchants.id, user.merchantId))
        .limit(1);

      return {
        webhookUrl: row?.webhookUrl?.trim() ? row.webhookUrl.trim() : null,
      };
    }
  );

  app.patch(
    "/portal/me/webhook",
    {
      schema: {
        body: z.object({ webhookUrl: z.string().url().optional().nullable() }),
        response: {
          200: z.object({
            webhookUrl: z.string().nullable(),
            webhookSecret: z.string().optional(),
          }),
          401: errorResponse,
          403: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const [merchant] = await db
        .select({ kycStatus: merchants.kycStatus })
        .from(merchants)
        .where(eq(merchants.id, user.merchantId))
        .limit(1);

      if (merchant?.kycStatus !== "verified") {
        return reply.status(403).send({
          error: "Forbidden",
          message: "KYC verification required to configure webhooks",
        });
      }

      const body = request.body as { webhookUrl?: string | null };
      const masterKey = process.env.ENCRYPTION_MASTER_KEY;
      if (!masterKey) {
        return reply.status(500).send({ error: "Internal", message: "Webhook config unavailable" });
      }

      const url = body.webhookUrl === null || body.webhookUrl === "" ? null : body.webhookUrl?.trim() ?? null;
      const webhookSecret = url ? randomBytes(32).toString("hex") : null;
      const webhookSecretEnc = webhookSecret ? encrypt(webhookSecret, masterKey) : null;

      await db
        .update(merchants)
        .set({
          webhookUrl: url,
          webhookSecretEnc,
          updatedAt: new Date(),
        })
        .where(eq(merchants.id, user.merchantId));

      return {
        webhookUrl: url,
        ...(webhookSecret && { webhookSecret }),
      };
    }
  );
}
