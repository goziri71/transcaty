/**
 * Portal transactions: list, detail, create transfer, create refund.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, count, desc } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { merchants, transactions } from "../../src/db/schema/index.js";
import {
  transferToCustomer,
  refundToCustomer,
} from "../../services/operations/transfers.js";
import {
  createPayoutOrder,
} from "../../services/domestic/bangladesh/payout.js";
import { LIMITS } from "../../src/lib/limits.js";
import { queueTransactionalEmail } from "../../src/lib/transactional-email-queue.js";
import { audit } from "../../src/lib/audit.js";
import {
  merchantPaymentFlowErrorResponse,
  merchantPortalOperationErrorResponse,
  sendMerchantFacingReply,
  sendPortalOperationReply,
} from "../../src/lib/merchant-facing-errors.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

const payoutErrorResponse = errorResponse.extend({
  transactionId: z.string().optional(),
  reference: z.string().optional(),
  platformOrderId: z.string().nullable().optional(),
});

const merchantFacingPayoutError = payoutErrorResponse.extend({
  code: z.string().optional(),
});

const merchantFacingOperationError = errorResponse.extend({
  code: z.string().optional(),
});

const metadataSchema = z.record(z.any());

function maskRecipient(value: string): string {
  const v = value.replace(/\s/g, "");
  if (v.length <= 4) return `****${v}`;
  return `****${v.slice(-4)}`;
}

export async function registerPortalTransactionsRoutes(app: FastifyInstance) {
  app.get(
    "/portal/me/transactions",
    {
      schema: {
        querystring: z.object({
          environment: z.enum(["test", "live"]).default("test"),
          type: z.enum(["payin", "payout", "transfer", "refund"]).optional(),
          status: z.enum(["pending", "success", "failed"]).optional(),
          customerId: z.string().uuid().optional(),
          limit: z.coerce.number().min(1).max(100).default(20),
          offset: z.coerce.number().min(0).default(0),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                type: z.string(),
                status: z.string(),
                amount: z.string(),
                paidAmount: z.string().nullable(),
                platformOrderId: z.string().nullable(),
                customerWalletId: z.string().nullable(),
                refundOfTransactionId: z.string().nullable(),
                createdAt: z.string(),
                completedAt: z.string().nullable(),
              })
            ),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const { environment, type, status, customerId, limit, offset } = request.query as {
        environment: "test" | "live";
        type?: "payin" | "payout" | "transfer" | "refund";
        status?: "pending" | "success" | "failed";
        customerId?: string;
        limit: number;
        offset: number;
      };

      const conditions = [eq(transactions.merchantId, user.merchantId), eq(transactions.environment, environment)];
      if (type) conditions.push(eq(transactions.type, type));
      if (status) conditions.push(eq(transactions.status, status));
      if (customerId) conditions.push(eq(transactions.walletId, customerId));

      const [totalResult] = await db
        .select({ count: count() })
        .from(transactions)
        .where(and(...conditions));

      const rows = await db
        .select({
          id: transactions.id,
          type: transactions.type,
          status: transactions.status,
          amount: transactions.amount,
          paidAmount: transactions.paidAmount,
          externalId: transactions.externalId,
          walletId: transactions.walletId,
          metadata: transactions.metadata,
          createdAt: transactions.createdAt,
          updatedAt: transactions.updatedAt,
        })
        .from(transactions)
        .where(and(...conditions))
        .orderBy(desc(transactions.createdAt))
        .limit(limit)
        .offset(offset);

      const items = rows.map((r) => {
        let refundOfTransactionId: string | null = null;
        if (r.metadata) {
          try {
            const meta = JSON.parse(r.metadata) as { refundOfTransactionId?: string };
            refundOfTransactionId = meta.refundOfTransactionId ?? null;
          } catch {
            /* ignore */
          }
        }
        return {
          id: r.id,
          type: r.type,
          status: r.status,
          amount: String(r.amount),
          paidAmount: r.paidAmount ? String(r.paidAmount) : null,
          platformOrderId: r.externalId,
          customerWalletId: r.walletId,
          refundOfTransactionId,
          createdAt: r.createdAt.toISOString(),
          completedAt: r.status === "success" ? r.updatedAt.toISOString() : null,
        };
      });

      return {
        items,
        total: Number(totalResult?.count ?? 0),
        limit,
        offset,
      };
    }
  );

  app.get(
    "/portal/me/transactions/:id",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          environment: z.enum(["test", "live"]).default("test"),
        }),
        response: {
          200: z.object({
            id: z.string(),
            type: z.string(),
            status: z.string(),
            amount: z.string(),
            paidAmount: z.string().nullable(),
            platformOrderId: z.string().nullable(),
            customerWalletId: z.string().nullable(),
            refundOfTransactionId: z.string().nullable(),
            metadata: metadataSchema.nullable(),
            createdAt: z.string(),
            completedAt: z.string().nullable(),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const { id } = request.params as { id: string };
      const { environment } = request.query as { environment: "test" | "live" };

      const [tx] = await db
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.id, id), eq(transactions.merchantId, user.merchantId), eq(transactions.environment, environment))
        )
        .limit(1);

      if (!tx) {
        return reply.status(404).send({ error: "Not found", message: "Transaction not found" });
      }

      let metadata: Record<string, unknown> | null = null;
      let refundOfTransactionId: string | null = null;
      if (tx.metadata) {
        try {
          metadata = JSON.parse(tx.metadata) as Record<string, unknown>;
          refundOfTransactionId =
            typeof metadata?.refundOfTransactionId === "string"
              ? metadata.refundOfTransactionId
              : null;
        } catch {
          metadata = {};
        }
      }

      return {
        id: tx.id,
        type: tx.type,
        status: tx.status,
        amount: String(tx.amount),
        paidAmount: tx.paidAmount ? String(tx.paidAmount) : null,
        platformOrderId: tx.externalId,
        customerWalletId: tx.walletId,
        refundOfTransactionId,
        metadata,
        createdAt: tx.createdAt.toISOString(),
        completedAt: tx.status === "success" ? tx.updatedAt.toISOString() : null,
      };
    }
  );

  app.post(
    "/portal/me/payouts",
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
          201: z.object({
            transactionId: z.string(),
            reference: z.string(),
            status: z.string(),
            amount: z.string(),
            platformOrderId: z.string().nullable(),
            environment: z.enum(["test", "live"]),
            recipient: z.object({ masked: z.string() }),
            estimatedCompletion: z.string().nullable(),
          }),
          400: payoutErrorResponse,
          401: errorResponse,
          403: errorResponse,
          503: merchantFacingPayoutError,
          500: merchantFacingPayoutError,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const body = request.body as {
        environment: "test" | "live";
        amount: string;
        benificiaryAccountInfo: {
          number: string;
          orgId: string;
          orgCode: string;
          orgName: string;
          holderName: string;
        };
        cardHolderInfo: {
          firstName: string;
          lastName: string;
          email: string;
          phone: string;
        };
      };

      const amount = Number(body.amount);
      if (!Number.isFinite(amount)) {
        return reply.status(400).send({ error: "Bad Request", message: "Invalid amount" });
      }
      if (amount < LIMITS.payout.min || amount > LIMITS.payout.max) {
        return reply
          .status(400)
          .send({ error: "Bad Request", message: `Amount must be between ${LIMITS.payout.min} and ${LIMITS.payout.max} BDT` });
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
          return reply.status(403).send({ error: "Forbidden", message: "KYC verification required for live payouts" });
        }
      }

      const baseUrl = process.env.APP_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
      try {
        const result = await createPayoutOrder({
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

        return reply.status(201).send({
          transactionId: result.transactionId,
          reference: result.transactionId,
          status: result.status ?? "pending",
          amount: body.amount,
          platformOrderId: result.platformOrderId ?? null,
          environment: body.environment,
          recipient: { masked: maskRecipient(body.benificiaryAccountInfo.number) },
          estimatedCompletion: null,
        });
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        audit({
          action: "portal.payout.failed",
          merchantId: user.merchantId,
          merchantUserId: user.merchantUserId,
          actorEmail: user.email,
          meta: { message: rawMsg },
        });

        const mapped = merchantPaymentFlowErrorResponse(err);
        request.log.warn(
          { logDetail: mapped.logDetail ?? rawMsg, merchantId: user.merchantId },
          "portal payout failed"
        );
        sendMerchantFacingReply(reply, mapped);
      }
    }
  );

  app.post(
    "/portal/me/transfers",
    {
      schema: {
        body: z.object({
          environment: z.enum(["test", "live"]).default("test"),
          customerWalletId: z.string().uuid(),
          amount: z.string(),
          reason: z.string().max(500).optional(),
        }),
        response: {
          201: z.object({
            id: z.string(),
            type: z.string(),
            status: z.string(),
            amount: z.string(),
            customerWalletId: z.string(),
            createdAt: z.string(),
          }),
          400: merchantFacingOperationError,
          401: errorResponse,
          503: merchantFacingOperationError,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const body = request.body as {
        environment: "test" | "live";
        customerWalletId: string;
        amount: string;
        reason?: string;
      };

      try {
        const tx = await transferToCustomer({
          merchantId: user.merchantId,
          environment: body.environment,
          customerWalletId: body.customerWalletId,
          amount: body.amount,
          reason: body.reason,
        });

        audit({
          action: "portal.transfer.created",
          merchantId: user.merchantId,
          merchantUserId: user.merchantUserId,
          actorEmail: user.email,
          resource: tx.id,
          meta: {
            environment: body.environment,
            amount: body.amount,
            customerWalletId: body.customerWalletId,
          },
        });

        return reply.status(201).send({
          id: tx.id,
          type: tx.type,
          status: tx.status,
          amount: String(tx.amount),
          customerWalletId: body.customerWalletId,
          createdAt: tx.createdAt.toISOString(),
        });
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const mapped = merchantPortalOperationErrorResponse(err);
        request.log.warn(
          { logDetail: mapped.logDetail ?? rawMsg, merchantId: user.merchantId },
          "portal transfer failed"
        );
        sendPortalOperationReply(reply, mapped);
      }
    }
  );

  app.post(
    "/portal/me/refunds",
    {
      schema: {
        body: z.object({
          environment: z.enum(["test", "live"]).default("test"),
          customerWalletId: z.string().uuid(),
          amount: z.string(),
          refundOfTransactionId: z.string().uuid(),
          reason: z.string().max(500).optional(),
        }),
        response: {
          201: z.object({
            id: z.string(),
            type: z.string(),
            status: z.string(),
            amount: z.string(),
            customerWalletId: z.string(),
            refundOfTransactionId: z.string(),
            createdAt: z.string(),
          }),
          400: merchantFacingOperationError,
          401: errorResponse,
          503: merchantFacingOperationError,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const body = request.body as {
        environment: "test" | "live";
        customerWalletId: string;
        amount: string;
        refundOfTransactionId: string;
        reason?: string;
      };

      try {
        const tx = await refundToCustomer({
          merchantId: user.merchantId,
          environment: body.environment,
          customerWalletId: body.customerWalletId,
          amount: body.amount,
          refundOfTransactionId: body.refundOfTransactionId,
          reason: body.reason,
        });

        audit({
          action: "portal.refund.created",
          merchantId: user.merchantId,
          merchantUserId: user.merchantUserId,
          actorEmail: user.email,
          resource: tx.id,
          meta: {
            environment: body.environment,
            amount: body.amount,
            customerWalletId: body.customerWalletId,
            refundOfTransactionId: body.refundOfTransactionId,
          },
        });

        return reply.status(201).send({
          id: tx.id,
          type: tx.type,
          status: tx.status,
          amount: String(tx.amount),
          customerWalletId: body.customerWalletId,
          refundOfTransactionId: body.refundOfTransactionId,
          createdAt: tx.createdAt.toISOString(),
        });
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const mapped = merchantPortalOperationErrorResponse(err);
        request.log.warn(
          { logDetail: mapped.logDetail ?? rawMsg, merchantId: user.merchantId },
          "portal refund failed"
        );
        sendPortalOperationReply(reply, mapped);
      }
    }
  );
}
