import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, count, desc, eq, ilike, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  ledgerEntries,
  merchantBusinessProfiles,
  merchantKycDocuments,
  merchantPersons,
  merchants,
  transactions,
  wallets,
} from "../../src/db/schema/index.js";
import { audit } from "../../src/lib/audit.js";
import {
  payokPayinInquiry,
  payokPayoutInquiry,
} from "../../services/domestic/bangladesh/provider/client.js";
import { PROVIDER_ROLES, canProviderAccess } from "../../src/lib/provider-auth.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

const MERCHANT_STATUS = ["pending", "active", "suspended", "closed"] as const;
const KYC_STATUS = ["pending", "verified", "rejected"] as const;
const KYC_PROFILE_STATUS = ["draft", "submitted", "verified", "rejected"] as const;
const WALLET_STATUS = ["active", "frozen", "pending", "closed"] as const;
const TRANSACTION_STATUS = ["pending", "success", "failed"] as const;
const TRANSACTION_TYPE = ["payin", "payout", "transfer", "refund"] as const;
const ADJUSTMENT_DIRECTION = ["credit", "debit"] as const;
const PAYOK_TX_TYPE = ["payin", "payout"] as const;

function mergeMetadata(metadata: string | null, patch: Record<string, unknown>): string {
  let current: Record<string, unknown> = {};
  if (metadata) {
    try {
      current = JSON.parse(metadata) as Record<string, unknown>;
    } catch {
      current = { rawMetadata: metadata };
    }
  }
  return JSON.stringify({
    ...current,
    providerFix: {
      ...(typeof current.providerFix === "object" && current.providerFix ? (current.providerFix as object) : {}),
      ...patch,
      fixedAt: new Date().toISOString(),
    },
  });
}

function toMoneyString(value: number): string {
  return value.toFixed(2);
}

function derivePayokOutcome(payload: unknown): {
  code?: string;
  status?: string;
  isSuccess: boolean;
} {
  const obj = (payload ?? {}) as Record<string, unknown>;
  const code = typeof obj.code === "string" ? obj.code : undefined;
  const status = typeof obj.status === "string" ? obj.status : undefined;
  const isSuccess = code === "SUCCESS" && status === "SUCCESS";
  return { code, status, isSuccess };
}

function ensureProviderPermission(
  request: FastifyRequest,
  reply: FastifyReply,
  permission:
    | "merchant.read"
    | "merchant.status.write"
    | "merchant.kyc.write"
    | "customer.read"
    | "customer.status.write"
    | "wallet.adjust"
    | "tx.read"
    | "tx.reconcile"
    | "tx.status.write"
): boolean {
  const actor = request.provider;
  if (!actor) {
    reply.status(401).send({ error: "Unauthorized" });
    return false;
  }
  if (!canProviderAccess(actor.role, permission)) {
    reply.status(403).send({ error: "Forbidden", message: "Insufficient role permission" });
    return false;
  }
  return true;
}

