/**
 * Portal transactions: list, detail, create transfer, create refund.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, count, desc } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { transactions } from "../../src/db/schema/index.js";
import {
  transferToCustomer,
  refundToCustomer,
} from "../../services/operations/transfers.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

export async function registerPortalTransactionsRoutes(app: FastifyInstance) {
  app.get(
    "/portal/me/transactions",
    {
      schema: {
        querystring: z.object({
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

      const { type, status, customerId, limit, offset } = request.query as {
        type?: "payin" | "payout" | "transfer" | "refund";
        status?: "pending" | "success" | "failed";
        customerId?: string;
        limit: number;
        offset: number;
      };

      const conditions = [eq(transactions.merchantId, user.merchantId)];
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
            metadata: z.record(z.string()).nullable(),
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

      const [tx] = await db
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.id, id), eq(transactions.merchantId, user.merchantId))
        )
        .limit(1);

      if (!tx) {
        return reply.status(404).send({ error: "Not found", message: "Transaction not found" });
      }

      let metadata: Record<string, string> | null = null;
      let refundOfTransactionId: string | null = null;
      if (tx.metadata) {
        try {
          metadata = JSON.parse(tx.metadata) as Record<string, string>;
          refundOfTransactionId = metadata?.refundOfTransactionId ?? null;
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
    "/portal/me/transfers",
    {
      schema: {
        body: z.object({
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
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const body = request.body as {
        customerWalletId: string;
        amount: string;
        reason?: string;
      };

      try {
        const tx = await transferToCustomer({
          merchantId: user.merchantId,
          customerWalletId: body.customerWalletId,
          amount: body.amount,
          reason: body.reason,
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
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: "Bad Request", message: msg });
      }
    }
  );

  app.post(
    "/portal/me/refunds",
    {
      schema: {
        body: z.object({
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
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const body = request.body as {
        customerWalletId: string;
        amount: string;
        refundOfTransactionId: string;
        reason?: string;
      };

      try {
        const tx = await refundToCustomer({
          merchantId: user.merchantId,
          customerWalletId: body.customerWalletId,
          amount: body.amount,
          refundOfTransactionId: body.refundOfTransactionId,
          reason: body.reason,
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
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: "Bad Request", message: msg });
      }
    }
  );
}
