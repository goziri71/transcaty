/**
 * Merchant audit log (persisted events with merchantId).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, desc, count } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { merchantAuditLog } from "../../src/db/schema/index.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

export async function registerPortalAuditLogRoutes(app: FastifyInstance) {
  app.get(
    "/portal/me/audit-log",
    {
      schema: {
        querystring: z.object({
          limit: z.coerce.number().min(1).max(100).default(50),
          offset: z.coerce.number().min(0).default(0),
          action: z.string().max(120).optional(),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                action: z.string(),
                resource: z.string().nullable(),
                meta: z.record(z.unknown()).nullable(),
                actorEmail: z.string().nullable(),
                merchantUserId: z.string().nullable(),
                createdAt: z.string(),
              })
            ),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const { limit, offset, action } = request.query as {
        limit: number;
        offset: number;
        action?: string;
      };

      const conditions = [eq(merchantAuditLog.merchantId, user.merchantId)];
      if (action?.trim()) {
        conditions.push(eq(merchantAuditLog.action, action.trim()));
      }

      const [totalResult] = await db
        .select({ count: count() })
        .from(merchantAuditLog)
        .where(and(...conditions));

      const rows = await db
        .select({
          id: merchantAuditLog.id,
          action: merchantAuditLog.action,
          resource: merchantAuditLog.resource,
          meta: merchantAuditLog.meta,
          actorEmail: merchantAuditLog.actorEmail,
          merchantUserId: merchantAuditLog.merchantUserId,
          createdAt: merchantAuditLog.createdAt,
        })
        .from(merchantAuditLog)
        .where(and(...conditions))
        .orderBy(desc(merchantAuditLog.createdAt))
        .limit(limit)
        .offset(offset);

      return {
        items: rows.map((r) => ({
          id: r.id,
          action: r.action,
          resource: r.resource,
          meta: r.meta,
          actorEmail: r.actorEmail,
          merchantUserId: r.merchantUserId,
          createdAt: r.createdAt.toISOString(),
        })),
        total: Number(totalResult?.count ?? 0),
        limit,
        offset,
      };
    }
  );
}
