/**
 * Portal India CPG payouts: USDT wallet debit → on-chain crypto send (TL Pay CPG).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { transactions } from "../../src/db/schema/index.js";
import { LIMITS } from "../../src/lib/limits.js";
import { audit } from "../../src/lib/audit.js";
import { requirePortalIndiaAccess } from "../../src/lib/portal-payout-access.js";
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
import { requirePortalPayoutGuards } from "../../src/lib/portal-roles.js";
import { portalPayoutPinSchema } from "../../src/lib/merchant-payout-pin.js";
import { withIdempotency, readIdempotencyKey } from "../../src/lib/idempotency.js";
import { evaluatePortalPayoutGate } from "../../src/lib/payout-approvals.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
  code: z.string().optional(),
});

const merchantFacingError = errorResponse;

const payoutApprovalQueuedResponseSchema = z.object({
  requestId: z.string(),
  status: z.literal("pending"),
  requiresApproval: z.literal(true),
  expiresAt: z.string(),
});

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
          pin: portalPayoutPinSchema,
        }),
        response: {
          201: cpgPayoutCreateResponseSchema,
          202: payoutApprovalQueuedResponseSchema,
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
      if (!(await requirePortalPayoutGuards(request, reply, (request.body as { pin?: string }).pin))) return;

      const body = request.body as {
        environment: "test" | "live";
        amount: string;
        settledCurrency: string;
        networkSymbol: string;
        address: string;
        beneficiaryDetails: Record<string, unknown>;
        pin: string;
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
        const response = await withIdempotency(
          { request, reply, merchantId: user.merchantId, body, required: true },
          async () => {
            const executorParams = {
              merchantId: user.merchantId,
              environment: body.environment,
              baseUrl,
              amount: body.amount,
              settledCurrency,
              networkSymbol: body.networkSymbol,
              address: body.address.trim(),
              beneficiaryDetails: body.beneficiaryDetails,
            };

            const gate = await evaluatePortalPayoutGate({
              rail: "cpg",
              merchantId: user.merchantId,
              merchantUserId: user.merchantUserId,
              actorEmail: user.email,
              environment: body.environment,
              amount: body.amount,
              currency: settledCurrency,
              idempotencyKey: readIdempotencyKey(request)!,
              executorParams,
            });
            if (gate.kind === "queued") {
              return { queued: true as const, requestId: gate.requestId, expiresAt: gate.expiresAt };
            }

            const result = await createTyltCpgPayoutRequest(executorParams);

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

            const built = attachFeeBreakdown(
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

            return { queued: false as const, ...built };
          }
        );
        if (response === undefined) return;
        if (response.queued) {
          return reply.status(202).send({
            requestId: response.requestId,
            status: "pending",
            requiresApproval: true,
            expiresAt: response.expiresAt,
          });
        }
        const { queued, ...built } = response;
        return reply.status(201).send(built);
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
