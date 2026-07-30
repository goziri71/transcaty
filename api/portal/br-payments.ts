/**
 * Portal Brazil (PayOK PIX) pay-in + payout. Kept in its own file so Brazil stays
 * isolated from the Bangladesh portal routes; shared PayOK transport underneath.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { eq, and, gt } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { merchants, idempotencyKeys } from "../../src/db/schema/index.js";
import {
  createPayinOrder as createBrazilPayinOrder,
  createPayoutOrder as createBrazilPayoutOrder,
} from "../../services/domestic/brazil/index.js";
import { LIMITS } from "../../src/lib/limits.js";
import { validateMerchantReturnUrl } from "../../src/lib/merchant-return-url.js";
import { audit } from "../../src/lib/audit.js";
import { assertMerchantMarketApiAccess } from "../../src/lib/merchant-markets.js";
import { queueTransactionalEmail } from "../../src/lib/transactional-email-queue.js";
import { merchantPaymentFlowErrorResponse, sendMerchantFacingReply } from "../../src/lib/merchant-facing-errors.js";
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
const payoutErrorResponse = errorResponse.extend({
  transactionId: z.string().optional(),
  reference: z.string().optional(),
  platformOrderId: z.string().nullable().optional(),
  code: z.string().optional(),
});

function maskRecipient(value: string): string {
  const v = value.replace(/\s/g, "");
  if (v.length <= 4) return `****${v}`;
  return `****${v.slice(-4)}`;
}

/** Gate portal Brazil flows on KYC (live/forced) + the `brazil` market entitlement. */
async function requirePortalBrazilAccess(
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
        message: "KYC verification required for Brazil payments",
      });
      return false;
    }
  }

  const gate = await assertMerchantMarketApiAccess({ merchantId, market: "brazil", kycRequired });
  if (!gate.ok) {
    reply.status(403).send({ error: "Forbidden", message: gate.message, code: gate.code });
    return false;
  }

  return true;
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
          200: z
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
        if (cached) return JSON.parse(cached.responseSnapshot);
      }

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
          amount: body.amount,
          currency: "BRL",
          provider: "payok-br-payin",
        });
        const response = attachFeeBreakdown(
          {
            ...result,
            status: "pending",
            amount: body.amount,
            expiresAt,
            environment: body.environment,
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
        return reply.send(response);
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
          400: payoutErrorResponse,
          401: errorResponse,
          403: errorResponse,
          503: payoutErrorResponse,
          500: payoutErrorResponse,
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
        benificiaryAccountInfo: { number: string; orgId: string; orgCode: string; orgName: string; holderName: string };
        cardHolderInfo: { firstName: string; lastName: string; email: string; phone: string };
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
        const result = await createBrazilPayoutOrder({
          merchantId: user.merchantId,
          environment: body.environment,
          amount: body.amount,
          baseUrl,
          benificiaryAccountInfo: body.benificiaryAccountInfo,
          cardHolderInfo: body.cardHolderInfo,
          portalActor: { merchantUserId: user.merchantUserId, email: user.email },
        });

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

        return reply.status(201).send(
          attachFeeBreakdown(
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
          )
        );
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
