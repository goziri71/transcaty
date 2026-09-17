/**
 * Portal NGN (Tekko): permanent per-merchant VA + bank payout.
 * Settle currency is native NGN. Live-only upstream. Isolated from PYUSD / PayOK / Tylt.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createTekkoNgnPayout,
  getOrProvisionMerchantNgnVa,
  getMerchantNgnVa,
  getTekkoNgnPayoutStatus,
  listTekkoNgnBanks,
  TEKKO_NGN_PAYOUT_PROVIDER,
  TEKKO_NGN_SETTLEMENT_CURRENCY,
  TEKKO_NGN_SETTLEMENT_DISPLAY_NAME,
  verifyTekkoNgnBankAccount,
} from "../../services/integrations/tekko/index.js";
import { LIMITS } from "../../src/lib/limits.js";
import { audit } from "../../src/lib/audit.js";
import { requirePortalNgnAccess } from "../../src/lib/portal-payout-access.js";
import {
  merchantPaymentFlowErrorResponse,
  sendMerchantFacingReply,
} from "../../src/lib/merchant-facing-errors.js";
import {
  transactionFeeBreakdownFieldsSchema,
  buildTransactionFeeBreakdown,
  attachFeeBreakdown,
} from "../../src/lib/billing/transaction-fee-breakdown.js";
import { requirePortalMoneyGuards, requirePortalPayoutGuards, requirePortalMoneyRole } from "../../src/lib/portal-roles.js";
import { portalPayoutPinSchema } from "../../src/lib/merchant-payout-pin.js";
import { PayoutCreationError } from "../../services/domestic/bangladesh/payout.js";
import { withIdempotency, readIdempotencyKey } from "../../src/lib/idempotency.js";
import { evaluatePortalPayoutGate } from "../../src/lib/payout-approvals.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});
const merchantFacingError = errorResponse.extend({
  code: z.string().optional(),
});

const payoutApprovalQueuedResponseSchema = z.object({
  requestId: z.string(),
  status: z.literal("pending"),
  requiresApproval: z.literal(true),
  expiresAt: z.string(),
});

const ngnVaResponseSchema = z.object({
  status: z.string(),
  bvnStatus: z.string(),
  bvnRequiredForPayout: z.boolean(),
  accountNumber: z.string().nullable(),
  bankName: z.string().nullable(),
  accountName: z.string().nullable(),
  currency: z.literal("NGN"),
  ready: z.boolean(),
  environment: z.enum(["test", "live"]),
});

const ngnBeneficiarySchema = z.object({
  accountNumber: z.string().min(10).max(10),
  bankCode: z.string().min(2).max(10),
  accountName: z.string().min(1).max(200),
  bankName: z.string().max(120).optional(),
});

function maskAccountNumber(value: string): string {
  const v = value.replace(/\s/g, "");
  if (v.length <= 4) return `****${v}`;
  return `****${v.slice(-4)}`;
}

export async function registerPortalNgnRoutes(app: FastifyInstance) {
  app.get(
    "/portal/me/ngn/virtual-account",
    {
      schema: {
        querystring: z.object({
          environment: z.enum(["test", "live"]).optional(),
        }),
        response: {
          200: ngnVaResponseSchema,
          401: errorResponse,
          403: errorResponse,
          503: merchantFacingError,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      if (!(await requirePortalMoneyRole(request, reply))) return;

      const q = request.query as { environment?: "test" | "live" };
      const environment = q.environment ?? "live";
      if (!(await requirePortalNgnAccess(user.merchantId, environment, reply))) return;

      try {
        return await getMerchantNgnVa({
          merchantId: user.merchantId,
          environment,
        });
      } catch (err) {
        sendMerchantFacingReply(reply, merchantPaymentFlowErrorResponse(err));
        return;
      }
    }
  );

  app.post(
    "/portal/me/ngn/virtual-account",
    {
      schema: {
        body: z.object({
          environment: z.enum(["test", "live"]).default("live"),
          bvn: z.string().min(11).max(11),
          firstName: z.string().min(1).max(100),
          lastName: z.string().min(1).max(100),
          phoneNumber: z.string().min(8).max(20).optional(),
          dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          customerEmail: z.string().email().max(255).optional(),
        }),
        response: {
          200: ngnVaResponseSchema,
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
        bvn: string;
        firstName: string;
        lastName: string;
        phoneNumber?: string;
        dateOfBirth?: string;
        customerEmail?: string;
      };

      if (!(await requirePortalNgnAccess(user.merchantId, body.environment, reply))) return;

      try {
        const response = await withIdempotency(
          { request, reply, merchantId: user.merchantId, body, required: true },
          async () => {
            const result = await getOrProvisionMerchantNgnVa({
              merchantId: user.merchantId,
              environment: body.environment,
              provision: true,
              bvn: {
                bvn: body.bvn,
                firstName: body.firstName,
                lastName: body.lastName,
                phoneNumber: body.phoneNumber,
                dateOfBirth: body.dateOfBirth,
                customerEmail: body.customerEmail,
              },
            });
            audit({
              action: "portal.ngn.va.provisioned",
              merchantId: user.merchantId,
              merchantUserId: user.merchantUserId,
              actorEmail: user.email,
              meta: { status: result.status, ready: result.ready },
            });
            return result;
          }
        );
        if (response === undefined) return;
        return reply.status(200).send(response);
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        audit({
          action: "portal.ngn.va.failed",
          merchantId: user.merchantId,
          merchantUserId: user.merchantUserId,
          actorEmail: user.email,
          meta: { message: rawMsg.slice(0, 200), market: "nigeria" },
        });
        sendMerchantFacingReply(reply, merchantPaymentFlowErrorResponse(err));
        return;
      }
    }
  );

  app.get(
    "/portal/me/ngn/banks",
    {
      schema: {
        querystring: z.object({
          environment: z.enum(["test", "live"]).optional(),
          search: z.string().optional(),
        }),
        response: {
          200: z.object({
            items: z.array(z.object({ bankCode: z.string(), bankName: z.string() })),
          }),
          401: errorResponse,
          403: errorResponse,
          503: merchantFacingError,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      if (!(await requirePortalMoneyRole(request, reply))) return;
      const q = request.query as { environment?: "test" | "live"; search?: string };
      const environment = q.environment ?? "live";
      if (!(await requirePortalNgnAccess(user.merchantId, environment, reply))) return;
      try {
        const items = await listTekkoNgnBanks({ search: q.search });
        return { items };
      } catch (err) {
        sendMerchantFacingReply(reply, merchantPaymentFlowErrorResponse(err));
        return;
      }
    }
  );

  app.post(
    "/portal/me/ngn/verify-account",
    {
      schema: {
        body: z.object({
          environment: z.enum(["test", "live"]).default("live"),
          accountNumber: z.string().min(10).max(10),
          bankCode: z.string().min(2).max(10),
        }),
        response: {
          200: z.object({
            accountNumber: z.string(),
            bankCode: z.string(),
            accountName: z.string(),
          }),
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          503: merchantFacingError,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      // Name enquiry only — no ledger debit; money role without Idempotency-Key.
      if (!(await requirePortalMoneyRole(request, reply))) return;
      const body = request.body as {
        environment: "test" | "live";
        accountNumber: string;
        bankCode: string;
      };
      if (!(await requirePortalNgnAccess(user.merchantId, body.environment, reply))) return;
      try {
        return await verifyTekkoNgnBankAccount({
          accountNumber: body.accountNumber,
          bankCode: body.bankCode,
        });
      } catch (err) {
        sendMerchantFacingReply(reply, merchantPaymentFlowErrorResponse(err));
        return;
      }
    }
  );

  app.post(
    "/portal/me/ngn/payouts",
    {
      schema: {
        body: z.object({
          environment: z.enum(["test", "live"]).default("live"),
          amount: z.string(),
          beneficiary: ngnBeneficiarySchema,
          description: z.string().max(255).optional(),
          merchantReference: z.string().min(1).max(128).optional(),
          pin: portalPayoutPinSchema,
        }),
        response: {
          201: z
            .object({
              transactionId: z.string(),
              reference: z.string(),
              status: z.string(),
              amount: z.string(),
              currency: z.literal("NGN"),
              environment: z.enum(["test", "live"]),
              recipient: z.object({ masked: z.string() }),
            })
            .merge(transactionFeeBreakdownFieldsSchema.partial()),
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
        beneficiary: z.infer<typeof ngnBeneficiarySchema>;
        description?: string;
        merchantReference?: string;
        pin: string;
      };

      if (!(await requirePortalNgnAccess(user.merchantId, body.environment, reply))) return;

      const bounds = LIMITS.tekkoNgn.payout;
      const amt = parseFloat(body.amount);
      if (!Number.isFinite(amt) || amt < bounds.min || amt > bounds.max) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Amount must be between ${bounds.min} and ${bounds.max} NGN`,
        });
      }

      try {
        const response = await withIdempotency(
          { request, reply, merchantId: user.merchantId, body, required: true },
          async () => {
            const executorParams = {
              merchantId: user.merchantId,
              environment: body.environment,
              amount: body.amount,
              beneficiary: body.beneficiary,
              description: body.description,
              merchantReference: body.merchantReference,
              portalActor: { merchantUserId: user.merchantUserId, email: user.email },
            };

            const gate = await evaluatePortalPayoutGate({
              rail: "ngn",
              merchantId: user.merchantId,
              merchantUserId: user.merchantUserId,
              actorEmail: user.email,
              environment: body.environment,
              amount: body.amount,
              currency: "NGN",
              idempotencyKey: readIdempotencyKey(request)!,
              executorParams,
            });
            if (gate.kind === "queued") {
              return { queued: true as const, requestId: gate.requestId, expiresAt: gate.expiresAt };
            }

            const result = await createTekkoNgnPayout(executorParams);
            const breakdown = await buildTransactionFeeBreakdown({
              merchantId: user.merchantId,
              environment: body.environment,
              transactionId: result.transactionId,
              type: "payout",
              status: "pending",
              amount: result.amount,
              currency: "NGN",
              provider: TEKKO_NGN_PAYOUT_PROVIDER,
            });
            return {
              queued: false as const,
              ...attachFeeBreakdown(
                {
                  transactionId: result.transactionId,
                  reference: result.reference,
                  status: result.status,
                  amount: result.amount,
                  currency: "NGN" as const,
                  environment: body.environment,
                  recipient: { masked: maskAccountNumber(body.beneficiary.accountNumber) },
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
        const meta: Record<string, unknown> = { message: rawMsg, market: "nigeria" };
        if (err instanceof PayoutCreationError) {
          if (err.transactionId) meta.transactionId = err.transactionId;
          if (err.upstreamDetail) meta.upstreamDetail = err.upstreamDetail;
        }
        audit({
          action: "portal.payout.failed",
          merchantId: user.merchantId,
          merchantUserId: user.merchantUserId,
          actorEmail: user.email,
          meta,
        });
        sendMerchantFacingReply(reply, merchantPaymentFlowErrorResponse(err));
        return;
      }
    }
  );

  app.get(
    "/portal/me/ngn/payouts/:transactionId",
    {
      schema: {
        params: z.object({ transactionId: z.string().uuid() }),
        querystring: z.object({
          environment: z.enum(["test", "live"]).optional(),
        }),
        response: {
          200: z.object({
            transactionId: z.string(),
            reference: z.string().nullable(),
            status: z.string(),
            withdrawalStatus: z.string().nullable(),
            amount: z.string(),
            currency: z.string(),
            settlementCurrency: z.literal(TEKKO_NGN_SETTLEMENT_CURRENCY),
            settlementCurrencyLabel: z.literal(TEKKO_NGN_SETTLEMENT_DISPLAY_NAME),
            beneficiary: ngnBeneficiarySchema.nullable(),
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
      if (!(await requirePortalMoneyRole(request, reply))) return;

      const q = request.query as { environment?: "test" | "live" };
      const environment = q.environment ?? "live";
      if (!(await requirePortalNgnAccess(user.merchantId, environment, reply))) return;

      const { transactionId } = request.params as { transactionId: string };
      try {
        const view = await getTekkoNgnPayoutStatus({
          merchantId: user.merchantId,
          transactionId,
        });
        if (!view) {
          return reply.status(404).send({ error: "Not found", message: "NGN payout not found" });
        }
        return view;
      } catch (err) {
        sendMerchantFacingReply(reply, merchantPaymentFlowErrorResponse(err));
        return;
      }
    }
  );
}
