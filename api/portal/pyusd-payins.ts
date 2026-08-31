/**
 * Portal PYUSD (Tekko) one-time checkout. Isolated from Brazil/Bangladesh portal routes.
 * Settle currency is PYUSD-USDC (display: PYUSD USDC), isolated from Europe USDC. Live-only upstream.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { eq, and, gt } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { merchants, idempotencyKeys } from "../../src/db/schema/index.js";
import {
  createTekkoPyusdPaymentIntent,
  getTekkoPyusdPaymentIntentStatus,
  logTekkoPyusdFailure,
  TEKKO_PYUSD_PROVIDER,
  TEKKO_SETTLEMENT_CURRENCY,
  TEKKO_SETTLEMENT_DISPLAY_NAME,
} from "../../services/integrations/tekko/index.js";
import { LIMITS } from "../../src/lib/limits.js";
import { audit } from "../../src/lib/audit.js";
import { assertMerchantMarketApiAccess } from "../../src/lib/merchant-markets.js";
import {
  merchantPaymentFlowErrorResponse,
  sendMerchantFacingReply,
} from "../../src/lib/merchant-facing-errors.js";
import {
  transactionFeeBreakdownFieldsSchema,
  buildTransactionFeeBreakdown,
  attachFeeBreakdown,
} from "../../src/lib/billing/transaction-fee-breakdown.js";
import { requirePortalMoneyGuards } from "../../src/lib/portal-roles.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});
const merchantFacingError = errorResponse.extend({
  code: z.string().optional(),
});

/** Gate portal PYUSD flows on live-only Tekko, KYC, and the `pyusd` market. */
async function requirePortalPyusdAccess(
  merchantId: string,
  environment: "test" | "live",
  reply: FastifyReply
): Promise<boolean> {
  if (environment === "test") {
    const gateErr = new Error("PYUSD checkout is only available in the live environment");
    logTekkoPyusdFailure(reply.request.log, {
      surface: "portal.gate",
      err: gateErr,
      merchantId,
      environment,
      httpStatus: 503,
      merchantCode: "payment_unavailable",
      logDetail: "test_environment_rejected",
    });
    reply.status(503).send({
      error: "Service Unavailable",
      message: "PYUSD checkout is only available in the live environment",
      code: "payment_unavailable",
    });
    return false;
  }

  const kycRequired = process.env.KYC_REQUIRED === "true";

  if (environment === "live" || kycRequired) {
    const [merchant] = await db
      .select({ status: merchants.status, kycStatus: merchants.kycStatus })
      .from(merchants)
      .where(eq(merchants.id, merchantId))
      .limit(1);
    if (!merchant) {
      reply.status(401).send({ error: "Unauthorized" });
      return false;
    }
    if (environment === "live" && merchant.status !== "active") {
      reply.status(403).send({ error: "Forbidden", message: "Merchant account is not active" });
      return false;
    }
    if (merchant.kycStatus !== "verified") {
      reply.status(403).send({
        error: "Forbidden",
        message: "KYC verification required for PYUSD payments",
      });
      return false;
    }
  }

  const gate = await assertMerchantMarketApiAccess({
    merchantId,
    market: "pyusd",
    kycRequired,
  });
  if (!gate.ok) {
    reply.status(403).send({ error: "Forbidden", message: gate.message, code: gate.code });
    return false;
  }

  return true;
}

