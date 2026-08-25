/**
 * Portal API IP allowlist: merchants manage /v1 HMAC API access by source IP.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { merchants } from "../../src/db/schema/index.js";
import { audit } from "../../src/lib/audit.js";
import { getTrustedClientIp } from "../../src/lib/client-ip.js";
import {
  getMerchantApiIpRules,
  upsertMerchantApiIpRules,
} from "../../src/lib/merchant-api-ip-rules.js";
import { requirePortalAdminRole } from "../../src/lib/portal-roles.js";

const ENV = ["test", "live"] as const;

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

const rulesResponse = z.object({
  merchantId: z.string(),
  environment: z.enum(ENV),
  enabled: z.boolean(),
  enforceMode: z.string(),
  cidrs: z.array(z.string()),
  notes: z.string().nullable(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
  clientIp: z.string().optional(),
});

async function requireVerifiedMerchant(merchantId: string, reply: FastifyReply): Promise<boolean> {
  const [merchant] = await db
    .select({ kycStatus: merchants.kycStatus })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);

  if (merchant?.kycStatus !== "verified") {
    reply.status(403).send({
      error: "Forbidden",
      message: "KYC verification required to manage API IP allowlist",
    });
    return false;
  }
  return true;
}

export async function registerPortalApiIpRulesRoutes(app: FastifyInstance) {
  app.get(
    "/portal/me/api-ip-rules",
    {
      schema: {
        querystring: z.object({ environment: z.enum(ENV).default("test") }),
        response: {
          200: rulesResponse,
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      if (!(await requireVerifiedMerchant(user.merchantId, reply))) return;

      const { environment } = request.query as { environment: (typeof ENV)[number] };
      const rules = await getMerchantApiIpRules(user.merchantId, environment);

      return {
        ...rules,
        clientIp: getTrustedClientIp(request),
      };
    }
  );

  app.put(
    "/portal/me/api-ip-rules",
    {
      schema: {
        body: z.object({
          environment: z.enum(ENV),
          enabled: z.boolean(),
          enforceMode: z.enum(["strict", "log_only"]).default("strict"),
          cidrs: z.array(z.string()),
          notes: z.string().optional().nullable(),
        }),
        response: {
          200: rulesResponse,
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

      if (!(await requireVerifiedMerchant(user.merchantId, reply))) return;

      const body = request.body as {
        environment: (typeof ENV)[number];
        enabled: boolean;
        enforceMode: "strict" | "log_only";
        cidrs: string[];
        notes?: string | null;
      };

      const result = await upsertMerchantApiIpRules({
        merchantId: user.merchantId,
        updatedBy: user.email,
        rules: body,
      });

      if (!result.ok) {
        return reply.status(400).send({ error: "Bad Request", message: result.message });
      }

      audit({
        action: "portal.api_ip_rules.updated",
        merchantId: user.merchantId,
        merchantUserId: user.merchantUserId,
        actorEmail: user.email,
        meta: {
          environment: body.environment,
          enabled: body.enabled,
          enforceMode: body.enforceMode,
          cidrCount: body.cidrs.length,
        },
      });

      const rules = await getMerchantApiIpRules(user.merchantId, body.environment);
      return {
        ...rules,
        clientIp: getTrustedClientIp(request),
      };
    }
  );
}
