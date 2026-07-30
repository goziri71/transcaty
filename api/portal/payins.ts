/**
 * Portal pay-in: create collection order (same Payok flow as POST /v1/payins).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { merchants } from "../../src/db/schema/index.js";
import { createPayinOrder } from "../../services/domestic/bangladesh/index.js";
import { LIMITS } from "../../src/lib/limits.js";
import { validateMerchantReturnUrl } from "../../src/lib/merchant-return-url.js";
import { audit } from "../../src/lib/audit.js";
import { merchantPaymentFlowErrorResponse, sendMerchantFacingReply } from "../../src/lib/merchant-facing-errors.js";
import {
  transactionFeeBreakdownFieldsSchema,
  buildTransactionFeeBreakdown,
  attachFeeBreakdown,
} from "../../src/lib/billing/transaction-fee-breakdown.js";
import { withIdempotency } from "../../src/lib/idempotency.js";
import { requirePortalMoneyGuards } from "../../src/lib/portal-roles.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});
const merchantFacingError = z.object({
  error: z.string(),
  message: z.string().optional(),
  code: z.string().optional(),
});

export async function registerPortalPayinsRoutes(app: FastifyInstance) {
  app.post(
    "/portal/me/payins",
    {
      schema: {
        body: z.object({
          environment: z.enum(["test", "live"]).default("test"),
          amount: z.string(),
          paymentMethodCode: z.enum(["BKASH", "NAGAD", "UPAY"]),
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

      const body = request.body as {
        environment: "test" | "live";
        amount: string;
        paymentMethodCode: "BKASH" | "NAGAD" | "UPAY";
        returnUrl: string;
        customer: { name: string; email: string; phone: string; deviceId: string };
        goodsInfo: { name: string; id?: string; price?: string };
      };

      const kycRequired = process.env.KYC_REQUIRED === "true";
      if (kycRequired) {
        const [m] = await db
          .select({ kycStatus: merchants.kycStatus })
          .from(merchants)
          .where(eq(merchants.id, user.merchantId))
          .limit(1);
        if (m?.kycStatus !== "verified") {
          return reply.status(403).send({ error: "Forbidden", message: "KYC verification required" });
        }
      }

      if (body.environment === "live") {
        const [merchant] = await db
          .select({ status: merchants.status, kycStatus: merchants.kycStatus })
          .from(merchants)
          .where(eq(merchants.id, user.merchantId))
          .limit(1);
        if (!merchant) return reply.status(401).send({ error: "Unauthorized" });
        if (merchant.status !== "active") {
          return reply.status(403).send({ error: "Forbidden", message: "Merchant account is not active" });
        }
        if (merchant.kycStatus !== "verified") {
          return reply.status(403).send({ error: "Forbidden", message: "KYC verification required for live pay-ins" });
        }
      }

      const amount = parseFloat(body.amount);
      if (!Number.isFinite(amount) || amount < LIMITS.payin.min || amount > LIMITS.payin.max) {
        return reply
          .status(400)
          .send({ error: `Amount must be between ${LIMITS.payin.min} and ${LIMITS.payin.max} BDT` });
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
            const result = await createPayinOrder({
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
              currency: "BDT",
              provider: "payok-bd-payin",
            });
            return attachFeeBreakdown(
              {
                ...result,
                status: "pending",
                amount: body.amount,
                expiresAt,
                environment: body.environment,
              },
              breakdown
            );
          }
        );
        if (response === undefined) return;
        return reply.send(response);
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        audit({
          action: "portal.payin.failed",
          merchantId: user.merchantId,
          merchantUserId: user.merchantUserId,
          actorEmail: user.email,
          meta: { message: rawMsg },
        });
        const mapped = merchantPaymentFlowErrorResponse(err);
        request.log.warn(
          { logDetail: mapped.logDetail ?? rawMsg, merchantId: user.merchantId },
          "portal payin failed"
        );
        sendMerchantFacingReply(reply, mapped);
      }
    }
  );
}
