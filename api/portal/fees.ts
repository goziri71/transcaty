/**
 * Merchant portal: read-only fee / pricing experience.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildMerchantFeesExperience } from "../../src/lib/merchant-pricing-experience.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

const feeLineSchema = z.object({
  id: z.string(),
  source: z.enum(["schedule", "legacy"]),
  environment: z.union([z.enum(["test", "live"]), z.literal("legacy")]),
  rail: z.string(),
  currency: z.string(),
  feeType: z.enum(["payin", "payout"]),
  billingMode: z.string(),
  feePercentage: z.string().nullable(),
  feeFlat: z.string().nullable(),
  feeMin: z.string().nullable(),
  feeMax: z.string().nullable(),
  effectiveFrom: z.string().nullable(),
  effectiveTo: z.string().nullable(),
  status: z.string(),
});

export async function registerPortalFeesRoutes(app: FastifyInstance) {
  app.get(
    "/portal/me/fees",
    {
      schema: {
        querystring: z.object({
          environment: z.enum(["test", "live"]).optional(),
        }),
        response: {
          200: z.object({
            environment: z.union([z.enum(["test", "live"]), z.literal("all")]),
            items: z.array(feeLineSchema),
            note: z.string(),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      const { environment } = request.query as { environment?: "test" | "live" };
      return buildMerchantFeesExperience({
        merchantId: user.merchantId,
        environment,
      });
    }
  );
}
