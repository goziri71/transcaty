/**
 * Portal India H2H UPI pay-ins (mirror of /v1/h2h/payin-instances*).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { merchants, transactions } from "../../src/db/schema/index.js";
import { LIMITS } from "../../src/lib/limits.js";
import { audit } from "../../src/lib/audit.js";
import { assertMerchantMarketApiAccess } from "../../src/lib/merchant-markets.js";
import { validateMerchantReturnUrl } from "../../src/lib/merchant-return-url.js";
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
import { withIdempotency } from "../../src/lib/idempotency.js";
import {
  createTyltH2hPayinInstance,
  getMerchantH2hPayinStatus,
  tyltH2hBuyerConfirmsPayment,
  isTyltH2hPayinMetadata,
  parseTransactionMetadata,
  pickTyltJsonPrimaryMessage,
} from "../../services/integrations/tylt/index.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
  code: z.string().optional(),
});
const merchantFacingError = errorResponse;

async function requirePortalIndiaAccess(
  merchantId: string,
  environment: "test" | "live",
  reply: FastifyReply
): Promise<boolean> {
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
        message: "KYC verification required for India pay-ins",
      });
      return false;
    }
  }

  const gate = await assertMerchantMarketApiAccess({
    merchantId,
    market: "india",
    kycRequired,
  });
  if (!gate.ok) {
    reply.status(403).send({
      error: "Forbidden",
      message: gate.message,
      code: gate.code,
    });
    return false;
  }

  return true;
}

export async function registerPortalH2hPayinRoutes(app: FastifyInstance) {
  app.post(
    "/portal/me/h2h/payin-instances",
    {
      schema: {
        body: z
          .object({
            environment: z.enum(["test", "live"]).default("test"),
            amount: z.string(),
            currencySymbol: z.enum(["USDT", "INR"]),
            returnUrl: z.string().min(1).optional(),
            userEmail: z.string().email().optional(),
            userDetails: z
              .object({
                email: z.string().email(),
                name: z.string().min(1).optional(),
                phone: z.string().optional(),
              })
              .optional(),
          })
          .refine((b) => b.userDetails != null || b.userEmail != null, {
            message: "userDetails (preferred) or userEmail is required",
            path: ["userDetails"],
          }),
        response: {
          201: z
            .object({
              transactionId: z.string(),
              status: z.literal("pending"),
              amount: z.string(),
              currency: z.enum(["USDT", "INR"]),
              instanceId: z.string(),
              tradeEventId: z.number().nullable().optional(),
              paymentDetails: z.record(z.unknown()),
              paymentInstructions: z.record(z.unknown()).nullable().optional(),
              detailsSource: z.literal("create").optional(),
              expiresAt: z.string().nullable().optional(),
              environment: z.enum(["test", "live"]),
            })
            .merge(transactionFeeBreakdownFieldsSchema.partial()),
          400: merchantFacingError,
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

      const body = request.body as {
        environment: "test" | "live";
        amount: string;
        currencySymbol: "USDT" | "INR";
        returnUrl?: string;
        userEmail?: string;
        userDetails?: { email: string; name?: string; phone?: string };
      };

      if (!(await requirePortalIndiaAccess(user.merchantId, body.environment, reply))) return;

      let normalizedReturn: string | undefined;
      if (body.returnUrl?.trim()) {
        const returnCheck = validateMerchantReturnUrl(body.returnUrl);
        if (!returnCheck.ok) {
          return reply.status(400).send({ error: "Bad Request", message: returnCheck.message });
        }
        normalizedReturn = returnCheck.normalized;
      }

      const bounds = LIMITS.tyltCrossRamp[body.currencySymbol];
      const amt = parseFloat(body.amount);
      if (!Number.isFinite(amt) || amt < bounds.min || amt > bounds.max) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Amount must be between ${bounds.min} and ${bounds.max} ${body.currencySymbol}`,
        });
      }

      const baseUrl = process.env.APP_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
      try {
        const payload = await withIdempotency(
          { request, reply, merchantId: user.merchantId, body, required: true },
          async () => {
            const userDetails =
              body.userDetails ?? (body.userEmail != null ? { email: body.userEmail } : { email: "" });
            const result = await createTyltH2hPayinInstance({
              merchantId: user.merchantId,
              environment: body.environment,
              baseUrl,
              amount: body.amount,
              currencySymbol: body.currencySymbol,
              userDetails,
              returnUrl: normalizedReturn,
            });
            const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
            const breakdown = await buildTransactionFeeBreakdown({
              merchantId: user.merchantId,
              environment: body.environment,
              transactionId: result.transactionId,
              type: "payin",
              status: "pending",
              amount: result.amount,
              paidAmount: null,
              currency: result.currency,
              provider: "tylt-h2h-upi",
              metadata: null,
            });
            const built = attachFeeBreakdown(
              {
                transactionId: result.transactionId,
                status: "pending" as const,
                amount: result.amount,
                currency: result.currency as "USDT" | "INR",
                instanceId: result.instanceId,
                tradeEventId: result.tradeEventId ?? null,
                paymentDetails: result.paymentDetails,
                paymentInstructions: result.paymentInstructions ?? null,
                detailsSource: "create" as const,
                expiresAt,
                environment: body.environment,
              },
              breakdown
            );

            audit({
              action: "portal.h2h_payin.created",
              merchantId: user.merchantId,
              merchantUserId: user.merchantUserId,
              actorEmail: user.email,
              resource: result.transactionId,
              meta: { rail: "india", product: "h2h_upi", environment: body.environment },
            });

            return built;
          }
        );
        if (payload === undefined) return;
        return reply.status(201).send(payload);
      } catch (err) {
        const mapped = merchantPaymentFlowErrorResponse(err);
        request.log.warn(
          { logDetail: mapped.logDetail, merchantId: user.merchantId },
          "portal h2h payin failed"
        );
        sendMerchantFacingReply(reply, mapped);
        return;
      }
    }
  );

  app.get(
    "/portal/me/h2h/payin-instances/:transactionId",
    {
      schema: {
        params: z.object({ transactionId: z.string().uuid() }),
        querystring: z.object({
          environment: z.enum(["test", "live"]).default("test"),
        }),
        response: {
          200: z.object({
            transactionId: z.string(),
            status: z.string(),
            amount: z.string(),
            currency: z.string(),
            instanceId: z.string().nullable(),
            tradeEventId: z.number().nullable().optional(),
            paymentDetails: z.record(z.unknown()),
            paymentInstructions: z.record(z.unknown()).nullable().optional(),
            detailsSource: z.enum(["live", "webhook", "create"]),
            expiresAt: z.string().nullable().optional(),
            environment: z.enum(["test", "live"]),
          }),
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      const { transactionId } = request.params as { transactionId: string };
      const { environment } = request.query as { environment: "test" | "live" };
      if (!(await requirePortalIndiaAccess(user.merchantId, environment, reply))) return;

      const view = await getMerchantH2hPayinStatus({
        merchantId: user.merchantId,
        environment,
        transactionId,
      });
      if (!view) {
        return reply.status(404).send({ error: "Not found", message: "H2H pay-in not found" });
      }
      return { ...view, environment };
    }
  );

  app.post(
    "/portal/me/h2h/buyer-confirms-payment",
    {
      schema: {
        body: z.object({
          environment: z.enum(["test", "live"]).default("test"),
          transactionId: z.string().uuid(),
          utr: z.string().min(4).max(64),
        }),
        response: {
          200: z.object({
            transactionId: z.string(),
            acknowledged: z.boolean(),
          }),
          400: merchantFacingError,
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

      const body = request.body as {
        environment: "test" | "live";
        transactionId: string;
        utr: string;
      };
      if (!(await requirePortalIndiaAccess(user.merchantId, body.environment, reply))) return;

      const [txRow] = await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.id, body.transactionId),
            eq(transactions.merchantId, user.merchantId),
            eq(transactions.environment, body.environment)
          )
        )
        .limit(1);
      if (!txRow || txRow.type !== "payin") {
        return reply.status(400).send({ error: "Bad Request", message: "Transaction not found" });
      }
      const meta = parseTransactionMetadata(txRow);
      if (!isTyltH2hPayinMetadata(meta)) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Not an India H2H UPI pay-in",
        });
      }
      if (!txRow.externalId?.trim()) {
        return reply.status(400).send({ error: "Bad Request", message: "Missing provider instance id" });
      }

      try {
        const upstream = await tyltH2hBuyerConfirmsPayment({
          environment: body.environment,
          instanceId: txRow.externalId,
          utr: body.utr,
        });
        if (upstream.status >= 400) {
          const merchantMsg =
            pickTyltJsonPrimaryMessage(upstream.json) ??
            (upstream.status >= 500
              ? "Payment confirmation is temporarily unavailable. Try again shortly."
              : "Could not confirm payment. Check UTR and timing.");
          if (upstream.status >= 500) {
            return reply.status(503).send({
              error: "Service Unavailable",
              message: merchantMsg,
              code: "payment_unavailable",
            });
          }
          return reply.status(400).send({ error: "Bad Request", message: merchantMsg });
        }

        audit({
          action: "portal.h2h_payin.confirmed",
          merchantId: user.merchantId,
          merchantUserId: user.merchantUserId,
          actorEmail: user.email,
          resource: body.transactionId,
          meta: { rail: "india", product: "h2h_upi", action: "buyer_confirm" },
        });

        return { transactionId: body.transactionId, acknowledged: true };
      } catch (err) {
        const mapped = merchantPaymentFlowErrorResponse(err);
        request.log.warn(
          { logDetail: mapped.logDetail, merchantId: user.merchantId },
          "portal h2h buyer confirm failed"
        );
        sendMerchantFacingReply(reply, mapped);
        return;
      }
    }
  );
}
