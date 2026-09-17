/**
 * Portal Brazil (PayOK PIX) pay-in + payout. Kept in its own file so Brazil stays
 * isolated from the Bangladesh portal routes; shared PayOK transport underneath.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createPayinOrder as createBrazilPayinOrder,
  createPayoutOrder as createBrazilPayoutOrder,
} from "../../services/domestic/brazil/index.js";
import { LIMITS } from "../../src/lib/limits.js";
import { validateMerchantReturnUrl } from "../../src/lib/merchant-return-url.js";
import { audit } from "../../src/lib/audit.js";
import { requirePortalBrazilAccess } from "../../src/lib/portal-payout-access.js";
import { queueTransactionalEmail } from "../../src/lib/transactional-email-queue.js";
import { merchantPaymentFlowErrorResponse, sendMerchantFacingReply } from "../../src/lib/merchant-facing-errors.js";
import {
  transactionFeeBreakdownFieldsSchema,
  buildTransactionFeeBreakdown,
  attachFeeBreakdown,
} from "../../src/lib/billing/transaction-fee-breakdown.js";
import { requirePortalMoneyGuards, requirePortalPayoutGuards } from "../../src/lib/portal-roles.js";
import { portalPayoutPinSchema } from "../../src/lib/merchant-payout-pin.js";
import { withIdempotency, readIdempotencyKey } from "../../src/lib/idempotency.js";
import { evaluatePortalPayoutGate } from "../../src/lib/payout-approvals.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});
const merchantFacingError = errorResponse.extend({
  code: z.string().optional(),
});
const payoutErrorResponse = errorResponse.extend({
  transactionId: z.string().optional(),
  reference: z.string().optional(),
  platformOrderId: z.string().nullable().optional(),
  code: z.string().optional(),
});
const payoutApprovalQueuedResponseSchema = z.object({
  requestId: z.string(),
  status: z.literal("pending"),
  requiresApproval: z.literal(true),
  expiresAt: z.string(),
});

function maskRecipient(value: string): string {
  const v = value.replace(/\s/g, "");
  if (v.length <= 4) return `****${v}`;
  return `****${v.slice(-4)}`;
}

export async function registerPortalBrazilRoutes(app: FastifyInstance) {
  app.post(
    "/portal/me/br/payins",
    {
      schema: {
        body: z.object({
          environment: z.enum(["test", "live"]).default("test"),
          amount: z.string(),
          paymentMethodCode: z.enum(["PIX"]).default("PIX"),
          returnUrl: z.string().min(1),
          customer: z.object({
            name: z.string(),
            email: z.string().email(),
            phone: z.string(),
            deviceId: z.string(),
          }),
          goodsInfo: z.object({
            name: z.string(),
            id: z.string().optional(),
            price: z.string().optional(),
          }),
        }),
        response: {
          201: z
            .object({
              transactionId: z.string(),
              status: z.string(),
              amount: z.string(),
              platformOrderId: z.string().optional(),
              paymentInfo: z.unknown().optional(),
              expiresAt: z.string().nullable().optional(),
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

      const body = request.body as {
        environment: "test" | "live";
        amount: string;
        paymentMethodCode: "PIX";
        returnUrl: string;
        customer: { name: string; email: string; phone: string; deviceId: string };
        goodsInfo: { name: string; id?: string; price?: string };
      };

      if (!(await requirePortalBrazilAccess(user.merchantId, body.environment, reply))) return;

      const amount = parseFloat(body.amount);
      if (!Number.isFinite(amount) || amount < LIMITS.payokBr.payin.min || amount > LIMITS.payokBr.payin.max) {
        return reply
          .status(400)
          .send({ error: `Amount must be between ${LIMITS.payokBr.payin.min} and ${LIMITS.payokBr.payin.max} BRL` });
      }

      const returnCheck = validateMerchantReturnUrl(body.returnUrl);
      if (!returnCheck.ok) {
        return reply.status(400).send({ error: "Bad Request", message: returnCheck.message });
      }

      const baseUrl = process.env.APP_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

      try {
        const response = await withIdempotency(
          { request, reply, merchantId: user.merchantId, body, required: true },
          async () => {
            const result = await createBrazilPayinOrder({
              merchantId: user.merchantId,
              environment: body.environment,
              amount: body.amount,
              paymentMethodCode: body.paymentMethodCode,
              baseUrl,
              merchantReturnUrl: returnCheck.normalized,
              customer: body.customer,
              goodsInfo: body.goodsInfo,
              portalActor: { merchantUserId: user.merchantUserId, email: user.email },
            });
            const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
            const breakdown = await buildTransactionFeeBreakdown({
              merchantId: user.merchantId,
              environment: body.environment,
              transactionId: result.transactionId,
              type: "payin",
              status: "pending",
              amount: result.amount,
              currency: "BRL",
              provider: "payok-br-payin",
            });
            return attachFeeBreakdown(
              {
                ...result,
                status: "pending",
                amount: result.amount,
                expiresAt,
                environment: body.environment,
              },
              breakdown
            );
          }
        );
        if (response === undefined) return;
        return reply.status(201).send(response);
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        audit({
          action: "portal.payin.failed",
          merchantId: user.merchantId,
          merchantUserId: user.merchantUserId,
          actorEmail: user.email,
          meta: { message: rawMsg, market: "brazil" },
        });
        const mapped = merchantPaymentFlowErrorResponse(err);
        request.log.warn(
          { logDetail: mapped.logDetail ?? rawMsg, merchantId: user.merchantId },
          "portal br payin failed"
        );
        sendMerchantFacingReply(reply, mapped);
      }
    }
  );

  app.post(
    "/portal/me/br/payouts",
    {
      schema: {
        body: z.object({
          environment: z.enum(["test", "live"]).default("test"),
          amount: z.string(),
          benificiaryAccountInfo: z.object({
            number: z.string(),
            orgId: z.string(),
            orgCode: z.string(),
            orgName: z.string(),
            holderName: z.string(),
          }),
          cardHolderInfo: z.object({
            firstName: z.string(),
            lastName: z.string(),
            email: z.string().email(),
            phone: z.string(),
          }),
          pin: portalPayoutPinSchema,
        }),
        response: {
          201: z
            .object({
              transactionId: z.string(),
              reference: z.string(),
              status: z.string(),
              amount: z.string(),
              platformOrderId: z.string().nullable(),
              environment: z.enum(["test", "live"]),
              recipient: z.object({ masked: z.string() }),
              estimatedCompletion: z.string().nullable(),
            })
            .merge(transactionFeeBreakdownFieldsSchema.partial()),
          202: payoutApprovalQueuedResponseSchema,
          400: payoutErrorResponse,
          401: errorResponse,
          403: errorResponse,
          409: errorResponse,
          503: payoutErrorResponse,
          500: payoutErrorResponse,
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
        benificiaryAccountInfo: { number: string; orgId: string; orgCode: string; orgName: string; holderName: string };
        cardHolderInfo: { firstName: string; lastName: string; email: string; phone: string };
        pin: string;
      };

      if (!(await requirePortalBrazilAccess(user.merchantId, body.environment, reply))) return;

      const amount = Number(body.amount);
      if (!Number.isFinite(amount)) {
        return reply.status(400).send({ error: "Bad Request", message: "Invalid amount" });
      }
      if (amount < LIMITS.payokBr.payout.min || amount > LIMITS.payokBr.payout.max) {
        return reply
          .status(400)
          .send({ error: "Bad Request", message: `Amount must be between ${LIMITS.payokBr.payout.min} and ${LIMITS.payokBr.payout.max} BRL` });
      }

      const baseUrl = process.env.APP_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
      try {
        const response = await withIdempotency(
          { request, reply, merchantId: user.merchantId, body, required: true },
          async () => {
            const executorParams = {
              merchantId: user.merchantId,
              environment: body.environment,
              amount: body.amount,
              baseUrl,
              benificiaryAccountInfo: body.benificiaryAccountInfo,
              cardHolderInfo: body.cardHolderInfo,
              portalActor: { merchantUserId: user.merchantUserId, email: user.email },
            };

            const gate = await evaluatePortalPayoutGate({
              rail: "br",
              merchantId: user.merchantId,
              merchantUserId: user.merchantUserId,
              actorEmail: user.email,
              environment: body.environment,
              amount: body.amount,
              currency: "BRL",
              idempotencyKey: readIdempotencyKey(request)!,
              executorParams,
            });
            if (gate.kind === "queued") {
              return { queued: true as const, requestId: gate.requestId, expiresAt: gate.expiresAt };
            }

            const result = await createBrazilPayoutOrder(executorParams);

            queueTransactionalEmail({
              kind: "merchant_portal_payout",
              to: user.email,
              amount: body.amount,
              transactionId: result.transactionId,
              recipientMasked: maskRecipient(body.benificiaryAccountInfo.number),
            }).catch(() => {});

            const breakdown = await buildTransactionFeeBreakdown({
              merchantId: user.merchantId,
              environment: body.environment,
              transactionId: result.transactionId,
              type: "payout",
              status: "pending",
              amount: body.amount,
              currency: "BRL",
              provider: "payok-br-payout",
            });

            return {
              queued: false as const,
              ...attachFeeBreakdown(
                {
                  transactionId: result.transactionId,
                  reference: result.transactionId,
                  status: result.status ?? "pending",
                  amount: body.amount,
                  platformOrderId: result.platformOrderId ?? null,
                  environment: body.environment,
                  recipient: { masked: maskRecipient(body.benificiaryAccountInfo.number) },
                  estimatedCompletion: null,
                },
                breakdown
              ),
            };
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
          action: "portal.payout.failed",
          merchantId: user.merchantId,
          merchantUserId: user.merchantUserId,
          actorEmail: user.email,
          meta: { message: rawMsg, market: "brazil" },
        });

        const mapped = merchantPaymentFlowErrorResponse(err);
        request.log.warn(
          { logDetail: mapped.logDetail ?? rawMsg, merchantId: user.merchantId },
          "portal br payout failed"
        );
        sendMerchantFacingReply(reply, mapped);
      }
    }
  );
}
