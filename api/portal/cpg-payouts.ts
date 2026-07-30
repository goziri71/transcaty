/**
 * Portal India CPG payouts: USDT wallet debit → on-chain crypto send (TL Pay CPG).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { eq, and, gt } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { merchants, idempotencyKeys, transactions } from "../../src/db/schema/index.js";
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
import {
  createTyltCpgPayoutRequest,
  getMerchantCpgPayoutStatus,
} from "../../services/integrations/tylt/cpg-payout.js";
import { requirePortalMoneyGuards } from "../../src/lib/portal-roles.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
  code: z.string().optional(),
});

const merchantFacingError = errorResponse;

const cpgPayoutCreateResponseSchema = z
  .object({
    transactionId: z.string(),
    status: z.literal("pending"),
    amount: z.string(),
    settlementCurrency: z.string(),
    platformOrderId: z.string().nullable(),
    networkSymbol: z.string(),
    environment: z.enum(["test", "live"]),
  })
  .merge(transactionFeeBreakdownFieldsSchema.partial());

const cpgPayoutStatusResponseSchema = z.object({
  transactionId: z.string(),
  status: z.string(),
  amount: z.string(),
  settlementCurrency: z.string(),
  debitAmount: z.string(),
  platformOrderId: z.string().nullable(),
  networkSymbol: z.string().nullable(),
  detailsSource: z.enum(["live", "local"]),
  upstream: z.unknown().nullable().optional(),
  environment: z.enum(["test", "live"]),
});

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
        message: "KYC verification required for India payouts",
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

export async function registerPortalCpgPayoutRoutes(app: FastifyInstance) {
  app.post(
    "/portal/me/cpg/payout-requests",
    {
      schema: {
        body: z.object({
          environment: z.enum(["test", "live"]).default("test"),
          amount: z.string(),
          settledCurrency: z.string().min(1),
          networkSymbol: z.string().min(1),
          address: z.string().min(1),
          beneficiaryDetails: z.record(z.string(), z.unknown()),
        }),
        response: {
          201: cpgPayoutCreateResponseSchema,
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
        settledCurrency: string;
        networkSymbol: string;
        address: string;
        beneficiaryDetails: Record<string, unknown>;
      };

      if (!(await requirePortalIndiaAccess(user.merchantId, body.environment, reply))) return;

      const amt = parseFloat(body.amount);
      const bounds = LIMITS.tyltCpgPayout;
      if (!Number.isFinite(amt) || amt < bounds.amountMin || amt > bounds.amountMax) {
        return reply.status(400).send({ error: "Bad Request", message: "Invalid amount" });
      }

      if (!body.address?.trim()) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Recipient address is required",
        });
      }

      if (
        !body.beneficiaryDetails ||
        typeof body.beneficiaryDetails !== "object" ||
        Object.keys(body.beneficiaryDetails).length === 0
      ) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "beneficiaryDetails (Travel Rule) is required",
        });
      }

      const settledCurrency = body.settledCurrency.trim().toUpperCase();
      if (!["USDT", "USDC"].includes(settledCurrency)) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Unsupported settlement currency. Supported: USDT, USDC",
          code: "unsupported_currency",
        });
      }
      const baseUrl = process.env.APP_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

      try {
        const result = await createTyltCpgPayoutRequest({
          merchantId: user.merchantId,
          environment: body.environment,
          baseUrl,
          amount: body.amount,
          settledCurrency,
          networkSymbol: body.networkSymbol,
          address: body.address.trim(),
          beneficiaryDetails: body.beneficiaryDetails,
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
          currency: txRow?.currency ?? settledCurrency,
          provider: "tylt-cpg-payout",
          metadata: txRow?.metadata ?? null,
        });

        const response = attachFeeBreakdown(
          {
            transactionId: result.transactionId,
            status: "pending" as const,
            amount: body.amount,
            settlementCurrency: settledCurrency,
            platformOrderId: result.platformOrderId,
            networkSymbol: body.networkSymbol,
            environment: body.environment,
          },
          breakdown
        );

        audit({
          action: "portal.cpg_payout.created",
          merchantId: user.merchantId,
          merchantUserId: user.merchantUserId,
          actorEmail: user.email,
          resource: result.transactionId,
          meta: {
            environment: body.environment,
            amount: body.amount,
            settledCurrency,
            networkSymbol: body.networkSymbol,
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
          action: "portal.cpg_payout.failed",
          merchantId: user.merchantId,
          merchantUserId: user.merchantUserId,
          actorEmail: user.email,
          meta: { message: rawMsg, environment: body.environment },
        });
        const mapped = merchantPaymentFlowErrorResponse(err);
        request.log.warn(
          { logDetail: mapped.logDetail ?? rawMsg, merchantId: user.merchantId },
          "portal cpg payout failed"
        );
        sendMerchantFacingReply(reply, mapped);
        return;
      }
    }
  );

  app.get(
    "/portal/me/cpg/payout-requests/:transactionId",
    {
      schema: {
        params: z.object({ transactionId: z.string().uuid() }),
        querystring: z.object({ environment: z.enum(["test", "live"]).default("test") }),
        response: {
          200: cpgPayoutStatusResponseSchema,
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

      const view = await getMerchantCpgPayoutStatus({
        merchantId: user.merchantId,
        environment,
        transactionId,
      });
      if (!view) {
        return reply.status(404).send({ error: "Not found", message: "CPG payout not found" });
      }

      return { ...view, environment };
    }
  );
}
