/**
 * Merchant audit log (persisted events with merchantId).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, desc, count, like } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { merchantAuditLog } from "../../src/db/schema/index.js";
import { requirePortalStepUp } from "../../src/lib/portal-auth.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function auditRowsToCsv(
  rows: Array<{
    id: string;
    action: string;
    resource: string | null;
    actorEmail: string | null;
    merchantUserId?: string | null;
    meta: unknown;
    createdAt: Date;
  }>
): string {
  const header = ["id", "action", "resource", "actorEmail", "merchantUserId", "meta", "createdAt"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.action,
        r.resource ?? "",
        r.actorEmail ?? "",
        r.merchantUserId ?? "",
        r.meta == null ? "" : JSON.stringify(r.meta),
        r.createdAt.toISOString(),
      ]
        .map((c) => csvEscape(String(c)))
        .join(",")
    );
  }
  return lines.join("\n") + "\n";
}

export async function registerPortalAuditLogRoutes(app: FastifyInstance) {
  app.get(
    "/portal/me/audit-log",
    {
      schema: {
        querystring: z.object({
          limit: z.coerce.number().min(1).max(5000).default(50),
          offset: z.coerce.number().min(0).default(0),
          action: z.string().max(120).optional(),
          actionPrefix: z.string().max(80).optional(),
          format: z.enum(["json", "csv"]).default("json"),
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
          403: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const { limit, offset, action, actionPrefix, format } = request.query as {
        limit: number;
        offset: number;
        action?: string;
        actionPrefix?: string;
        format: "json" | "csv";
      };

      if (format === "csv") {
        if (!(await requirePortalStepUp(request, reply, "audit.export"))) return;
      }

      const conditions = [eq(merchantAuditLog.merchantId, user.merchantId)];
      if (action?.trim()) {
        conditions.push(eq(merchantAuditLog.action, action.trim()));
      } else if (actionPrefix?.trim()) {
        // Escape LIKE wildcards in the user-supplied prefix.
        const prefix = actionPrefix.trim().replace(/[%_\\]/g, "\\$&");
        conditions.push(like(merchantAuditLog.action, `${prefix}%`));
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
        .limit(format === "csv" ? Math.min(limit, 5000) : Math.min(limit, 100))
        .offset(offset);

      if (format === "csv") {
        reply.header("content-type", "text/csv; charset=utf-8");
        reply.header("content-disposition", 'attachment; filename="audit-log.csv"');
        return reply.send(auditRowsToCsv(rows));
      }

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
