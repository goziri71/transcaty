/**
 * Portal security & developers aggregate surface.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildPortalSecurityOverview } from "../../src/lib/portal-security-overview.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

export async function registerPortalSecurityRoutes(app: FastifyInstance) {
  app.get(
    "/portal/me/security/overview",
    {
      schema: {
        response: {
          200: z.object({
            mfa: z.object({
              enabled: z.boolean(),
              pendingSetup: z.boolean(),
            }),
            sessions: z.object({
              sessionVersion: z.number(),
              note: z.string(),
            }),
            apiKeys: z.object({
              active: z.number(),
              revoked: z.number(),
              total: z.number(),
              byEnvironment: z.object({
                test: z.number(),
                live: z.number(),
              }),
            }),
            webhook: z.object({
              configured: z.boolean(),
            }),
            ipAllowlist: z.object({
              test: z.object({ enabled: z.boolean(), cidrCount: z.number() }),
              live: z.object({ enabled: z.boolean(), cidrCount: z.number() }),
            }),
            recentSecurityActions: z.array(
              z.object({
                id: z.string(),
                action: z.string(),
                resource: z.string().nullable(),
                actorEmail: z.string().nullable(),
                createdAt: z.string(),
              })
            ),
            links: z.object({
              apiKeys: z.string(),
              ipRules: z.string(),
              webhook: z.string(),
              auditLog: z.string(),
              stepUp: z.string(),
              revokeSessions: z.string(),
              mfa: z.string(),
            }),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      return buildPortalSecurityOverview({
        merchantId: user.merchantId,
        merchantUserId: user.merchantUserId,
      });
    }
  );
}
