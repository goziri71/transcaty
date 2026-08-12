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
import { assertHttpsWebhookUrl } from "../../src/lib/https-url.js";
import { requirePortalAdminRole } from "../../src/lib/portal-roles.js";
import {
  requirePortalStepUp,
} from "../../src/lib/portal-auth.js";
import { audit } from "../../src/lib/audit.js";

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
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      if (!(await requirePortalAdminRole(request, reply))) return;
      if (!(await requirePortalStepUp(request, reply, "webhook.write"))) return;

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

      const rawUrl =
        body.webhookUrl === null || body.webhookUrl === ""
          ? null
          : body.webhookUrl?.trim() ?? null;
      const urlCheck = assertHttpsWebhookUrl(rawUrl);
      if (!urlCheck.ok) {
        return reply.status(400).send({ error: "Bad Request", message: urlCheck.message });
      }
      const url = urlCheck.url;
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

      audit({
        action: "portal.webhook.updated",
        merchantId: user.merchantId,
        merchantUserId: user.merchantUserId,
        actorEmail: user.email,
        meta: { configured: !!url },
      });

      return {
        webhookUrl: url,
        ...(webhookSecret && { webhookSecret }),
      };
    }
  );

  const deliveryItemSchema = z.object({
    id: z.string(),
    eventType: z.string(),
    transactionId: z.string().nullable(),
    targetUrl: z.string(),
    status: z.string(),
    httpStatus: z.number().nullable(),
    responseBody: z.string().nullable(),
    error: z.string().nullable(),
    attempt: z.number(),
    createdAt: z.string(),
    deliveredAt: z.string().nullable(),
  });

  app.get(
    "/portal/me/webhook/deliveries",
    {
      schema: {
        querystring: z.object({
          limit: z.coerce.number().min(1).max(100).default(20),
          offset: z.coerce.number().min(0).default(0),
          status: z.enum(["pending", "success", "failed"]).optional(),
        }),
        response: {
          200: z.object({
            items: z.array(deliveryItemSchema),
            total: z.number(),
            lastError: z.string().nullable(),
            limit: z.number(),
            offset: z.number(),
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
          message: "KYC verification required to view webhook deliveries",
        });
      }

      const q = request.query as {
        limit: number;
        offset: number;
        status?: "pending" | "success" | "failed";
      };
      const {
        listMerchantWebhookDeliveries,
      } = await import("../../src/lib/merchant-webhook.js");
      const result = await listMerchantWebhookDeliveries({
        merchantId: user.merchantId,
        limit: q.limit,
        offset: q.offset,
        status: q.status,
      });
      return { ...result, limit: q.limit, offset: q.offset };
    }
  );

  app.post(
    "/portal/me/webhook/deliveries/:id/replay",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({ id: z.string(), status: z.string() }),
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      if (!(await requirePortalAdminRole(request, reply))) return;
      if (!(await requirePortalStepUp(request, reply, "webhook.write"))) return;

      const { id } = request.params as { id: string };
      const { replayMerchantWebhookDelivery } = await import("../../src/lib/merchant-webhook.js");
      try {
        const result = await replayMerchantWebhookDelivery({
          merchantId: user.merchantId,
          deliveryId: id,
        });
        audit({
          action: "portal.webhook.updated",
          merchantId: user.merchantId,
          merchantUserId: user.merchantUserId,
          actorEmail: user.email,
          resource: id,
          meta: { kind: "replay", newDeliveryId: result.id, status: result.status },
        });
        return result;
      } catch (err) {
        const code = (err as Error & { statusCode?: number }).statusCode;
        if (code === 404) {
          return reply.status(404).send({
            error: "Not found",
            message: err instanceof Error ? err.message : "Delivery not found",
          });
        }
        return reply.status(400).send({
          error: "Bad Request",
          message: err instanceof Error ? err.message : "Replay failed",
        });
      }
    }
  );

  app.post(
    "/portal/me/webhook/test",
    {
      schema: {
        response: {
          200: z.object({ id: z.string(), status: z.string() }),
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      if (!(await requirePortalAdminRole(request, reply))) return;
      if (!(await requirePortalStepUp(request, reply, "webhook.write"))) return;

      const { sendMerchantWebhookTestPing } = await import("../../src/lib/merchant-webhook.js");
      try {
        const result = await sendMerchantWebhookTestPing(user.merchantId);
        audit({
          action: "portal.webhook.updated",
          merchantId: user.merchantId,
          merchantUserId: user.merchantUserId,
          actorEmail: user.email,
          meta: { kind: "test", deliveryId: result.id, status: result.status },
        });
        return result;
      } catch (err) {
        return reply.status(400).send({
          error: "Bad Request",
          message: err instanceof Error ? err.message : "Test ping failed",
        });
      }
    }
  );
}
