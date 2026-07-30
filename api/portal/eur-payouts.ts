/**
 * Portal Europe payouts: USDC wallet debit → EUR bank beneficiary (TL Pay Open Banking).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { eq, and, gt } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { merchants, idempotencyKeys, transactions } from "../../src/db/schema/index.js";
import { LIMITS } from "../../src/lib/limits.js";
import { validateMerchantReturnUrl } from "../../src/lib/merchant-return-url.js";
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
import {
  approveTyltEurPayout,
  createTyltEurPayoutInstance,
  getMerchantEurPayoutStatus,
} from "../../services/integrations/tylt/eur-payout.js";
import { pickTyltJsonPrimaryMessage } from "../../services/integrations/tylt/h2h-upi.js";
import { requirePortalMoneyGuards, requirePortalMoneyRole } from "../../src/lib/portal-roles.js";
import { requirePortalStepUp } from "../../src/lib/portal-auth.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
  code: z.string().optional(),
});

const merchantFacingError = errorResponse;

const tyltEurMerchantDetailsBodySchema = z
  .object({
    merchantName: z.string().min(1),
    merchantUrl: z.string().url(),
    merchantInternalId: z.string().min(1),
  })
  .optional();

const eurPayoutCreateResponseSchema = z
  .object({
    transactionId: z.string(),
    status: z.literal("pending"),
    amount: z.string(),
    fiatCurrency: z.string(),
    settlementCurrency: z.literal("USDC"),
    instanceId: z.string(),
    checkoutUrl: z.string().url(),
    cryptoAmount: z.string().nullable(),
    rate: z.number().nullable(),
    environment: z.enum(["test", "live"]),
  })
  .merge(transactionFeeBreakdownFieldsSchema.partial());

const eurPayoutStatusResponseSchema = z.object({
  transactionId: z.string(),
  status: z.string(),
  amount: z.string(),
  fiatCurrency: z.string(),
  settlementCurrency: z.string(),
  debitAmount: z.string(),
  instanceId: z.string().nullable(),
  checkoutUrl: z.string().nullable(),
  eventId: z.number().nullable(),
  detailsSource: z.enum(["live", "local"]),
  upstream: z.record(z.unknown()).nullable().optional(),
  environment: z.enum(["test", "live"]),
});

async function requirePortalEuropeAccess(
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
        message: "KYC verification required for Europe payouts",
      });
      return false;
    }
  }

  const gate = await assertMerchantMarketApiAccess({
    merchantId,
    market: "europe",
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

export async function registerPortalEurPayoutRoutes(app: FastifyInstance) {
  app.post(
    "/portal/me/eur/payout-instances",
    {
      schema: {
        body: z.object({
          environment: z.enum(["test", "live"]).default("test"),
          amount: z.string(),
          currencySymbol: z.literal("EUR"),
          returnUrl: z.string().min(1),
          merchantUrl: z.string().url().optional(),
          merchantDetails: tyltEurMerchantDetailsBodySchema,
          userDetails: z.record(z.string(), z.unknown()).default({}),
          payeeDetails: z.record(z.string(), z.unknown()),
          autoMerchantApproval: z.union([z.literal(0), z.literal(1)]).optional(),
          cryptoUi: z.union([z.literal(0), z.literal(1)]).optional(),
        }),
        response: {
          201: eurPayoutCreateResponseSchema,
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
        currencySymbol: "EUR";
        returnUrl: string;
        merchantUrl?: string;
        merchantDetails?: { merchantName: string; merchantUrl: string; merchantInternalId: string };
        userDetails: Record<string, unknown>;
        payeeDetails: Record<string, unknown>;
        autoMerchantApproval?: 0 | 1;
        cryptoUi?: 0 | 1;
      };

      if (!(await requirePortalEuropeAccess(user.merchantId, body.environment, reply))) return;

      const returnCheck = validateMerchantReturnUrl(body.returnUrl);
      if (!returnCheck.ok) {
        return reply.status(400).send({ error: "Bad Request", message: returnCheck.message });
      }

      const bounds = LIMITS.tyltEurOpenBanking.EUR;
      const amt = parseFloat(body.amount);
      if (!Number.isFinite(amt) || amt < bounds.min || amt > bounds.max) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Amount must be between ${bounds.min} and ${bounds.max} EUR`,
        });
      }

      const baseUrl = process.env.APP_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

      try {
        const result = await createTyltEurPayoutInstance({
          merchantId: user.merchantId,
          environment: body.environment,
          baseUrl,
          amount: body.amount,
          currencySymbol: "EUR",
          returnUrl: returnCheck.normalized!,
          userDetails: body.userDetails ?? {},
          payeeDetails: body.payeeDetails,
          autoMerchantApproval: body.autoMerchantApproval,
          merchantUrl: body.merchantUrl,
          merchantDetails: body.merchantDetails,
          cryptoUi: body.cryptoUi,
        });

        const [txRow] = await db
          .select({
            amount: transactions.amount,
            currency: transactions.currency,
            metadata: transactions.metadata,
          })
          .from(transactions)
          .where(eq(transactions.id, result.transactionId))
          .limit(1);

        const breakdown = await buildTransactionFeeBreakdown({
          merchantId: user.merchantId,
          environment: body.environment,
          transactionId: result.transactionId,
          type: "payout",
          status: "pending",
          amount: String(txRow?.amount ?? body.amount),
          currency: txRow?.currency ?? "USDC",
          provider: "tylt-eur-payout",
          metadata: txRow?.metadata ?? null,
        });

        const response = attachFeeBreakdown(
          {
            transactionId: result.transactionId,
            status: "pending" as const,
            amount: result.amount,
            fiatCurrency: result.fiatCurrency,
            settlementCurrency: "USDC" as const,
            instanceId: result.instanceId,
            checkoutUrl: result.checkoutUrl,
            cryptoAmount: result.cryptoAmount,
            rate: result.rate,
            environment: body.environment,
          },
          breakdown
        );

        audit({
          action: "portal.eur_payout.created",
          merchantId: user.merchantId,
          merchantUserId: user.merchantUserId,
          actorEmail: user.email,
          resource: result.transactionId,
          meta: {
            environment: body.environment,
            amount: body.amount,
            fiatCurrency: "EUR",
            autoMerchantApproval: body.autoMerchantApproval ?? 1,
          },
        });

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
          action: "portal.eur_payout.failed",
          merchantId: user.merchantId,
          merchantUserId: user.merchantUserId,
          actorEmail: user.email,
          meta: { message: rawMsg, environment: body.environment },
        });
        const mapped = merchantPaymentFlowErrorResponse(err);
        request.log.warn(
          { logDetail: mapped.logDetail ?? rawMsg, merchantId: user.merchantId },
          "portal eur payout failed"
        );
        sendMerchantFacingReply(reply, mapped);
        return;
      }
    }
  );

  app.post(
    "/portal/me/eur/payout-instances/:transactionId/approve",
    {
      schema: {
        params: z.object({ transactionId: z.string().uuid() }),
        querystring: z.object({ environment: z.enum(["test", "live"]).default("test") }),
        response: {
          200: z.object({
            transactionId: z.string(),
            acknowledged: z.boolean(),
            environment: z.enum(["test", "live"]),
          }),
          400: merchantFacingError,
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
      if (!(await requirePortalMoneyRole(request, reply))) return;
      if (!(await requirePortalStepUp(request, reply, "money.write"))) return;

      const { transactionId } = request.params as { transactionId: string };
      const { environment } = request.query as { environment: "test" | "live" };

      if (!(await requirePortalEuropeAccess(user.merchantId, environment, reply))) return;

      const view = await getMerchantEurPayoutStatus({
        merchantId: user.merchantId,
        environment,
        transactionId,
      });
      if (!view) {
        return reply.status(404).send({ error: "Not found", message: "EU payout not found" });
      }

      try {
        const res = await approveTyltEurPayout({
          environment,
          transactionId,
          merchantId: user.merchantId,
        });
        if (res.status >= 400) {
          return reply.status(400).send({
            error: "Bad Request",
            message: pickTyltJsonPrimaryMessage(res.json) ?? "Payout approval rejected",
            code: "payment_provider_rejected",
          });
        }

        audit({
          action: "portal.eur_payout.approved",
          merchantId: user.merchantId,
          merchantUserId: user.merchantUserId,
          actorEmail: user.email,
          resource: transactionId,
          meta: { environment },
        });

        return { transactionId, acknowledged: true, environment };
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        request.log.warn(
          { logDetail: rawMsg, merchantId: user.merchantId, transactionId },
          "portal eur payout approve failed"
        );
        const mapped = merchantPaymentFlowErrorResponse(err);
        sendMerchantFacingReply(reply, mapped);
        return;
      }
    }
  );

  app.get(
    "/portal/me/eur/payout-instances/:transactionId",
    {
      schema: {
        params: z.object({ transactionId: z.string().uuid() }),
        querystring: z.object({ environment: z.enum(["test", "live"]).default("test") }),
        response: {
          200: eurPayoutStatusResponseSchema,
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

      if (!(await requirePortalEuropeAccess(user.merchantId, environment, reply))) return;

      const view = await getMerchantEurPayoutStatus({
        merchantId: user.merchantId,
        environment,
        transactionId,
      });
      if (!view) {
        return reply.status(404).send({ error: "Not found", message: "EU payout not found" });
      }

      return { ...view, environment };
    }
  );
}