export async function registerProviderRoutes(app: FastifyInstance) {
  app.get(
    "/provider/me",
    {
      schema: {
        response: {
          200: z.object({
            role: z.enum(PROVIDER_ROLES),
            authType: z.enum(["api_key", "jwt"]),
            email: z.string().nullable(),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!request.provider) return reply.status(401).send({ error: "Unauthorized" });
      return {
        role: request.provider.role,
        authType: request.provider.authType,
        email: request.provider.email ?? null,
      };
    }
  );

  app.get(
    "/provider/merchants",
    {
      schema: {
        querystring: z.object({
          limit: z.coerce.number().min(1).max(100).default(20),
          offset: z.coerce.number().min(0).default(0),
          status: z.enum(MERCHANT_STATUS).optional(),
          kycStatus: z.enum(KYC_STATUS).optional(),
          q: z.string().min(1).max(200).optional(),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                status: z.string(),
                kycStatus: z.string(),
                merchantBalance: z.string().nullable(),
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
      if (!ensureProviderPermission(request, reply, "merchant.read")) return;
      const { limit, offset, status, kycStatus, q } = request.query as {
        limit: number;
        offset: number;
        status?: (typeof MERCHANT_STATUS)[number];
        kycStatus?: (typeof KYC_STATUS)[number];
        q?: string;
      };

      const conditions = [];
      if (status) conditions.push(eq(merchants.status, status));
      if (kycStatus) conditions.push(eq(merchants.kycStatus, kycStatus));
      if (q) conditions.push(ilike(merchants.name, `%${q}%`));

      const [totalResult] = await db
        .select({ count: count() })
        .from(merchants)
        .where(conditions.length ? and(...conditions) : undefined);

      const rows = await db
        .select({
          id: merchants.id,
          name: merchants.name,
          status: merchants.status,
          kycStatus: merchants.kycStatus,
          createdAt: merchants.createdAt,
        })
        .from(merchants)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(merchants.createdAt))
        .limit(limit)
        .offset(offset);

      const merchantIds = rows.map((r) => r.id);
      const walletRows = merchantIds.length
        ? await db
            .select({
              merchantId: wallets.merchantId,
              balance: wallets.balance,
            })
            .from(wallets)
            .where(and(eq(wallets.type, "merchant"), inArray(wallets.merchantId, merchantIds)))
        : [];
      const balanceMap = new Map(walletRows.map((w) => [w.merchantId, String(w.balance)]));

      return {
        items: rows.map((r) => ({
          id: r.id,
          name: r.name,
          status: r.status,
          kycStatus: r.kycStatus ?? "pending",
          merchantBalance: balanceMap.get(r.id) ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
        total: Number(totalResult?.count ?? 0),
        limit,
        offset,
      };
    }
  );

  app.get(
    "/provider/merchants/:merchantId",
    {
      schema: {
        params: z.object({ merchantId: z.string().uuid() }),
        response: {
          200: z.object({
            id: z.string(),
            name: z.string(),
            status: z.string(),
            kycStatus: z.string(),
            merchantWallet: z
              .object({
                id: z.string(),
                balance: z.string(),
                status: z.string(),
              })
              .nullable(),
            kycProfile: z
              .object({
                id: z.string(),
                legalName: z.string(),
                businessType: z.string(),
                status: z.string(),
                rejectionReason: z.string().nullable(),
              })
              .nullable(),
            personsCount: z.number(),
            documentsCount: z.number(),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "merchant.read")) return;
      const { merchantId } = request.params as { merchantId: string };

      const [merchant] = await db
        .select()
        .from(merchants)
        .where(eq(merchants.id, merchantId))
        .limit(1);
      if (!merchant) {
        return reply.status(404).send({ error: "Not found", message: "Merchant not found" });
      }

      const [merchantWallet] = await db
        .select()
        .from(wallets)
        .where(and(eq(wallets.merchantId, merchantId), eq(wallets.type, "merchant")))
        .limit(1);

      const [profile] = await db
        .select()
        .from(merchantBusinessProfiles)
        .where(eq(merchantBusinessProfiles.merchantId, merchantId))
        .limit(1);

      const [personsCount] = await db
        .select({ count: count() })
        .from(merchantPersons)
        .where(eq(merchantPersons.merchantId, merchantId));
      const [documentsCount] = await db
        .select({ count: count() })
        .from(merchantKycDocuments)
        .where(eq(merchantKycDocuments.merchantId, merchantId));

      return {
        id: merchant.id,
        name: merchant.name,
        status: merchant.status,
        kycStatus: merchant.kycStatus ?? "pending",
        merchantWallet: merchantWallet
          ? {
              id: merchantWallet.id,
              balance: String(merchantWallet.balance),
              status: merchantWallet.status,
            }
          : null,
        kycProfile: profile
          ? {
              id: profile.id,
              legalName: profile.legalName,
              businessType: profile.businessType,
              status: profile.status,
              rejectionReason: profile.rejectionReason,
            }
          : null,
        personsCount: Number(personsCount?.count ?? 0),
        documentsCount: Number(documentsCount?.count ?? 0),
      };
    }
  );

  app.patch(
    "/provider/merchants/:merchantId/status",
    {
      schema: {
        params: z.object({ merchantId: z.string().uuid() }),
        body: z.object({
          status: z.enum(MERCHANT_STATUS),
          reason: z.string().max(500).optional(),
        }),
        response: {
          200: z.object({
            id: z.string(),
            status: z.string(),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "merchant.status.write")) return;
      const { merchantId } = request.params as { merchantId: string };
      const { status, reason } = request.body as { status: (typeof MERCHANT_STATUS)[number]; reason?: string };

      const [existing] = await db
        .select({ id: merchants.id, status: merchants.status })
        .from(merchants)
        .where(eq(merchants.id, merchantId))
        .limit(1);
      if (!existing) {
        return reply.status(404).send({ error: "Not found", message: "Merchant not found" });
      }

      await db
        .update(merchants)
        .set({ status, updatedAt: new Date() })
        .where(eq(merchants.id, merchantId));

      audit({
        action: "provider.merchant.status_changed",
        actor: "provider:super_admin",
        resource: merchantId,
        meta: { from: existing.status, to: status, reason: reason ?? null },
      });

      return { id: merchantId, status };
    }
  );

  app.patch(
    "/provider/merchants/:merchantId/kyc",
    {
      schema: {
        params: z.object({ merchantId: z.string().uuid() }),
        body: z.object({
          kycStatus: z.enum(KYC_STATUS),
          reason: z.string().max(500).optional(),
        }),
        response: {
          200: z.object({
            id: z.string(),
            kycStatus: z.string(),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "merchant.kyc.write")) return;
      const { merchantId } = request.params as { merchantId: string };
      const { kycStatus, reason } = request.body as { kycStatus: (typeof KYC_STATUS)[number]; reason?: string };

      const [existing] = await db
        .select({ id: merchants.id, kycStatus: merchants.kycStatus })
        .from(merchants)
        .where(eq(merchants.id, merchantId))
        .limit(1);
      if (!existing) {
        return reply.status(404).send({ error: "Not found", message: "Merchant not found" });
      }

      await db
        .update(merchants)
        .set({ kycStatus, updatedAt: new Date() })
        .where(eq(merchants.id, merchantId));

      const [profile] = await db
        .select()
        .from(merchantBusinessProfiles)
        .where(eq(merchantBusinessProfiles.merchantId, merchantId))
        .limit(1);

      if (profile) {
        const profileStatus: (typeof KYC_PROFILE_STATUS)[number] =
          kycStatus === "verified" ? "verified" : kycStatus === "rejected" ? "rejected" : "submitted";
        await db
          .update(merchantBusinessProfiles)
          .set({
            status: profileStatus,
            verifiedAt: kycStatus === "verified" ? new Date() : null,
            rejectedAt: kycStatus === "rejected" ? new Date() : null,
            rejectionReason: kycStatus === "rejected" ? reason ?? null : null,
            updatedAt: new Date(),
          })
          .where(eq(merchantBusinessProfiles.id, profile.id));
      }

      audit({
        action: "provider.merchant.kyc_changed",
        actor: "provider:super_admin",
        resource: merchantId,
        meta: { from: existing.kycStatus ?? "pending", to: kycStatus, reason: reason ?? null },
      });

      return { id: merchantId, kycStatus };
    }
  );

  app.get(
    "/provider/customers",
    {
      schema: {
        querystring: z.object({
          merchantId: z.string().uuid().optional(),
          status: z.enum(WALLET_STATUS).optional(),
          limit: z.coerce.number().min(1).max(100).default(20),
          offset: z.coerce.number().min(0).default(0),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                merchantId: z.string(),
                merchantName: z.string(),
                label: z.string().nullable(),
                balance: z.string(),
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
      if (!ensureProviderPermission(request, reply, "customer.read")) return;
      const { merchantId, status, limit, offset } = request.query as {
        merchantId?: string;
        status?: (typeof WALLET_STATUS)[number];
        limit: number;
        offset: number;
      };

      const conditions = [eq(wallets.type, "customer")];
      if (merchantId) conditions.push(eq(wallets.merchantId, merchantId));
      if (status) conditions.push(eq(wallets.status, status));

      const [totalResult] = await db
        .select({ count: count() })
        .from(wallets)
        .where(and(...conditions));

      const rows = await db
        .select({
          id: wallets.id,
          merchantId: wallets.merchantId,
          merchantName: merchants.name,
          label: wallets.label,
          balance: wallets.balance,
          status: wallets.status,
          createdAt: wallets.createdAt,
        })
        .from(wallets)
        .innerJoin(merchants, eq(wallets.merchantId, merchants.id))
        .where(and(...conditions))
        .orderBy(desc(wallets.createdAt))
        .limit(limit)
        .offset(offset);

      return {
        items: rows.map((r) => ({
          id: r.id,
          merchantId: r.merchantId,
          merchantName: r.merchantName,
          label: r.label,
          balance: String(r.balance),
          status: r.status,
          createdAt: r.createdAt.toISOString(),
        })),
        total: Number(totalResult?.count ?? 0),
        limit,
        offset,
      };
    }
  );

  app.patch(
    "/provider/customers/:walletId/status",
    {
      schema: {
        params: z.object({ walletId: z.string().uuid() }),
        body: z.object({
          status: z.enum(WALLET_STATUS),
          reason: z.string().max(500).optional(),
        }),
        response: {
          200: z.object({ id: z.string(), status: z.string() }),
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "customer.status.write")) return;
      const { walletId } = request.params as { walletId: string };
      const { status, reason } = request.body as { status: (typeof WALLET_STATUS)[number]; reason?: string };

      const [customer] = await db
        .select()
        .from(wallets)
        .where(and(eq(wallets.id, walletId), eq(wallets.type, "customer")))
        .limit(1);
      if (!customer) {
        return reply.status(404).send({ error: "Not found", message: "Customer wallet not found" });
      }
      if (status === "closed" && Number(customer.balance) > 0) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Cannot close wallet with positive balance",
        });
      }

      await db
        .update(wallets)
        .set({ status, updatedAt: new Date() })
        .where(eq(wallets.id, walletId));

      audit({
        action: "provider.customer.status_changed",
        actor: "provider:super_admin",
        resource: walletId,
        meta: { merchantId: customer.merchantId, from: customer.status, to: status, reason: reason ?? null },
      });

      return { id: walletId, status };
    }
  );

  app.post(
    "/provider/merchants/:merchantId/wallet-adjustments",
    {
      schema: {
        params: z.object({ merchantId: z.string().uuid() }),
        body: z.object({
          direction: z.enum(ADJUSTMENT_DIRECTION),
          amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
          reason: z.string().min(3).max(500),
          referenceId: z.string().min(3).max(200),
        }),
        response: {
          200: z.object({
            merchantId: z.string(),
            walletId: z.string(),
            direction: z.string(),
            amount: z.string(),
            previousBalance: z.string(),
            currentBalance: z.string(),
          }),
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "wallet.adjust")) return;
      const { merchantId } = request.params as { merchantId: string };
      const body = request.body as {
        direction: (typeof ADJUSTMENT_DIRECTION)[number];
        amount: string;
        reason: string;
        referenceId: string;
      };

      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return reply.status(400).send({ error: "Bad Request", message: "Amount must be greater than 0" });
      }

      const result = await db.transaction(async (tx) => {
        const [wallet] = await tx
          .select()
          .from(wallets)
          .where(and(eq(wallets.merchantId, merchantId), eq(wallets.type, "merchant")))
          .limit(1);
        if (!wallet) return { error: "WALLET_NOT_FOUND" as const };

        const previousBalance = Number(wallet.balance);
        const nextBalance =
          body.direction === "credit" ? previousBalance + amount : previousBalance - amount;
        if (nextBalance < 0) return { error: "INSUFFICIENT_BALANCE" as const, wallet };

        await tx.insert(ledgerEntries).values({
          walletId: wallet.id,
          amount: toMoneyString(amount),
          direction: body.direction,
          type: "provider_adjustment",
          referenceId: body.referenceId,
        });

        await tx
          .update(wallets)
          .set({ balance: toMoneyString(nextBalance), updatedAt: new Date() })
          .where(eq(wallets.id, wallet.id));

        return {
          wallet,
          previousBalance,
          nextBalance,
        };
      });

      if ("error" in result) {
        if (result.error === "WALLET_NOT_FOUND") {
          return reply.status(404).send({ error: "Not found", message: "Merchant wallet not found" });
        }
        return reply.status(400).send({ error: "Bad Request", message: "Insufficient balance for debit" });
      }

      audit({
        action: "provider.wallet.adjusted",
        actor: "provider:super_admin",
        resource: result.wallet.id,
        meta: {
          merchantId,
          direction: body.direction,
          amount: toMoneyString(amount),
          previousBalance: toMoneyString(result.previousBalance),
          currentBalance: toMoneyString(result.nextBalance),
          reason: body.reason,
          referenceId: body.referenceId,
        },
      });

      return {
        merchantId,
        walletId: result.wallet.id,
        direction: body.direction,
        amount: toMoneyString(amount),
        previousBalance: toMoneyString(result.previousBalance),
        currentBalance: toMoneyString(result.nextBalance),
      };
    }
  );

  app.get(
    "/provider/transactions",
    {
      schema: {
        querystring: z.object({
          merchantId: z.string().uuid().optional(),
          type: z.enum(TRANSACTION_TYPE).optional(),
          status: z.enum(TRANSACTION_STATUS).optional(),
          limit: z.coerce.number().min(1).max(100).default(20),
          offset: z.coerce.number().min(0).default(0),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                merchantId: z.string(),
                merchantName: z.string(),
                type: z.string(),
                status: z.string(),
                amount: z.string(),
                paidAmount: z.string().nullable(),
                platformOrderId: z.string().nullable(),
                createdAt: z.string(),
                updatedAt: z.string(),
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
      if (!ensureProviderPermission(request, reply, "tx.read")) return;
      const { merchantId, type, status, limit, offset } = request.query as {
        merchantId?: string;
        type?: (typeof TRANSACTION_TYPE)[number];
        status?: (typeof TRANSACTION_STATUS)[number];
        limit: number;
        offset: number;
      };
      const conditions = [];
      if (merchantId) conditions.push(eq(transactions.merchantId, merchantId));
      if (type) conditions.push(eq(transactions.type, type));
      if (status) conditions.push(eq(transactions.status, status));

      const [totalResult] = await db
        .select({ count: count() })
        .from(transactions)
        .where(conditions.length ? and(...conditions) : undefined);

      const rows = await db
        .select({
          id: transactions.id,
          merchantId: transactions.merchantId,
          merchantName: merchants.name,
          type: transactions.type,
          status: transactions.status,
          amount: transactions.amount,
          paidAmount: transactions.paidAmount,
          platformOrderId: transactions.externalId,
          createdAt: transactions.createdAt,
          updatedAt: transactions.updatedAt,
        })
        .from(transactions)
        .innerJoin(merchants, eq(transactions.merchantId, merchants.id))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(transactions.createdAt))
        .limit(limit)
        .offset(offset);

      return {
        items: rows.map((r) => ({
          id: r.id,
          merchantId: r.merchantId,
          merchantName: r.merchantName,
          type: r.type,
          status: r.status,
          amount: String(r.amount),
          paidAmount: r.paidAmount ? String(r.paidAmount) : null,
          platformOrderId: r.platformOrderId,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
        total: Number(totalResult?.count ?? 0),
        limit,
        offset,
      };
    }
  );

  app.patch(
    "/provider/transactions/:transactionId/status",
    {
      schema: {
        params: z.object({ transactionId: z.string().uuid() }),
        body: z.object({
          status: z.enum(TRANSACTION_STATUS),
          reason: z.string().min(3).max(500),
          ticketId: z.string().min(3).max(200),
          paidAmount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
          platformOrderId: z.string().optional(),
          force: z.boolean().optional(),
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
      if (!ensureProviderPermission(request, reply, "tx.status.write")) return;
      const { transactionId } = request.params as { transactionId: string };
      const body = request.body as {
        status: (typeof TRANSACTION_STATUS)[number];
        reason: string;
        ticketId: string;
        paidAmount?: string;
        platformOrderId?: string;
        force?: boolean;
      };

      const [existing] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, transactionId))
        .limit(1);
      if (!existing) {
        return reply.status(404).send({ error: "Not found", message: "Transaction not found" });
      }

      const payokManaged = (PAYOK_TX_TYPE as readonly string[]).includes(existing.type);
      if (payokManaged && !body.force) {
        // Default-safe mode: only allow pending -> failed without force for Payok-backed txs.
        const safePendingToFailed = existing.status === "pending" && body.status === "failed";
        if (!safePendingToFailed) {
          return reply.status(400).send({
            error: "Bad Request",
            message:
              "For Payok transactions, only pending->failed is allowed without force. Use reconcile endpoint first, then set force=true with ticketId if needed.",
          });
        }
      }

      const metadata = mergeMetadata(existing.metadata, {
        reason: body.reason,
        ticketId: body.ticketId,
        force: body.force === true,
        fromStatus: existing.status,
        toStatus: body.status,
      });

      await db
        .update(transactions)
        .set({
          status: body.status,
          paidAmount: body.paidAmount ?? existing.paidAmount,
          externalId: body.platformOrderId ?? existing.externalId,
          metadata,
          updatedAt: new Date(),
        })
        .where(eq(transactions.id, transactionId));

      audit({
        action: "provider.transaction.status_changed",
        actor: "provider:super_admin",
        resource: transactionId,
        meta: {
          merchantId: existing.merchantId,
          type: existing.type,
          from: existing.status,
          to: body.status,
          reason: body.reason,
          ticketId: body.ticketId,
          force: body.force === true,
        },
      });

      return { id: transactionId, status: body.status };
    }
  );

  app.get(
    "/provider/transactions/:transactionId/reconcile",
    {
      schema: {
        params: z.object({ transactionId: z.string().uuid() }),
        response: {
          200: z.object({
            transactionId: z.string(),
            type: z.string(),
            localStatus: z.string(),
            platformOrderId: z.string().nullable(),
            payok: z
              .object({
                code: z.string().nullable(),
                status: z.string().nullable(),
                isSuccess: z.boolean(),
                payload: z.record(z.unknown()),
              })
              .nullable(),
            suggestedLocalStatus: z.enum(TRANSACTION_STATUS).nullable(),
            isMismatch: z.boolean(),
          }),
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
          502: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "tx.reconcile")) return;
      const { transactionId } = request.params as { transactionId: string };

      const [txRow] = await db
        .select()
        .from(transactions)
        .where(eq(transactions.id, transactionId))
        .limit(1);
      if (!txRow) {
        return reply.status(404).send({ error: "Not found", message: "Transaction not found" });
      }

      if (!(PAYOK_TX_TYPE as readonly string[]).includes(txRow.type)) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Reconcile is only supported for Payok-backed transaction types (payin, payout)",
        });
      }

      let inquiryStatus: number;
      let inquiryBody: unknown;
      try {
        if (txRow.type === "payin") {
          const res = await payokPayinInquiry(txRow.id);
          inquiryStatus = res.status;
          inquiryBody = res.body;
        } else {
          const res = await payokPayoutInquiry(txRow.id);
          inquiryStatus = res.status;
          inquiryBody = res.body;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(502).send({
          error: "Bad Gateway",
          message: `Payok inquiry failed: ${msg}`,
        });
      }

      if (inquiryStatus !== 200) {
        return reply.status(502).send({
          error: "Bad Gateway",
          message: `Payok inquiry returned non-200 status (${inquiryStatus})`,
        });
      }

      const payload = (inquiryBody ?? {}) as Record<string, unknown>;
      const outcome = derivePayokOutcome(payload);
      const suggestedLocalStatus: (typeof TRANSACTION_STATUS)[number] =
        outcome.isSuccess ? "success" : "failed";
      const isMismatch = txRow.status !== suggestedLocalStatus;

      audit({
        action: "provider.transaction.reconciled",
        actor: "provider:super_admin",
        resource: txRow.id,
        meta: {
          type: txRow.type,
          localStatus: txRow.status,
          payokCode: outcome.code ?? null,
          payokStatus: outcome.status ?? null,
          suggestedLocalStatus,
          isMismatch,
        },
      });

      return {
        transactionId: txRow.id,
        type: txRow.type,
        localStatus: txRow.status,
        platformOrderId: txRow.externalId,
        payok: {
          code: outcome.code ?? null,
          status: outcome.status ?? null,
          isSuccess: outcome.isSuccess,
          payload,
        },
        suggestedLocalStatus,
        isMismatch,
      };
    }
  );
}

