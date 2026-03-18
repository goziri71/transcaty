import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, count, desc, eq, ilike, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  ledgerEntries,
  providerActionRequests,
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
const APPROVAL_STATUS = ["pending", "approved", "rejected", "executed", "cancelled"] as const;
const APPROVAL_ACTION = ["wallet_adjustment", "transaction_status_change"] as const;
const DEFAULT_APPROVAL_THRESHOLD = Number(process.env.PROVIDER_APPROVAL_THRESHOLD_AMOUNT ?? "10000");

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
    | "approval.read"
    | "approval.review"
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

function parsePayload(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return { raw: value };
  }
}

function getApprovalRiskLevel(params: {
  actionType: (typeof APPROVAL_ACTION)[number];
  amount?: number;
  direction?: "credit" | "debit";
  force?: boolean;
}): "normal" | "high" {
  if (params.actionType === "wallet_adjustment") {
    if ((params.amount ?? 0) >= DEFAULT_APPROVAL_THRESHOLD) return "high";
    if (params.direction === "debit") return "high";
  }
  if (params.actionType === "transaction_status_change" && params.force) return "high";
  return "normal";
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
          202: z.object({
            requestId: z.string(),
            status: z.literal("pending"),
            requiresApproval: z.literal(true),
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

      const actor = request.provider!;
      const riskLevel = getApprovalRiskLevel({
        actionType: "wallet_adjustment",
        amount,
        direction: body.direction,
      });
      const needsApproval = riskLevel === "high" && actor.role !== "super_admin";
      if (needsApproval) {
        const [requestRow] = await db
          .insert(providerActionRequests)
          .values({
            actionType: "wallet_adjustment",
            status: "pending",
            requestedBy: actor.providerUserId ?? null,
            resourceType: "merchant_wallet",
            resourceId: merchantId,
            payload: JSON.stringify({
              merchantId,
              direction: body.direction,
              amount: toMoneyString(amount),
              reason: body.reason,
              referenceId: body.referenceId,
            }),
            reason: body.reason,
            ticketId: body.referenceId,
            riskLevel,
          })
          .returning({ id: providerActionRequests.id });

        audit({
          action: "provider.wallet.adjusted",
          actor: actor.providerUserId ?? "provider:api_key",
          resource: merchantId,
          meta: {
            queuedOnly: true,
            direction: body.direction,
            amount: toMoneyString(amount),
            reason: body.reason,
            referenceId: body.referenceId,
            approvalRequestId: requestRow.id,
            riskLevel,
          },
        });

        return reply.status(202).send({
          requestId: requestRow.id,
          status: "pending",
          requiresApproval: true,
        });
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
          202: z.object({
            requestId: z.string(),
            status: z.literal("pending"),
            requiresApproval: z.literal(true),
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

      const actor = request.provider!;
      const highRiskChange =
        body.force === true ||
        body.status === "success" ||
        (existing.status !== "pending" && body.status !== "failed");
      if (highRiskChange && actor.role !== "super_admin") {
        const [requestRow] = await db
          .insert(providerActionRequests)
          .values({
            actionType: "transaction_status_change",
            status: "pending",
            requestedBy: actor.providerUserId ?? null,
            resourceType: "transaction",
            resourceId: transactionId,
            payload: JSON.stringify({
              transactionId,
              status: body.status,
              reason: body.reason,
              ticketId: body.ticketId,
              paidAmount: body.paidAmount ?? null,
              platformOrderId: body.platformOrderId ?? null,
              force: body.force === true,
            }),
            reason: body.reason,
            ticketId: body.ticketId,
            riskLevel: getApprovalRiskLevel({
              actionType: "transaction_status_change",
              force: body.force === true,
            }),
          })
          .returning({ id: providerActionRequests.id });

        audit({
          action: "provider.transaction.status_changed",
          actor: actor.providerUserId ?? "provider:api_key",
          resource: transactionId,
          meta: {
            queuedOnly: true,
            merchantId: existing.merchantId,
            type: existing.type,
            from: existing.status,
            to: body.status,
            reason: body.reason,
            ticketId: body.ticketId,
            force: body.force === true,
            approvalRequestId: requestRow.id,
          },
        });

        return reply.status(202).send({
          requestId: requestRow.id,
          status: "pending",
          requiresApproval: true,
        });
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
    "/provider/approvals",
    {
      schema: {
        querystring: z.object({
          status: z.enum(APPROVAL_STATUS).optional(),
          actionType: z.enum(APPROVAL_ACTION).optional(),
          limit: z.coerce.number().min(1).max(100).default(20),
          offset: z.coerce.number().min(0).default(0),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                actionType: z.string(),
                status: z.string(),
                resourceType: z.string(),
                resourceId: z.string(),
                ticketId: z.string().nullable(),
                riskLevel: z.string(),
                requestedBy: z.string().nullable(),
                approvedBy: z.string().nullable(),
                createdAt: z.string(),
                updatedAt: z.string(),
              })
            ),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "approval.read")) return;
      const { status, actionType, limit, offset } = request.query as {
        status?: (typeof APPROVAL_STATUS)[number];
        actionType?: (typeof APPROVAL_ACTION)[number];
        limit: number;
        offset: number;
      };
      const conditions = [];
      if (status) conditions.push(eq(providerActionRequests.status, status));
      if (actionType) conditions.push(eq(providerActionRequests.actionType, actionType));

      const [totalResult] = await db
        .select({ count: count() })
        .from(providerActionRequests)
        .where(conditions.length ? and(...conditions) : undefined);

      const rows = await db
        .select()
        .from(providerActionRequests)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(providerActionRequests.createdAt))
        .limit(limit)
        .offset(offset);

      return {
        items: rows.map((r) => ({
          id: r.id,
          actionType: r.actionType,
          status: r.status,
          resourceType: r.resourceType,
          resourceId: r.resourceId,
          ticketId: r.ticketId,
          riskLevel: r.riskLevel,
          requestedBy: r.requestedBy,
          approvedBy: r.approvedBy,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
        total: Number(totalResult?.count ?? 0),
        limit,
        offset,
      };
    }
  );

  app.post(
    "/provider/approvals/:requestId/approve",
    {
      schema: {
        params: z.object({ requestId: z.string().uuid() }),
        body: z.object({
          note: z.string().max(500).optional(),
        }),
        response: {
          200: z.object({
            id: z.string(),
            status: z.literal("executed"),
          }),
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "approval.review")) return;
      const actor = request.provider!;
      if (!actor.providerUserId) {
        return reply.status(403).send({ error: "Forbidden", message: "JWT provider user required for approvals" });
      }
      const { requestId } = request.params as { requestId: string };

      const result = await db.transaction(async (tx) => {
        const [req] = await tx
          .select()
          .from(providerActionRequests)
          .where(eq(providerActionRequests.id, requestId))
          .limit(1);
        if (!req) return { error: "NOT_FOUND" as const };
        if (req.status !== "pending") return { error: "NOT_PENDING" as const };
        if (req.requestedBy && req.requestedBy === actor.providerUserId) return { error: "MAKER_CHECKER" as const };

        const payload = parsePayload(req.payload);
        if (req.actionType === "wallet_adjustment") {
          const merchantId = String(payload.merchantId ?? "");
          const direction = String(payload.direction ?? "") as "credit" | "debit";
          const amount = Number(payload.amount ?? 0);
          const referenceId = String(payload.referenceId ?? "");
          if (!merchantId || !direction || !amount || !referenceId) return { error: "INVALID_PAYLOAD" as const };

          const [wallet] = await tx
            .select()
            .from(wallets)
            .where(and(eq(wallets.merchantId, merchantId), eq(wallets.type, "merchant")))
            .limit(1);
          if (!wallet) return { error: "WALLET_NOT_FOUND" as const };

          const previousBalance = Number(wallet.balance);
          const nextBalance = direction === "credit" ? previousBalance + amount : previousBalance - amount;
          if (nextBalance < 0) return { error: "INSUFFICIENT_BALANCE" as const };

          await tx.insert(ledgerEntries).values({
            walletId: wallet.id,
            amount: toMoneyString(amount),
            direction,
            type: "provider_adjustment",
            referenceId,
          });
          await tx
            .update(wallets)
            .set({ balance: toMoneyString(nextBalance), updatedAt: new Date() })
            .where(eq(wallets.id, wallet.id));
        } else if (req.actionType === "transaction_status_change") {
          const txId = String(payload.transactionId ?? "");
          const status = String(payload.status ?? "") as (typeof TRANSACTION_STATUS)[number];
          const reason = String(payload.reason ?? "");
          const ticketId = String(payload.ticketId ?? "");
          const paidAmount = payload.paidAmount != null ? String(payload.paidAmount) : undefined;
          const platformOrderId = payload.platformOrderId != null ? String(payload.platformOrderId) : undefined;
          if (!txId || !status || !reason || !ticketId) return { error: "INVALID_PAYLOAD" as const };

          const [existing] = await tx
            .select()
            .from(transactions)
            .where(eq(transactions.id, txId))
            .limit(1);
          if (!existing) return { error: "TX_NOT_FOUND" as const };

          const metadata = mergeMetadata(existing.metadata, {
            reason,
            ticketId,
            approvedBy: actor.providerUserId,
            approvalRequestId: req.id,
            fromStatus: existing.status,
            toStatus: status,
          });
          await tx
            .update(transactions)
            .set({
              status,
              paidAmount: paidAmount ?? existing.paidAmount,
              externalId: platformOrderId ?? existing.externalId,
              metadata,
              updatedAt: new Date(),
            })
            .where(eq(transactions.id, txId));
        }

        await tx
          .update(providerActionRequests)
          .set({
            status: "executed",
            approvedBy: actor.providerUserId,
            executedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(providerActionRequests.id, requestId));

        return { ok: true as const, req };
      });

      if ("error" in result) {
        const errorKey = String(result.error);
        if (errorKey === "NOT_FOUND") {
          return reply.status(404).send({ error: "Not found", message: "Approval request not found" });
        }
        if (errorKey === "WALLET_NOT_FOUND") {
          return reply.status(404).send({ error: "Not found", message: "Merchant wallet not found" });
        }
        if (errorKey === "TX_NOT_FOUND") {
          return reply.status(404).send({ error: "Not found", message: "Transaction not found" });
        }
        if (errorKey === "NOT_PENDING") {
          return reply.status(400).send({ error: "Bad Request", message: "Only pending requests can be approved" });
        }
        if (errorKey === "MAKER_CHECKER") {
          return reply.status(400).send({ error: "Bad Request", message: "Requester cannot approve their own request" });
        }
        if (errorKey === "INVALID_PAYLOAD") {
          return reply.status(400).send({ error: "Bad Request", message: "Invalid approval payload" });
        }
        if (errorKey === "INSUFFICIENT_BALANCE") {
          return reply.status(400).send({ error: "Bad Request", message: "Insufficient balance for debit adjustment" });
        }
        return reply.status(400).send({ error: "Bad Request", message: "Approval failed" });
      }

      audit({
        action: "config.changed",
        actor: actor.providerUserId,
        resource: requestId,
        meta: { approvalStatus: "executed", actionType: result.req.actionType, resourceId: result.req.resourceId },
      });

      return { id: requestId, status: "executed" };
    }
  );

  app.post(
    "/provider/approvals/:requestId/reject",
    {
      schema: {
        params: z.object({ requestId: z.string().uuid() }),
        body: z.object({
          reason: z.string().min(3).max(500),
        }),
        response: {
          200: z.object({ id: z.string(), status: z.literal("rejected") }),
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "approval.review")) return;
      const actor = request.provider!;
      if (!actor.providerUserId) {
        return reply.status(403).send({ error: "Forbidden", message: "JWT provider user required for approvals" });
      }
      const { requestId } = request.params as { requestId: string };
      const { reason } = request.body as { reason: string };

      const [req] = await db
        .select()
        .from(providerActionRequests)
        .where(eq(providerActionRequests.id, requestId))
        .limit(1);
      if (!req) {
        return reply.status(404).send({ error: "Not found", message: "Approval request not found" });
      }
      if (req.status !== "pending") {
        return reply.status(400).send({ error: "Bad Request", message: "Only pending requests can be rejected" });
      }

      await db
        .update(providerActionRequests)
        .set({
          status: "rejected",
          approvedBy: actor.providerUserId,
          rejectedReason: reason,
          rejectedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(providerActionRequests.id, requestId));

      audit({
        action: "config.changed",
        actor: actor.providerUserId,
        resource: requestId,
        meta: { approvalStatus: "rejected", reason },
      });

      return { id: requestId, status: "rejected" };
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

