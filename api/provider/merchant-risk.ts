/**
 * Provider admin: merchant fraud blacklist (phone / account / email).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { merchantBlacklist } from "../../src/db/schema/index.js";
import { audit } from "../../src/lib/audit.js";
import { canProviderAccess } from "../../src/lib/provider-auth.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

function normalizeBlacklistValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

export async function registerProviderMerchantRiskRoutes(app: FastifyInstance) {
  app.get(
    "/provider/merchants/:merchantId/blacklist",
    {
      schema: {
        params: z.object({ merchantId: z.string().uuid() }),
        querystring: z.object({
          environment: z.enum(["test", "live"]).default("test"),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                entryType: z.enum(["phone", "account", "email"]),
                valueNormalized: z.string(),
                reason: z.string().nullable(),
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
      if (!canProviderAccess(actor.role, "merchant.status.write")) {
        return reply.status(403).send({ error: "Forbidden", message: "Insufficient role" });
      }
      const { merchantId } = request.params as { merchantId: string };
      const { environment } = request.query as { environment: "test" | "live" };
      const rows = await db
        .select()
        .from(merchantBlacklist)
        .where(
          and(eq(merchantBlacklist.merchantId, merchantId), eq(merchantBlacklist.environment, environment))
        )
        .orderBy(desc(merchantBlacklist.createdAt));
      return {
        items: rows.map((r) => ({
          id: r.id,
          entryType: r.entryType,
          valueNormalized: r.valueNormalized,
          reason: r.reason ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    }
  );

  app.post(
    "/provider/merchants/:merchantId/blacklist",
    {
      schema: {
        params: z.object({ merchantId: z.string().uuid() }),
        body: z.object({
          environment: z.enum(["test", "live"]).default("test"),
          entryType: z.enum(["phone", "account", "email"]),
          value: z.string().min(1).max(128),
          reason: z.string().max(500).optional(),
        }),
        response: {
          201: z.object({ id: z.string() }),
          401: errorResponse,
          403: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const actor = request.provider;
      if (!actor) return reply.status(401).send({ error: "Unauthorized" });
      if (!canProviderAccess(actor.role, "merchant.status.write")) {
        return reply.status(403).send({ error: "Forbidden", message: "Insufficient role" });
      }
      const { merchantId } = request.params as { merchantId: string };
      const body = request.body as {
        environment: "test" | "live";
        entryType: "phone" | "account" | "email";
        value: string;
        reason?: string;
      };
      const valueNormalized = normalizeBlacklistValue(body.value);
      const [row] = await db
        .insert(merchantBlacklist)
        .values({
          merchantId,
          environment: body.environment,
          entryType: body.entryType,
          valueNormalized,
          reason: body.reason?.trim() || null,
        })
        .onConflictDoNothing({
          target: [
            merchantBlacklist.merchantId,
            merchantBlacklist.environment,
            merchantBlacklist.entryType,
            merchantBlacklist.valueNormalized,
          ],
        })
        .returning({ id: merchantBlacklist.id });
      if (!row) {
        return reply.status(409).send({
          error: "Conflict",
          message: "Blacklist entry already exists",
        });
      }
      audit({
        action: "config.changed",
        resource: row.id,
        merchantId,
        meta: {
          kind: "merchant_blacklist_add",
          entryType: body.entryType,
          environment: body.environment,
        },
      });
      return reply.status(201).send({ id: row.id });
    }
  );

  app.delete(
    "/provider/merchants/:merchantId/blacklist/:entryId",
    {
      schema: {
        params: z.object({
          merchantId: z.string().uuid(),
          entryId: z.string().uuid(),
        }),
        response: {
          200: z.object({ ok: z.boolean() }),
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const actor = request.provider;
      if (!actor) return reply.status(401).send({ error: "Unauthorized" });
      if (!canProviderAccess(actor.role, "merchant.status.write")) {
        return reply.status(403).send({ error: "Forbidden", message: "Insufficient role" });
      }
      const { merchantId, entryId } = request.params as { merchantId: string; entryId: string };
      const [deleted] = await db
        .delete(merchantBlacklist)
        .where(and(eq(merchantBlacklist.id, entryId), eq(merchantBlacklist.merchantId, merchantId)))
        .returning({ id: merchantBlacklist.id });
      if (!deleted) {
        return reply.status(404).send({ error: "Not found", message: "Blacklist entry not found" });
      }
      audit({
        action: "config.changed",
        resource: entryId,
        merchantId,
        meta: { kind: "merchant_blacklist_remove" },
      });
      return { ok: true };
    }
  );
}