export async function registerPortalPyusdRoutes(app: FastifyInstance) {
  app.post(
    "/portal/me/pyusd/payment-intents",
    {
      schema: {
        body: z.object({
          environment: z.enum(["test", "live"]).default("live"),
          amount: z.string(),
          merchantReference: z.string().min(1).max(128),
          expiresInMinutes: z.number().int().min(5).max(1440).optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        }),
        response: {
          201: z
            .object({
              transactionId: z.string(),
              paymentIntentId: z.string(),
              status: z.string(),
              settlementStatus: z.string().nullable(),
              amount: z.string(),
              currency: z.literal("PYUSD"),
              settlementCurrency: z.literal(TEKKO_SETTLEMENT_CURRENCY),
              settlementCurrencyLabel: z.literal(TEKKO_SETTLEMENT_DISPLAY_NAME),
              network: z.literal("ethereum"),
              depositAddress: z.string(),
              expiresAt: z.string().nullable(),
              environment: z.enum(["test", "live"]),
            })
            .merge(transactionFeeBreakdownFieldsSchema.partial()),
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          503: merchantFacingError,
          500: merchantFacingError,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      if (!(await requirePortalMoneyGuards(request, reply))) return;

      const idemKey = request.headers["idempotency-key"] as string | undefined;
      if (idemKey?.trim()) {
        const [cached] = await db
          .select({ responseSnapshot: idempotencyKeys.responseSnapshot })
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.key, idemKey.trim()),
              eq(idempotencyKeys.merchantId, user.merchantId),
              gt(idempotencyKeys.expiresAt, new Date())
            )
          )
          .limit(1);
        if (cached) return reply.status(201).send(JSON.parse(cached.responseSnapshot));
      }

      const body = request.body as {
        environment: "test" | "live";
        amount: string;
        merchantReference: string;
        expiresInMinutes?: number;
        metadata?: Record<string, unknown>;
      };

      if (!(await requirePortalPyusdAccess(user.merchantId, body.environment, reply))) return;

      const bounds = LIMITS.tekkoPyusd.payin;
      const amt = parseFloat(body.amount);
      if (!Number.isFinite(amt) || amt < bounds.min || amt > bounds.max) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Amount must be between ${bounds.min} and ${bounds.max} PYUSD`,
        });
      }

      const baseUrl = process.env.APP_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

      try {
        const result = await createTekkoPyusdPaymentIntent({
          merchantId: user.merchantId,
          environment: body.environment,
          amount: body.amount,
          merchantReference: body.merchantReference,
          expiresInMinutes: body.expiresInMinutes,
          metadata: body.metadata,
          baseUrl,
        });
        const breakdown = await buildTransactionFeeBreakdown({
          merchantId: user.merchantId,
          environment: body.environment,
          transactionId: result.transactionId,
          type: "payin",
          status: "pending",
          amount: result.amount,
          currency: "PYUSD",
          provider: TEKKO_PYUSD_PROVIDER,
        });
        const response = attachFeeBreakdown(
          {
            transactionId: result.transactionId,
            paymentIntentId: result.paymentIntentId,
            status: result.status,
            settlementStatus: result.settlementStatus,
            amount: result.amount,
            currency: "PYUSD" as const,
            settlementCurrency: TEKKO_SETTLEMENT_CURRENCY,
            settlementCurrencyLabel: TEKKO_SETTLEMENT_DISPLAY_NAME,
            network: "ethereum" as const,
            depositAddress: result.depositAddress,
            expiresAt: result.expiresAt,
            environment: result.environment,
          },
          breakdown
        );
        if (idemKey?.trim()) {
          try {
            await db.insert(idempotencyKeys).values({
              key: idemKey.trim(),
              merchantId: user.merchantId,
              responseSnapshot: JSON.stringify(response),
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            });
          } catch {
            /* duplicate key — ignore */
          }
        }
        return reply.status(201).send(response);
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        audit({
          action: "portal.payin.failed",
          merchantId: user.merchantId,
          merchantUserId: user.merchantUserId,
          actorEmail: user.email,
          meta: { message: rawMsg, market: "pyusd" },
        });
        const mapped = merchantPaymentFlowErrorResponse(err);
        logTekkoPyusdFailure(request.log, {
          surface: "portal.create",
          err,
          merchantId: user.merchantId,
          environment: body.environment,
          merchantReference: body.merchantReference,
          amount: body.amount,
          httpStatus: mapped.status,
          merchantCode: mapped.body.code,
          logDetail: mapped.logDetail ?? rawMsg,
        });
        sendMerchantFacingReply(reply, mapped);
      }
    }
  );

  app.get(
    "/portal/me/pyusd/payment-intents/:transactionId",
    {
      schema: {
        params: z.object({ transactionId: z.string().uuid() }),
        querystring: z.object({
          environment: z.enum(["test", "live"]).optional(),
        }),
        response: {
          200: z.object({
            transactionId: z.string(),
            paymentIntentId: z.string().nullable(),
            status: z.string(),
            settlementStatus: z.string().nullable(),
            amount: z.string(),
            paidAmount: z.string().nullable(),
            currency: z.string(),
            settlementCurrency: z.literal(TEKKO_SETTLEMENT_CURRENCY),
            settlementCurrencyLabel: z.literal(TEKKO_SETTLEMENT_DISPLAY_NAME),
            network: z.literal("ethereum"),
            depositAddress: z.string().nullable(),
            expiresAt: z.string().nullable(),
            environment: z.string(),
            settled: z.boolean(),
          }),
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          503: merchantFacingError,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const { transactionId } = request.params as { transactionId: string };
      const query = request.query as { environment?: "test" | "live" };
      const env = query.environment ?? "live";
      if (!(await requirePortalPyusdAccess(user.merchantId, env, reply))) return;

      try {
        const view = await getTekkoPyusdPaymentIntentStatus({
          merchantId: user.merchantId,
          transactionId,
        });
        if (!view) {
          return reply
            .status(404)
            .send({ error: "Not found", message: "PYUSD payment intent not found" });
        }
        return {
          ...view,
          settlementCurrency: TEKKO_SETTLEMENT_CURRENCY,
          settlementCurrencyLabel: TEKKO_SETTLEMENT_DISPLAY_NAME,
          network: "ethereum" as const,
        };
      } catch (err) {
        const mapped = merchantPaymentFlowErrorResponse(err);
        logTekkoPyusdFailure(request.log, {
          surface: "portal.get",
          err,
          merchantId: user.merchantId,
          environment: env,
          transactionId,
          httpStatus: mapped.status,
          merchantCode: mapped.body.code,
          logDetail: mapped.logDetail,
        });
        sendMerchantFacingReply(reply, mapped);
        return;
      }
    }
  );
}
