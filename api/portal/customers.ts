/**
 * Portal customers: list, create, get, update wallet status (block/pending).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, count, desc, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { wallets, transactions } from "../../src/db/schema/index.js";
import { createCustomerWallet } from "../../services/operations/transfers.js";
import { audit } from "../../src/lib/audit.js";
import { presentTransactionListItems } from "../../src/lib/present-transaction.js";
import { transactionFeeSummaryFieldsSchema } from "../../src/lib/billing/transaction-fee-breakdown.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

const WALLET_STATUS = ["active", "frozen", "pending", "closed"] as const;

const transactionListItemSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    status: z.string(),
    amount: z.string(),
    paidAmount: z.string().nullable(),
    platformOrderId: z.string().nullable(),
    customerWalletId: z.string().nullable(),
    refundOfTransactionId: z.string().nullable(),
    settlementCurrency: z.string(),
    currency: z.string(),
    rail: z.string(),
    railLabel: z.string(),
    createdAt: z.string(),
    completedAt: z.string().nullable(),
  })
  .merge(transactionFeeSummaryFieldsSchema.partial());

const customerDossierSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  balance: z.string(),
  currency: z.string(),
  status: z.string(),
  environment: z.enum(["test", "live"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  txSummary: z.object({
    total: z.number(),
    pending: z.number(),
    success: z.number(),
    failed: z.number(),
  }),
  recentTransactions: z.array(transactionListItemSchema),
});

export async function registerPortalCustomersRoutes(app: FastifyInstance) {
  app.get(
    "/portal/me/customers",
    {
      schema: {
        querystring: z.object({
          environment: z.enum(["test", "live"]).default("test"),
          limit: z.coerce.number().min(1).max(100).default(20),
          offset: z.coerce.number().min(0).default(0),
          status: z.enum(["active", "frozen", "pending", "closed"]).optional(),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                label: z.string().nullable(),
                balance: z.string(),
                currency: z.string(),
                status: z.string(),
                createdAt: z.string(),
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

      const { environment, limit, offset, status } = request.query as {
        environment: "test" | "live";
        limit: number;
        offset: number;
        status?: (typeof WALLET_STATUS)[number];
      };

      const conditions = [
        eq(wallets.merchantId, user.merchantId),
        eq(wallets.environment, environment),
        eq(wallets.type, "customer"),
      ];
      if (status) conditions.push(eq(wallets.status, status));

      const [totalResult] = await db
        .select({ count: count() })
        .from(wallets)
        .where(and(...conditions));

      const rows = await db
        .select({
          id: wallets.id,
          label: wallets.label,
          balance: wallets.balance,
          currency: wallets.currency,
          status: wallets.status,
          createdAt: wallets.createdAt,
        })
        .from(wallets)
        .where(and(...conditions))
        .orderBy(desc(wallets.createdAt))
        .limit(limit)
        .offset(offset);

      return {
        items: rows.map((r) => ({
          id: r.id,
          label: r.label,
          balance: String(r.balance),
          currency: r.currency,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
        })),
        total: Number(totalResult?.count ?? 0),
        limit,
        offset,
      };
    }
  );

  app.post(
    "/portal/me/customers",
    {
      schema: {
        body: z.object({
          environment: z.enum(["test", "live"]).default("test"),
          label: z.string().max(200).optional(),
        }),
        response: {
          201: z.object({
            id: z.string(),
            label: z.string().nullable(),
            balance: z.string(),
            currency: z.string(),
            status: z.string(),
            createdAt: z.string(),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const body = request.body as { environment: "test" | "live"; label?: string };

      const customer = await createCustomerWallet({
        merchantId: user.merchantId,
        environment: body.environment,
        label: body.label?.trim() || undefined,
      });

      audit({
        action: "portal.customer.wallet_created",
        merchantId: user.merchantId,
        merchantUserId: user.merchantUserId,
        actorEmail: user.email,
        resource: customer.id,
        meta: { environment: body.environment, label: customer.label },
      });

      return reply.status(201).send({
        id: customer.id,
        label: customer.label,
        balance: String(customer.balance),
        currency: customer.currency,
        status: customer.status,
        createdAt: customer.createdAt.toISOString(),
      });
    }
  );

  app.get(
    "/portal/me/customers/:id",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          environment: z.enum(["test", "live"]).default("test"),
        }),
        response: {
          200: customerDossierSchema,
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

      const [wallet] = await db
        .select()
        .from(wallets)
        .where(
          and(
            eq(wallets.id, id),
            eq(wallets.merchantId, user.merchantId),
            eq(wallets.environment, environment),
            eq(wallets.type, "customer")
          )
        )
        .limit(1);

      if (!wallet) {
        return reply.status(404).send({ error: "Not found", message: "Customer not found" });
      }

      const [counts] = await db
        .select({
          total: count(),
          pending: sql<number>`count(*) filter (where ${transactions.status} = 'pending')`,
          success: sql<number>`count(*) filter (where ${transactions.status} = 'success')`,
          failed: sql<number>`count(*) filter (where ${transactions.status} = 'failed')`,
        })
        .from(transactions)
        .where(and(eq(transactions.walletId, id), eq(transactions.environment, environment)));

      const recentRows = await db
        .select({
          id: transactions.id,
          type: transactions.type,
          status: transactions.status,
          amount: transactions.amount,
          paidAmount: transactions.paidAmount,
          currency: transactions.currency,
          provider: transactions.provider,
          externalId: transactions.externalId,
          walletId: transactions.walletId,
          metadata: transactions.metadata,
          createdAt: transactions.createdAt,
          updatedAt: transactions.updatedAt,
        })
        .from(transactions)
        .where(and(eq(transactions.walletId, id), eq(transactions.environment, environment)))
        .orderBy(desc(transactions.createdAt))
        .limit(10);

      const recentTransactions = await presentTransactionListItems({
        merchantId: user.merchantId,
        environment,
        rows: recentRows,
      });

      return {
        id: wallet.id,
        label: wallet.label,
        balance: String(wallet.balance),
        currency: wallet.currency,
        status: wallet.status,
        environment: wallet.environment as "test" | "live",
        createdAt: wallet.createdAt.toISOString(),
        updatedAt: wallet.updatedAt.toISOString(),
        txSummary: {
          total: Number(counts?.total ?? 0),
          pending: Number(counts?.pending ?? 0),
          success: Number(counts?.success ?? 0),
          failed: Number(counts?.failed ?? 0),
        },
        recentTransactions,
      };
    }
  );

  app.patch(
    "/portal/me/customers/:id/status",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          environment: z.enum(["test", "live"]).default("test"),
        }),
        body: z.object({
          status: z.enum(["active", "frozen", "pending", "closed"]),
          reason: z.string().max(500).optional(),
        }),
        response: {
          200: z.object({
            id: z.string(),
            status: z.string(),
          }),
          400: errorResponse,
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
      const body = request.body as { status: string; reason?: string };

      const [wallet] = await db
        .select()
        .from(wallets)
        .where(
          and(
            eq(wallets.id, id),
            eq(wallets.merchantId, user.merchantId),
            eq(wallets.environment, environment),
            eq(wallets.type, "customer")
          )
        )
        .limit(1);

      if (!wallet) {
        return reply.status(404).send({ error: "Not found", message: "Customer not found" });
      }

      if (body.status === "closed" && Number(wallet.balance) > 0) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Cannot close wallet with positive balance. Transfer or refund first.",
        });
      }

      const previousStatus = wallet.status;

      await db
        .update(wallets)
        .set({ status: body.status as "active" | "frozen" | "pending" | "closed", updatedAt: new Date() })
        .where(eq(wallets.id, id));

      audit({
        action: "portal.customer.wallet_status_changed",
        merchantId: user.merchantId,
        merchantUserId: user.merchantUserId,
        actorEmail: user.email,
        resource: id,
        meta: {
          environment,
          from: previousStatus,
          to: body.status,
          reason: body.reason,
        },
      });

      return { id, status: body.status };
    }
  );

  app.get(
    "/portal/me/customers/:id/transactions",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          environment: z.enum(["test", "live"]).default("test"),
          limit: z.coerce.number().min(1).max(100).default(20),
          offset: z.coerce.number().min(0).default(0),
        }),
        response: {
          200: z.object({
            items: z.array(transactionListItemSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
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
      const { environment, limit, offset } = request.query as {
        environment: "test" | "live";
        limit: number;
        offset: number;
      };

      const [wallet] = await db
        .select()
        .from(wallets)
        .where(
          and(
            eq(wallets.id, id),
            eq(wallets.merchantId, user.merchantId),
            eq(wallets.environment, environment),
            eq(wallets.type, "customer")
          )
        )
        .limit(1);

      if (!wallet) {
        return reply.status(404).send({ error: "Not found", message: "Customer not found" });
      }

      const [totalResult] = await db
        .select({ count: count() })
        .from(transactions)
        .where(and(eq(transactions.walletId, id), eq(transactions.environment, environment)));

      const rows = await db
        .select({
          id: transactions.id,
          type: transactions.type,
          status: transactions.status,
          amount: transactions.amount,
          paidAmount: transactions.paidAmount,
          currency: transactions.currency,
          provider: transactions.provider,
          externalId: transactions.externalId,
          walletId: transactions.walletId,
          metadata: transactions.metadata,
          createdAt: transactions.createdAt,
          updatedAt: transactions.updatedAt,
        })
        .from(transactions)
        .where(and(eq(transactions.walletId, id), eq(transactions.environment, environment)))
        .orderBy(desc(transactions.createdAt))
        .limit(limit)
        .offset(offset);

      const items = await presentTransactionListItems({
        merchantId: user.merchantId,
        environment,
        rows,
      });

      return {
        items,
        total: Number(totalResult?.count ?? 0),
        limit,
        offset,
      };
    }
  );
}
