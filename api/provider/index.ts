import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { sanitizeIlikeSearchQuery } from "../../src/lib/security-config.js";
import { db } from "../../src/db/index.js";
import {
  ledgerEntries,
  merchantAuditLog,
  merchantPricing,
  providerActionRequests,
  merchantBusinessProfiles,
  merchantKycDocuments,
  merchantPersons,
  merchants,
  providerUsers,
  transactions,
  wallets,
} from "../../src/db/schema/index.js";
import { audit } from "../../src/lib/audit.js";
import { parseFeePercentageInput } from "../../src/lib/billing/fee-percentage.js";
import {
  payokPayinInquiry,
  payokPayoutInquiry,
} from "../../services/domestic/bangladesh/provider/client.js";
import {
  PROVIDER_ROLES,
  canProviderAccess,
  canProviderActionContext,
  requireProviderStepUp,
} from "../../src/lib/provider-auth.js";
import { getDefaultPayokEnvironment, type PayokEnvironment } from "../../services/domestic/bangladesh/provider/config.js";
import { pickPrimaryMerchantWallet, primaryMerchantBalanceByMerchantId } from "../../src/lib/provider-merchant-balance.js";
import { reconcilePayokPayinByTransactionId } from "../../services/domestic/payok/reconcile-payin.js";
import { reconcileCrossRampPayinByTransactionId } from "../../services/integrations/tylt/index.js";
import { reconcileTekkoPyusdPayinByTransactionId } from "../../services/integrations/tekko/index.js";
import { ProviderCircuitOpenError } from "../../src/lib/provider-circuit-breaker.js";
import { queueMerchantWebhook } from "../../src/lib/merchant-webhook.js";
import { registerProviderMerchantRiskRoutes } from "./merchant-risk.js";
import { registerProviderMerchantOpsRoutes } from "./merchant-ops.js";
import { registerProviderAdminConfigRoutes } from "./admin-config.js";
import {
  buildReconciliationReport,
  reconciliationReportToCsv,
} from "../../src/lib/reconciliation-report.js";
import { buildTreasuryOverview } from "../../src/lib/treasury-report.js";
import {
  buildMerchantIdentity,
  merchantIdentitySchema,
  merchantRefParamSchema,
  resolveMerchantParam,
} from "../../src/lib/merchant-ref.js";
import { isMerchantUuid } from "../../src/lib/merchant-slug.js";
import { providerMerchantAudit } from "../../src/lib/provider-audit.js";
import { presentTransactionRail } from "../../src/lib/transaction-rail-label.js";

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
    | "merchant.pricing.read"
    | "merchant.pricing.write"
    | "customer.read"
    | "customer.status.write"
    | "wallet.adjust"
    | "tx.read"
    | "tx.reconcile"
    | "tx.status.write"
    | "approval.read"
    | "approval.review"
    | "treasury.read"
): boolean {
  const actor = request.provider;
  if (!actor) {
    reply.status(401).send({ error: "Unauthorized" });
    return false;
  }
  if (!canProviderActionContext(actor, permission)) {
    const message =
      actor.authType === "api_key" && !canProviderAccess(actor.role, permission)
        ? "Insufficient role permission"
        : actor.authType === "api_key"
          ? "API-key sessions cannot perform this action; use a JWT session with MFA"
          : "Insufficient role permission";
    reply.status(403).send({ error: "Forbidden", message });
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

function getTransactionPayokEnvironment(metadata: string | null): PayokEnvironment {
  const fallback = getDefaultPayokEnvironment();
  if (!metadata) return fallback;
  try {
    const parsed = JSON.parse(metadata) as { environment?: string };
    return parsed.environment === "test" || parsed.environment === "live" ? parsed.environment : fallback;
  } catch {
    return fallback;
  }
}

function parseTransactionMetadata(metadata: string | null): Record<string, unknown> | null {
  if (!metadata?.trim()) return null;
  try {
    return JSON.parse(metadata) as Record<string, unknown>;
  } catch {
    return { rawMetadata: metadata };
  }
}

function isReviewRequired(metadata: string | null): boolean {
  const meta = parseTransactionMetadata(metadata);
  return meta?.reviewRequired === true;
}

export async function registerProviderRoutes(app: FastifyInstance) {
  await registerProviderMerchantRiskRoutes(app);
  await registerProviderMerchantOpsRoutes(app);
  await registerProviderAdminConfigRoutes(app);
  app.get(
    "/provider/me",
    {
      schema: {
        response: {
          200: z.object({
            role: z.enum(PROVIDER_ROLES),
            authType: z.enum(["api_key", "jwt"]),
            email: z.string().nullable(),
            mfaEnabled: z.boolean().optional(),
            mfaPendingSetup: z.boolean().optional(),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!request.provider) return reply.status(401).send({ error: "Unauthorized" });
      const base = {
        role: request.provider.role,
        authType: request.provider.authType,
        email: request.provider.email ?? null,
      };
      if (request.provider.authType === "jwt" && request.provider.providerUserId) {
        const [row] = await db
          .select({
            mfaEnabled: providerUsers.mfaEnabled,
            mfaPending: providerUsers.mfaPending,
          })
          .from(providerUsers)
          .where(eq(providerUsers.id, request.provider.providerUserId))
          .limit(1);
        if (row) {
          return {
            ...base,
            mfaEnabled: row.mfaEnabled,
            mfaPendingSetup: row.mfaPending && !row.mfaEnabled,
          };
        }
      }
      return base;
    }
  );

  const treasuryVolumeItemSchema = z.object({
    key: z.string(),
    payin: z.string(),
    payout: z.string(),
    total: z.string(),
  });

  app.get(
    "/provider/treasury/overview",
    {
      schema: {
        querystring: z.object({
          environment: z.enum(["test", "live"]).default("test"),
          /** ISO datetimes; default window is the last 30 days. */
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
        }),
        response: {
          200: z.object({
            environment: z.enum(["test", "live"]),
            from: z.string(),
            to: z.string(),
            platformBalances: z.array(z.object({ currency: z.string(), balance: z.string() })),
            revenue: z.object({
              byCurrency: z.array(
                z.object({
                  currency: z.string(),
                  platformFee: z.string(),
                  monthlyFee: z.string(),
                  total: z.string(),
                })
              ),
            }),
            volume: z.object({
              byCurrency: z.array(treasuryVolumeItemSchema),
              byRail: z.array(treasuryVolumeItemSchema),
            }),
            takeRate: z.array(
              z.object({
                currency: z.string(),
                revenue: z.string(),
                volume: z.string(),
                takeRateBps: z.number().nullable(),
              })
            ),
            liquidity: z.object({
              pendingPayinByCurrency: z.array(
                z.object({ currency: z.string(), amount: z.string(), count: z.number() })
              ),
              pendingPayoutByCurrency: z.array(
                z.object({ currency: z.string(), amount: z.string(), count: z.number() })
              ),
              merchantBalancesByCurrency: z.array(
                z.object({ currency: z.string(), amount: z.string(), count: z.number() })
              ),
              note: z.string(),
            }),
            disclosures: z.object({
              basis: z.literal("gross"),
              netMarginAvailable: z.boolean(),
              providerCostTracked: z.boolean(),
              fxSpreadLedgered: z.boolean(),
              note: z.string(),
            }),
          }),
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!request.provider) return reply.status(401).send({ error: "Unauthorized" });
      if (!ensureProviderPermission(request, reply, "treasury.read")) return;
      const { environment, from, to } = request.query as {
        environment: "test" | "live";
        from?: string;
        to?: string;
      };
      const toDate = to ? new Date(to) : new Date();
      const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);
      if (fromDate.getTime() > toDate.getTime()) {
        return reply.status(400).send({ error: "Bad Request", message: "`from` must be before `to`" });
      }
      const overview = await buildTreasuryOverview({ environment, from: fromDate, to: toDate });
      return overview;
    }
  );

  app.get(
    "/provider/dashboard",
    {
      schema: {
        response: {
          200: z.object({
            kpis: z.object({
              merchants: z.object({
                total: z.number(),
                active: z.number(),
                pending: z.number(),
                suspended: z.number(),
              }),
              kycPending: z.number(),
              marketKybPending: z.number(),
              reconcileOpen: z.number(),
              approvalsPending: z.number(),
              transactions: z.object({
                pending: z.number(),
                failed: z.number(),
                reviewRequired: z.number(),
              }),
            }),
            recentIssues: z.array(
              z.object({
                transactionId: z.string(),
                merchantId: z.string(),
                merchantName: z.string(),
                type: z.string(),
                status: z.string(),
                createdAt: z.string(),
              })
            ),
            myActions: z.object({
              merchant: z.array(z.string()),
              customer: z.array(z.string()),
            }),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!request.provider) return reply.status(401).send({ error: "Unauthorized" });
      if (!ensureProviderPermission(request, reply, "merchant.read")) return;
      const actor = request.provider;

      const [merchantsTotal, merchantsActive, merchantsPending, merchantsSuspended, kycPending] = await Promise.all([
        db.select({ count: count() }).from(merchants),
        db.select({ count: count() }).from(merchants).where(eq(merchants.status, "active")),
        db.select({ count: count() }).from(merchants).where(eq(merchants.status, "pending")),
        db.select({ count: count() }).from(merchants).where(eq(merchants.status, "suspended")),
        db.select({ count: count() }).from(merchants).where(eq(merchants.kycStatus, "pending")),
      ]);
      const {
        countMarketKybPendingMerchants,
        countReconcileQueueOpen,
      } = await import("../../src/lib/provider-ops-queues.js");
      const [marketKybPending, reconcileOpen] = await Promise.all([
        countMarketKybPendingMerchants(),
        countReconcileQueueOpen(),
      ]);
      const [approvalsPending] = await db
        .select({ count: count() })
        .from(providerActionRequests)
        .where(eq(providerActionRequests.status, "pending"));

      const [txPending, txFailed, txReviewRequired] = await Promise.all([
        db.select({ count: count() }).from(transactions).where(eq(transactions.status, "pending")),
        db.select({ count: count() }).from(transactions).where(eq(transactions.status, "failed")),
        db
          .select({ count: count() })
          .from(transactions)
          .where(and(eq(transactions.status, "pending"), ilike(transactions.metadata, '%"reviewRequired":true%'))),
      ]);

      const issueRows = await db
        .select({
          id: transactions.id,
          merchantId: transactions.merchantId,
          merchantName: merchants.name,
          status: transactions.status,
          createdAt: transactions.createdAt,
          metadata: transactions.metadata,
        })
        .from(transactions)
        .innerJoin(merchants, eq(transactions.merchantId, merchants.id))
        .where(
          and(
            eq(transactions.status, "pending"),
            ilike(transactions.metadata, '%"reviewRequired":true%')
          )
        )
        .orderBy(desc(transactions.createdAt))
        .limit(10);

      const role = actor.role;
      const myActions = {
        merchant: [
          canProviderAccess(role, "merchant.status.write") ? "status_change" : null,
          canProviderAccess(role, "merchant.kyc.write") ? "kyc_review" : null,
          canProviderAccess(role, "merchant.pricing.write") ? "pricing_update" : null,
          canProviderAccess(role, "wallet.adjust") ? "wallet_adjustment" : null,
          canProviderAccess(role, "tx.reconcile") ? "tx_reconcile" : null,
          canProviderAccess(role, "tx.status.write") ? "tx_status_change" : null,
        ].filter((v): v is string => Boolean(v)),
        customer: [
          canProviderAccess(role, "customer.status.write") ? "status_change" : null,
          canProviderAccess(role, "customer.read") ? "view_wallet_and_timeline" : null,
        ].filter((v): v is string => Boolean(v)),
      };

      return {
        kpis: {
          merchants: {
            total: Number(merchantsTotal?.[0]?.count ?? 0),
            active: Number(merchantsActive?.[0]?.count ?? 0),
            pending: Number(merchantsPending?.[0]?.count ?? 0),
            suspended: Number(merchantsSuspended?.[0]?.count ?? 0),
          },
          kycPending: Number(kycPending?.[0]?.count ?? 0),
          marketKybPending,
          reconcileOpen,
          approvalsPending: Number(approvalsPending?.count ?? 0),
          transactions: {
            pending: Number(txPending?.[0]?.count ?? 0),
            failed: Number(txFailed?.[0]?.count ?? 0),
            reviewRequired: Number(txReviewRequired?.[0]?.count ?? 0),
          },
        },
        recentIssues: issueRows.map((r) => ({
          transactionId: r.id,
          merchantId: r.merchantId,
          merchantName: r.merchantName,
          type: "review_required",
          status: r.status,
          createdAt: r.createdAt.toISOString(),
        })),
        myActions,
      };
    }
  );

  const reconcileActionSchema = z
    .object({
      method: z.enum(["GET", "POST"]),
      path: z.string(),
      body: z.record(z.string()).optional(),
    })
    .nullable();

  app.get(
    "/provider/kyc-queue",
    {
      schema: {
        querystring: z.object({
          reason: z.enum(["global", "market", "all"]).default("all"),
          market: z.enum(["bangladesh", "india", "europe", "brazil", "pyusd"]).optional(),
          limit: z.coerce.number().min(1).max(100).default(20),
          offset: z.coerce.number().min(0).default(0),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                merchantId: z.string(),
                slug: z.string(),
                name: z.string(),
                status: z.string(),
                globalKycStatus: z.string(),
                queueReasons: z.array(
                  z.enum(["global_kyc_pending", "market_requested", "market_kyb_in_review"])
                ),
                marketsNeedingReview: z.array(
                  z.object({
                    market: z.string(),
                    displayName: z.string(),
                    entitlementStatus: z.string(),
                    kybStatus: z.string(),
                    requestedAt: z.string().nullable(),
                  })
                ),
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
      const q = request.query as {
        reason: "global" | "market" | "all";
        market?: "bangladesh" | "india" | "europe" | "brazil" | "pyusd";
        limit: number;
        offset: number;
      };
      const { buildKycQueue } = await import("../../src/lib/provider-ops-queues.js");
      const result = await buildKycQueue(q);
      return { ...result, limit: q.limit, offset: q.offset };
    }
  );

  app.get(
    "/provider/reconcile/queue",
    {
      schema: {
        querystring: z.object({
          environment: z.enum(["test", "live"]).optional(),
          rail: z.enum(["bangladesh", "brazil", "india", "europe", "pyusd", "internal", "unknown"]).optional(),
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
                currency: z.string(),
                environment: z.string(),
                provider: z.string().nullable(),
                platformOrderId: z.string().nullable(),
                reviewRequired: z.boolean(),
                reconcileStatus: z.enum(["open", "settled", "failed", "review_required"]),
                rail: z.string(),
                railLabel: z.string(),
                ageSeconds: z.number(),
                reconcileAction: reconcileActionSchema,
                inspectAction: reconcileActionSchema,
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
      const q = request.query as {
        environment?: "test" | "live";
        rail?: "bangladesh" | "brazil" | "india" | "europe" | "pyusd" | "internal" | "unknown";
        limit: number;
        offset: number;
      };
      const { buildReconcileQueue } = await import("../../src/lib/provider-ops-queues.js");
      const result = await buildReconcileQueue(q);
      return { ...result, limit: q.limit, offset: q.offset };
    }
  );

  app.get(
    "/provider/merchants/:merchantId/overview",
    {
      schema: {
        params: z.object({ merchantId: merchantRefParamSchema }),
        querystring: z.object({
          txLimit: z.coerce.number().min(1).max(100).default(20),
          customerLimit: z.coerce.number().min(1).max(100).default(20),
        }),
        response: {
          200: z.object({
            merchant: merchantIdentitySchema,
            wallets: z.array(
              z.object({
                id: z.string(),
                environment: z.string(),
                currency: z.string(),
                balance: z.string(),
                status: z.string(),
              })
            ),
            kyc: z.object({
              profile: z
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
            customers: z.object({
              total: z.number(),
              active: z.number(),
              frozen: z.number(),
              pending: z.number(),
              closed: z.number(),
              recent: z.array(
                z.object({
                  walletId: z.string(),
                  label: z.string().nullable(),
                  balance: z.string(),
                  status: z.string(),
                  createdAt: z.string(),
                })
              ),
            }),
            transactions: z.object({
              total: z.number(),
              pending: z.number(),
              success: z.number(),
              failed: z.number(),
              reviewRequired: z.number(),
              recent: z.array(
                z.object({
                  id: z.string(),
                  type: z.string(),
                  status: z.string(),
                  amount: z.string(),
                  paidAmount: z.string().nullable(),
                  currency: z.string(),
                  createdAt: z.string(),
                })
              ),
            }),
            approvals: z.object({
              pendingCount: z.number(),
              recent: z.array(
                z.object({
                  id: z.string(),
                  actionType: z.string(),
                  status: z.string(),
                  riskLevel: z.string(),
                  createdAt: z.string(),
                })
              ),
            }),
            auditTrail: z.array(
              z.object({
                id: z.string(),
                action: z.string(),
                resource: z.string().nullable(),
                createdAt: z.string(),
              })
            ),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "merchant.read")) return;
      const { merchantId: merchantRef } = request.params as { merchantId: string };
      const { txLimit, customerLimit } = request.query as { txLimit: number; customerLimit: number };

      const resolved = await resolveMerchantParam(merchantRef, reply);
      if (!resolved) return;
      const { merchantId, merchant } = resolved;

      const [profile, personsCount, documentsCount, customerTotal, customerActive, customerFrozen, customerPending, customerClosed] =
        await Promise.all([
          db.select().from(merchantBusinessProfiles).where(eq(merchantBusinessProfiles.merchantId, merchantId)).limit(1),
          db.select({ count: count() }).from(merchantPersons).where(eq(merchantPersons.merchantId, merchantId)),
          db.select({ count: count() }).from(merchantKycDocuments).where(eq(merchantKycDocuments.merchantId, merchantId)),
          db.select({ count: count() }).from(wallets).where(and(eq(wallets.merchantId, merchantId), eq(wallets.type, "customer"))),
          db
            .select({ count: count() })
            .from(wallets)
            .where(and(eq(wallets.merchantId, merchantId), eq(wallets.type, "customer"), eq(wallets.status, "active"))),
          db
            .select({ count: count() })
            .from(wallets)
            .where(and(eq(wallets.merchantId, merchantId), eq(wallets.type, "customer"), eq(wallets.status, "frozen"))),
          db
            .select({ count: count() })
            .from(wallets)
            .where(and(eq(wallets.merchantId, merchantId), eq(wallets.type, "customer"), eq(wallets.status, "pending"))),
          db
            .select({ count: count() })
            .from(wallets)
            .where(and(eq(wallets.merchantId, merchantId), eq(wallets.type, "customer"), eq(wallets.status, "closed"))),
        ]);

      const [walletRows, customerRows, txTotal, txPending, txSuccess, txFailed, txReviewRequired, txRows, approvalsPending, approvalRows, auditRows] =
        await Promise.all([
          db
            .select({
              id: wallets.id,
              environment: wallets.environment,
              currency: wallets.currency,
              balance: wallets.balance,
              status: wallets.status,
            })
            .from(wallets)
            .where(and(eq(wallets.merchantId, merchantId), eq(wallets.type, "merchant")))
            .orderBy(desc(wallets.createdAt)),
          db
            .select({
              walletId: wallets.id,
              label: wallets.label,
              balance: wallets.balance,
              status: wallets.status,
              createdAt: wallets.createdAt,
            })
            .from(wallets)
            .where(and(eq(wallets.merchantId, merchantId), eq(wallets.type, "customer")))
            .orderBy(desc(wallets.createdAt))
            .limit(customerLimit),
          db.select({ count: count() }).from(transactions).where(eq(transactions.merchantId, merchantId)),
          db
            .select({ count: count() })
            .from(transactions)
            .where(and(eq(transactions.merchantId, merchantId), eq(transactions.status, "pending"))),
          db
            .select({ count: count() })
            .from(transactions)
            .where(and(eq(transactions.merchantId, merchantId), eq(transactions.status, "success"))),
          db
            .select({ count: count() })
            .from(transactions)
            .where(and(eq(transactions.merchantId, merchantId), eq(transactions.status, "failed"))),
          db
            .select({ count: count() })
            .from(transactions)
            .where(
              and(
                eq(transactions.merchantId, merchantId),
                eq(transactions.status, "pending"),
                ilike(transactions.metadata, '%"reviewRequired":true%')
              )
            ),
          db
            .select({
              id: transactions.id,
              type: transactions.type,
              status: transactions.status,
              amount: transactions.amount,
              paidAmount: transactions.paidAmount,
              currency: transactions.currency,
              createdAt: transactions.createdAt,
            })
            .from(transactions)
            .where(eq(transactions.merchantId, merchantId))
            .orderBy(desc(transactions.createdAt))
            .limit(txLimit),
          db
            .select({ count: count() })
            .from(providerActionRequests)
            .where(and(eq(providerActionRequests.status, "pending"), eq(providerActionRequests.resourceId, merchantId))),
          db
            .select({
              id: providerActionRequests.id,
              actionType: providerActionRequests.actionType,
              status: providerActionRequests.status,
              riskLevel: providerActionRequests.riskLevel,
              createdAt: providerActionRequests.createdAt,
            })
            .from(providerActionRequests)
            .where(eq(providerActionRequests.resourceId, merchantId))
            .orderBy(desc(providerActionRequests.createdAt))
            .limit(10),
          db
            .select({
              id: merchantAuditLog.id,
              action: merchantAuditLog.action,
              resource: merchantAuditLog.resource,
              createdAt: merchantAuditLog.createdAt,
            })
            .from(merchantAuditLog)
            .where(eq(merchantAuditLog.merchantId, merchantId))
            .orderBy(desc(merchantAuditLog.createdAt))
            .limit(20),
        ]);

      const profileRow = profile[0] ?? null;
      const merchantIdentity = await buildMerchantIdentity(merchant);
      return {
        merchant: merchantIdentity,
        wallets: walletRows.map((w) => ({
          id: w.id,
          environment: w.environment,
          currency: w.currency,
          balance: String(w.balance),
          status: w.status,
        })),
        kyc: {
          profile: profileRow
            ? {
                id: profileRow.id,
                legalName: profileRow.legalName,
                businessType: profileRow.businessType,
                status: profileRow.status,
                rejectionReason: profileRow.rejectionReason,
              }
            : null,
          personsCount: Number(personsCount?.[0]?.count ?? 0),
          documentsCount: Number(documentsCount?.[0]?.count ?? 0),
        },
        customers: {
          total: Number(customerTotal?.[0]?.count ?? 0),
          active: Number(customerActive?.[0]?.count ?? 0),
          frozen: Number(customerFrozen?.[0]?.count ?? 0),
          pending: Number(customerPending?.[0]?.count ?? 0),
          closed: Number(customerClosed?.[0]?.count ?? 0),
          recent: customerRows.map((c) => ({
            walletId: c.walletId,
            label: c.label,
            balance: String(c.balance),
            status: c.status,
            createdAt: c.createdAt.toISOString(),
          })),
        },
        transactions: {
          total: Number(txTotal?.[0]?.count ?? 0),
          pending: Number(txPending?.[0]?.count ?? 0),
          success: Number(txSuccess?.[0]?.count ?? 0),
          failed: Number(txFailed?.[0]?.count ?? 0),
          reviewRequired: Number(txReviewRequired?.[0]?.count ?? 0),
          recent: txRows.map((t) => ({
            id: t.id,
            type: t.type,
            status: t.status,
            amount: String(t.amount),
            paidAmount: t.paidAmount ? String(t.paidAmount) : null,
            currency: t.currency,
            createdAt: t.createdAt.toISOString(),
          })),
        },
        approvals: {
          pendingCount: Number(approvalsPending?.[0]?.count ?? 0),
          recent: approvalRows.map((a) => ({
            id: a.id,
            actionType: a.actionType,
            status: a.status,
            riskLevel: a.riskLevel,
            createdAt: a.createdAt.toISOString(),
          })),
        },
        auditTrail: auditRows.map((a) => ({
          id: a.id,
          action: a.action,
          resource: a.resource ?? null,
          createdAt: a.createdAt.toISOString(),
        })),
      };
    }
  );

  app.get(
    "/provider/merchants/:merchantId/customers/:walletId/overview",
    {
      schema: {
        params: z.object({ merchantId: merchantRefParamSchema, walletId: z.string().uuid() }),
        response: {
          200: z.object({
            customer: z.object({
              walletId: z.string(),
              merchantId: z.string(),
              merchantName: z.string(),
              label: z.string().nullable(),
              environment: z.string(),
              currency: z.string(),
              balance: z.string(),
              status: z.string(),
              createdAt: z.string(),
            }),
            ledger: z.array(
              z.object({
                id: z.string(),
                direction: z.string(),
                type: z.string(),
                amount: z.string(),
                referenceId: z.string().nullable(),
                createdAt: z.string(),
              })
            ),
            transactions: z.array(
              z.object({
                id: z.string(),
                type: z.string(),
                status: z.string(),
                amount: z.string(),
                paidAmount: z.string().nullable(),
                currency: z.string(),
                settlementCurrency: z.string(),
                rail: z.string(),
                railLabel: z.string(),
                platformOrderId: z.string().nullable(),
                customerWalletId: z.string().nullable(),
                createdAt: z.string(),
                completedAt: z.string().nullable(),
              })
            ),
            txSummary: z.object({
              total: z.number(),
              pending: z.number(),
              success: z.number(),
              failed: z.number(),
            }),
            actions: z.array(z.string()),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "customer.read")) return;
      const { merchantId: merchantRef, walletId } = request.params as { merchantId: string; walletId: string };
      const resolved = await resolveMerchantParam(merchantRef, reply);
      if (!resolved) return;
      const { merchantId } = resolved;

      const [row] = await db
        .select({
          walletId: wallets.id,
          merchantId: wallets.merchantId,
          merchantName: merchants.name,
          label: wallets.label,
          environment: wallets.environment,
          currency: wallets.currency,
          balance: wallets.balance,
          status: wallets.status,
          createdAt: wallets.createdAt,
        })
        .from(wallets)
        .innerJoin(merchants, eq(wallets.merchantId, merchants.id))
        .where(and(eq(wallets.id, walletId), eq(wallets.merchantId, merchantId), eq(wallets.type, "customer")))
        .limit(1);

      if (!row) {
        return reply.status(404).send({ error: "Not found", message: "Customer wallet not found for merchant" });
      }

      const [ledgerRows, txRows] = await Promise.all([
        db
          .select({
            id: ledgerEntries.id,
            direction: ledgerEntries.direction,
            type: ledgerEntries.type,
            amount: ledgerEntries.amount,
            referenceId: ledgerEntries.referenceId,
            createdAt: ledgerEntries.createdAt,
          })
          .from(ledgerEntries)
          .where(eq(ledgerEntries.walletId, walletId))
          .orderBy(desc(ledgerEntries.createdAt))
          .limit(50),
        db
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
          .where(eq(transactions.walletId, walletId))
          .orderBy(desc(transactions.createdAt))
          .limit(50),
      ]);

      const { presentTransactionListItems } = await import("../../src/lib/present-transaction.js");
      const presentedTxs = await presentTransactionListItems({
        merchantId,
        environment: row.environment as "test" | "live",
        rows: txRows,
      });
      const [txCounts] = await db
        .select({
          total: count(),
          pending: sql<number>`count(*) filter (where ${transactions.status} = 'pending')`,
          success: sql<number>`count(*) filter (where ${transactions.status} = 'success')`,
          failed: sql<number>`count(*) filter (where ${transactions.status} = 'failed')`,
        })
        .from(transactions)
        .where(eq(transactions.walletId, walletId));
      const txSummary = {
        total: Number(txCounts?.total ?? 0),
        pending: Number(txCounts?.pending ?? 0),
        success: Number(txCounts?.success ?? 0),
        failed: Number(txCounts?.failed ?? 0),
      };

      const actor = request.provider!;
      const actions = [
        canProviderAccess(actor.role, "wallet.adjust") ? "wallet_adjustment" : null,
        canProviderAccess(actor.role, "customer.status.write") ? "change_status" : null,
        canProviderAccess(actor.role, "tx.read") ? "review_transactions" : null,
        canProviderAccess(actor.role, "tx.reconcile") ? "request_reconcile" : null,
      ].filter((v): v is string => Boolean(v));

      return {
        customer: {
          walletId: row.walletId,
          merchantId: row.merchantId,
          merchantName: row.merchantName,
          label: row.label,
          environment: row.environment,
          currency: row.currency,
          balance: String(row.balance),
          status: row.status,
          createdAt: row.createdAt.toISOString(),
        },
        ledger: ledgerRows.map((l) => ({
          id: l.id,
          direction: l.direction,
          type: l.type,
          amount: String(l.amount),
          referenceId: l.referenceId ?? null,
          createdAt: l.createdAt.toISOString(),
        })),
        transactions: presentedTxs,
        txSummary,
        actions,
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
          /** When set, balance is taken only from this environment; otherwise live wallet is preferred over test. */
          environment: z.enum(["test", "live"]).optional(),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                slug: z.string(),
                businessName: z.string(),
                name: z.string(),
                status: z.string(),
                kycStatus: z.string(),
                merchantBalance: z.string().nullable(),
                merchantBalanceCurrency: z.string().nullable(),
                merchantBalanceEnvironment: z.enum(["test", "live"]).nullable(),
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
      const { limit, offset, status, kycStatus, q, environment } = request.query as {
        limit: number;
        offset: number;
        status?: (typeof MERCHANT_STATUS)[number];
        kycStatus?: (typeof KYC_STATUS)[number];
        q?: string;
        environment?: "test" | "live";
      };

      const conditions = [];
      if (status) conditions.push(eq(merchants.status, status));
      if (kycStatus) conditions.push(eq(merchants.kycStatus, kycStatus));
      if (q) {
        const safeQ = sanitizeIlikeSearchQuery(q);
        if (safeQ) {
          const slugQ = safeQ.toLowerCase().replace(/\s+/g, "-");
          const nameCond = ilike(merchants.name, `%${safeQ}%`);
          const slugCond = ilike(merchants.slug, `%${slugQ}%`);
          if (isMerchantUuid(q.trim())) {
            conditions.push(or(nameCond, slugCond, eq(merchants.id, q.trim()))!);
          } else {
            conditions.push(or(nameCond, slugCond)!);
          }
        }
      }

      const [totalResult] = await db
        .select({ count: count() })
        .from(merchants)
        .where(conditions.length ? and(...conditions) : undefined);

      const rows = await db
        .select({
          id: merchants.id,
          slug: merchants.slug,
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
              environment: wallets.environment,
              currency: wallets.currency,
              balance: wallets.balance,
            })
            .from(wallets)
            .where(and(eq(wallets.type, "merchant"), inArray(wallets.merchantId, merchantIds)))
        : [];
      const balanceMap = primaryMerchantBalanceByMerchantId(walletRows, merchantIds, environment);

      const { ensureMerchantSlug } = await import("../../src/lib/merchant-slug.js");

      return {
        items: await Promise.all(
          rows.map(async (r) => {
            const slug = r.slug ?? (await ensureMerchantSlug(r.id, r.name));
            const primaryBalance = balanceMap.get(r.id);
            return {
              id: r.id,
              slug,
              businessName: r.name,
              name: r.name,
              status: r.status,
              kycStatus: r.kycStatus ?? "pending",
              merchantBalance: primaryBalance?.balance ?? null,
              merchantBalanceCurrency: primaryBalance?.currency ?? null,
              merchantBalanceEnvironment: primaryBalance?.environment ?? null,
              createdAt: r.createdAt.toISOString(),
            };
          })
        ),
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
        params: z.object({ merchantId: merchantRefParamSchema }),
        response: {
          200: z.object({
            id: z.string(),
            slug: z.string(),
            businessName: z.string(),
            name: z.string(),
            status: z.string(),
            kycStatus: z.string(),
            merchantWallet: z
              .object({
                id: z.string(),
                balance: z.string(),
                currency: z.string(),
                environment: z.enum(["test", "live"]),
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
      const { merchantId: merchantRef } = request.params as { merchantId: string };

      const resolved = await resolveMerchantParam(merchantRef, reply);
      if (!resolved) return;
      const { merchantId, merchant } = resolved;

      const merchantWalletRows = await db
        .select()
        .from(wallets)
        .where(and(eq(wallets.merchantId, merchantId), eq(wallets.type, "merchant")));

      const primaryWallet = pickPrimaryMerchantWallet(merchantWalletRows);
      const merchantWallet = primaryWallet
        ? {
            id: primaryWallet.id,
            balance: String(primaryWallet.balance),
            currency: primaryWallet.currency,
            environment: primaryWallet.environment,
            status: primaryWallet.status,
          }
        : null;

      const [[profile], [personsCount], [documentsCount]] = await Promise.all([
        db
          .select()
          .from(merchantBusinessProfiles)
          .where(eq(merchantBusinessProfiles.merchantId, merchantId))
          .limit(1),
        db
          .select({ count: count() })
          .from(merchantPersons)
          .where(eq(merchantPersons.merchantId, merchantId)),
        db
          .select({ count: count() })
          .from(merchantKycDocuments)
          .where(eq(merchantKycDocuments.merchantId, merchantId)),
      ]);

      const identity = await buildMerchantIdentity(merchant);
      return {
        ...identity,
        merchantWallet: merchantWallet
          ? {
              id: merchantWallet.id,
              balance: merchantWallet.balance,
              currency: merchantWallet.currency,
              environment: merchantWallet.environment,
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
        params: z.object({ merchantId: merchantRefParamSchema }),
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
      const { merchantId: merchantRef } = request.params as { merchantId: string };
      const { status, reason } = request.body as { status: (typeof MERCHANT_STATUS)[number]; reason?: string };

      const resolved = await resolveMerchantParam(merchantRef, reply);
      if (!resolved) return;
      const { merchantId, merchant: existing } = resolved;

      if (existing.status === status) {
        return { id: merchantId, status };
      }

      await db
        .update(merchants)
        .set({ status, updatedAt: new Date() })
        .where(eq(merchants.id, merchantId));

      providerMerchantAudit(request, {
        action: "provider.merchant.status_changed",
        merchantId,
        meta: { from: existing.status, to: status, reason: reason ?? null },
      });

      return { id: merchantId, status };
    }
  );

  app.patch(
    "/provider/merchants/:merchantId/kyc",
    {
      schema: {
        params: z.object({ merchantId: merchantRefParamSchema }),
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
      const { merchantId: merchantRef } = request.params as { merchantId: string };
      const { kycStatus, reason } = request.body as { kycStatus: (typeof KYC_STATUS)[number]; reason?: string };

      const resolved = await resolveMerchantParam(merchantRef, reply);
      if (!resolved) return;
      const { merchantId, merchant: existing } = resolved;

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

      providerMerchantAudit(request, {
        action: "provider.merchant.kyc_changed",
        merchantId,
        meta: { from: existing.kycStatus ?? "pending", to: kycStatus, reason: reason ?? null },
      });

      return { id: merchantId, kycStatus };
    }
  );

  const MARKET_IDS = ["bangladesh", "india", "europe", "brazil", "pyusd"] as const;
  const MARKET_ENTITLEMENT = [
    "disabled",
    "requested",
    "kyb_in_review",
    "approved",
    "suspended",
  ] as const;
  const MARKET_KYB = ["not_started", "pending", "verified", "rejected"] as const;
  const MARKET_ACTIVATION = ["active", "not_enabled", "pending_kyb", "suspended"] as const;
  const MARKET_BLOCKERS = [
    "not_requested",
    "awaiting_review",
    "kyb_pending",
    "kyb_rejected",
    "global_kyc_pending",
    "suspended",
    "wallet_not_provisioned",
  ] as const;

  const providerMarketRowSchema = z.object({
    market: z.enum(MARKET_IDS),
    displayName: z.string(),
    entitlementStatus: z.enum(MARKET_ENTITLEMENT),
    kybStatus: z.enum(MARKET_KYB),
    activationStatus: z.enum(MARKET_ACTIVATION),
    canRequest: z.boolean(),
    ready: z.boolean(),
    unlockReason: z.string().nullable(),
    blockers: z.array(
      z.object({
        code: z.enum(MARKET_BLOCKERS),
        message: z.string(),
      })
    ),
    walletsProvisioned: z.boolean(),
    requestedAt: z.string().nullable(),
    approvedAt: z.string().nullable(),
    settlementCurrencies: z.array(z.string()),
  });

  function serializeProviderMarketRow(r: {
    market: (typeof MARKET_IDS)[number];
    displayName: string;
    entitlementStatus: (typeof MARKET_ENTITLEMENT)[number];
    kybStatus: (typeof MARKET_KYB)[number];
    activationStatus: (typeof MARKET_ACTIVATION)[number];
    canRequest: boolean;
    ready: boolean;
    unlockReason: string | null;
    blockers: Array<{ code: (typeof MARKET_BLOCKERS)[number]; message: string }>;
    walletsProvisioned: boolean;
    requestedAt: Date | null;
    approvedAt: Date | null;
    settlementCurrencies: string[];
  }) {
    return {
      market: r.market,
      displayName: r.displayName,
      entitlementStatus: r.entitlementStatus,
      kybStatus: r.kybStatus,
      activationStatus: r.activationStatus,
      canRequest: r.canRequest,
      ready: r.ready,
      unlockReason: r.unlockReason,
      blockers: r.blockers,
      walletsProvisioned: r.walletsProvisioned,
      requestedAt: r.requestedAt?.toISOString() ?? null,
      approvedAt: r.approvedAt?.toISOString() ?? null,
      settlementCurrencies: r.settlementCurrencies,
    };
  }

  app.get(
    "/provider/merchants/:merchantId/markets",
    {
      schema: {
        params: z.object({ merchantId: merchantRefParamSchema }),
        querystring: z.object({
          environment: z.enum(["test", "live"]).default("live"),
        }),
        response: {
          200: z.object({
            globalKycStatus: z.string(),
            items: z.array(providerMarketRowSchema),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "merchant.read")) return;
      const { merchantId: merchantRef } = request.params as { merchantId: string };
      const { environment } = request.query as { environment: "test" | "live" };

      const resolved = await resolveMerchantParam(merchantRef, reply);
      if (!resolved) return;
      const { merchantId } = resolved;

      const { buildMerchantMarketBoard } = await import("../../src/lib/merchant-markets.js");
      const board = await buildMerchantMarketBoard({ merchantId, environment });
      return {
        globalKycStatus: board.globalKycStatus,
        items: board.items.map(serializeProviderMarketRow),
      };
    }
  );

  app.get(
    "/provider/merchants/:merchantId/services",
    {
      schema: {
        params: z.object({ merchantId: merchantRefParamSchema }),
        querystring: z.object({
          environment: z.enum(["test", "live"]).default("live"),
        }),
        response: {
          200: z.object({
            environment: z.enum(["test", "live"]),
            globalKycStatus: z.string(),
            markets: z.array(providerMarketRowSchema),
            wallets: z.array(
              z.object({
                id: z.string(),
                currency: z.string(),
                balance: z.string(),
                availableBalance: z.string(),
                pendingBalance: z.string(),
                status: z.string(),
                displayLabel: z.string(),
                market: z.enum(MARKET_IDS),
                entitlementStatus: z.string(),
                kybStatus: z.string(),
                activationStatus: z.enum(MARKET_ACTIVATION),
                walletActivated: z.boolean(),
                unlockReason: z.string().nullable(),
                blockers: z.array(
                  z.object({
                    code: z.string(),
                    message: z.string(),
                  })
                ),
              })
            ),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "merchant.read")) return;
      const { merchantId: merchantRef } = request.params as { merchantId: string };
      const { environment } = request.query as { environment: "test" | "live" };

      const resolved = await resolveMerchantParam(merchantRef, reply);
      if (!resolved) return;
      const { merchantId } = resolved;

      const { buildMerchantServicesBoard } = await import("../../src/lib/merchant-markets.js");
      const { sumPendingPayinAmountsByCurrency } = await import(
        "../../src/lib/merchant-pending-balance.js"
      );
      const pendingByCurrency = await sumPendingPayinAmountsByCurrency({
        merchantId,
        environment,
      });
      const board = await buildMerchantServicesBoard({
        merchantId,
        environment,
        pendingByCurrency,
      });
      return {
        environment: board.environment,
        globalKycStatus: board.globalKycStatus,
        markets: board.markets.map(serializeProviderMarketRow),
        wallets: board.wallets.map((w) => ({
          id: w.id,
          currency: w.currency,
          balance: w.balance,
          availableBalance: w.availableBalance,
          pendingBalance: w.pendingBalance,
          status: w.status,
          displayLabel: w.displayLabel,
          market: w.market,
          entitlementStatus: w.entitlementStatus,
          kybStatus: w.kybStatus,
          activationStatus: w.activationStatus,
          walletActivated: w.walletActivated,
          unlockReason: w.unlockReason,
          blockers: w.blockers,
        })),
      };
    }
  );

  app.patch(
    "/provider/merchants/:merchantId/markets/:market",
    {
      schema: {
        params: z.object({
          merchantId: merchantRefParamSchema,
          market: z.enum(MARKET_IDS),
        }),
        body: z.object({
          entitlementStatus: z.enum(MARKET_ENTITLEMENT).optional(),
          kybStatus: z.enum(MARKET_KYB).optional(),
          reason: z.string().max(500).optional(),
        }),
        response: {
          200: providerMarketRowSchema,
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "merchant.kyc.write")) return;
      const { merchantId: merchantRef, market } = request.params as {
        merchantId: string;
        market: (typeof MARKET_IDS)[number];
      };
      const body = request.body as {
        entitlementStatus?: (typeof MARKET_ENTITLEMENT)[number];
        kybStatus?: (typeof MARKET_KYB)[number];
        reason?: string;
      };

      const resolved = await resolveMerchantParam(merchantRef, reply);
      if (!resolved) return;
      const { merchantId } = resolved;

      const { setMerchantMarketByProvider, buildMerchantMarketBoard } = await import(
        "../../src/lib/merchant-markets.js"
      );
      await setMerchantMarketByProvider({
        merchantId,
        market,
        entitlementStatus: body.entitlementStatus,
        kybStatus: body.kybStatus,
        actor: body.reason ? `provider:${body.reason}` : "provider",
      });

      const board = await buildMerchantMarketBoard({ merchantId, environment: "live" });
      const row = board.items.find((r) => r.market === market)!;
      return serializeProviderMarketRow(row);
    }
  );

  const BILLING_MODE = ["percentage_only", "monthly_only", "both"] as const;

  app.get(
    "/provider/merchants/:merchantId/pricing",
    {
      schema: {
        params: z.object({ merchantId: merchantRefParamSchema }),
        response: {
          200: z.object({
            billingMode: z.enum(BILLING_MODE),
            feePercentagePayin: z.string().nullable(),
            feePercentagePayout: z.string().nullable(),
            feeMinPayin: z.string().nullable(),
            feeMaxPayin: z.string().nullable(),
            feeMinPayout: z.string().nullable(),
            feeMaxPayout: z.string().nullable(),
            monthlyAmount: z.string().nullable(),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "merchant.pricing.read")) return;
      const { merchantId: merchantRef } = request.params as { merchantId: string };

      const resolved = await resolveMerchantParam(merchantRef, reply);
      if (!resolved) return;
      const { merchantId } = resolved;

      const [row] = await db
        .select()
        .from(merchantPricing)
        .where(eq(merchantPricing.merchantId, merchantId))
        .limit(1);

      return {
        billingMode: row?.billingMode ?? "percentage_only",
        feePercentagePayin: row?.feePercentagePayin ?? null,
        feePercentagePayout: row?.feePercentagePayout ?? null,
        feeMinPayin: row?.feeMinPayin ?? null,
        feeMaxPayin: row?.feeMaxPayin ?? null,
        feeMinPayout: row?.feeMinPayout ?? null,
        feeMaxPayout: row?.feeMaxPayout ?? null,
        monthlyAmount: row?.monthlyAmount ?? null,
      };
    }
  );

  app.patch(
    "/provider/merchants/:merchantId/pricing",
    {
      schema: {
        params: z.object({ merchantId: merchantRefParamSchema }),
        body: z.object({
          billingMode: z.enum(BILLING_MODE).optional(),
          feePercentagePayin: z.string().optional(),
          feePercentagePayout: z.string().optional(),
          feeMinPayin: z.string().optional(),
          feeMaxPayin: z.string().optional(),
          feeMinPayout: z.string().optional(),
          feeMaxPayout: z.string().optional(),
          monthlyAmount: z.string().optional(),
        }),
        response: {
          200: z.object({
            id: z.string(),
            billingMode: z.string(),
          }),
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "merchant.pricing.write")) return;
      if (!(await requireProviderStepUp(request, reply, "merchant.pricing.write"))) return;
      const { merchantId: merchantRef } = request.params as { merchantId: string };
      const body = request.body as {
        billingMode?: (typeof BILLING_MODE)[number];
        feePercentagePayin?: string;
        feePercentagePayout?: string;
        feeMinPayin?: string;
        feeMaxPayin?: string;
        feeMinPayout?: string;
        feeMaxPayout?: string;
        monthlyAmount?: string;
      };

      const resolved = await resolveMerchantParam(merchantRef, reply);
      if (!resolved) return;
      const { merchantId } = resolved;

      if (body.feePercentagePayin != null) {
        const parsed = parseFeePercentageInput(body.feePercentagePayin, "feePercentagePayin");
        if (!parsed.ok) {
          return reply.status(400).send({ error: "Bad Request", message: parsed.message });
        }
        body.feePercentagePayin = parsed.value;
      }
      if (body.feePercentagePayout != null) {
        const parsed = parseFeePercentageInput(body.feePercentagePayout, "feePercentagePayout");
        if (!parsed.ok) {
          return reply.status(400).send({ error: "Bad Request", message: parsed.message });
        }
        body.feePercentagePayout = parsed.value;
      }

      const setFields: Record<string, unknown> = { updatedAt: new Date() };
      if (body.billingMode != null) setFields.billingMode = body.billingMode;
      if (body.feePercentagePayin != null) setFields.feePercentagePayin = body.feePercentagePayin;
      if (body.feePercentagePayout != null) setFields.feePercentagePayout = body.feePercentagePayout;
      if (body.feeMinPayin != null) setFields.feeMinPayin = body.feeMinPayin;
      if (body.feeMaxPayin != null) setFields.feeMaxPayin = body.feeMaxPayin;
      if (body.feeMinPayout != null) setFields.feeMinPayout = body.feeMinPayout;
      if (body.feeMaxPayout != null) setFields.feeMaxPayout = body.feeMaxPayout;
      if (body.monthlyAmount != null) setFields.monthlyAmount = body.monthlyAmount;

      const [existing] = await db
        .select()
        .from(merchantPricing)
        .where(eq(merchantPricing.merchantId, merchantId))
        .limit(1);

      let billingMode: string;
      if (existing) {
        await db
          .update(merchantPricing)
          .set(setFields as Record<string, string | Date>)
          .where(eq(merchantPricing.merchantId, merchantId));
        billingMode = (setFields.billingMode as string) ?? existing.billingMode;
      } else {
        const [inserted] = await db
          .insert(merchantPricing)
          .values({
            merchantId,
            billingMode: body.billingMode ?? "percentage_only",
            feePercentagePayin: body.feePercentagePayin ?? "0",
            feePercentagePayout: body.feePercentagePayout ?? "0",
            feeMinPayin: body.feeMinPayin ?? "0",
            feeMaxPayin: body.feeMaxPayin ?? null,
            feeMinPayout: body.feeMinPayout ?? "0",
            feeMaxPayout: body.feeMaxPayout ?? null,
            monthlyAmount: body.monthlyAmount ?? "0",
          })
          .returning();
        billingMode = inserted?.billingMode ?? body.billingMode ?? "percentage_only";
      }
      providerMerchantAudit(request, {
        action: "provider.merchant.pricing_changed",
        merchantId,
        meta: body as Record<string, unknown>,
      });

      return { id: merchantId, billingMode };
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

      providerMerchantAudit(request, {
        action: "provider.customer.status_changed",
        merchantId: customer.merchantId,
        resource: walletId,
        meta: { from: customer.status, to: status, reason: reason ?? null },
      });

      return { id: walletId, status };
    }
  );

  app.post(
    "/provider/customers/:walletId/wallet-adjustments",
    {
      schema: {
        params: z.object({ walletId: z.string().uuid() }),
        body: z.object({
          direction: z.enum(ADJUSTMENT_DIRECTION),
          amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
          reason: z.string().min(3).max(500),
          referenceId: z.string().min(3).max(200),
        }),
        response: {
          200: z.object({
            walletId: z.string(),
            merchantId: z.string(),
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
      if (!(await requireProviderStepUp(request, reply, "wallet.adjust"))) return;
      const { walletId } = request.params as { walletId: string };
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

      const [customerWallet] = await db
        .select()
        .from(wallets)
        .where(and(eq(wallets.id, walletId), eq(wallets.type, "customer")))
        .limit(1);
      if (!customerWallet) {
        return reply.status(404).send({ error: "Not found", message: "Customer wallet not found" });
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
            resourceType: "customer_wallet",
            resourceId: walletId,
            payload: JSON.stringify({
              walletId,
              merchantId: customerWallet.merchantId,
              direction: body.direction,
              amount: toMoneyString(amount),
              reason: body.reason,
              referenceId: body.referenceId,
              stepUpVerified: actor.stepUpVerified ?? false,
            }),
            reason: body.reason,
            ticketId: body.referenceId,
            riskLevel,
          })
          .returning({ id: providerActionRequests.id });

        providerMerchantAudit(request, {
          action: "provider.wallet.adjusted",
          merchantId: customerWallet.merchantId,
          resource: walletId,
          meta: {
            queuedOnly: true,
            walletType: "customer",
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
          .where(and(eq(wallets.id, walletId), eq(wallets.type, "customer")))
          .limit(1);
        if (!wallet) return { error: "WALLET_NOT_FOUND" as const };

        const previousBalance = Number(wallet.balance);
        const nextBalance = body.direction === "credit" ? previousBalance + amount : previousBalance - amount;
        if (nextBalance < 0) return { error: "INSUFFICIENT_BALANCE" as const };

        await tx.insert(ledgerEntries).values({
          walletId: wallet.id,
          environment: wallet.environment,
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
          return reply.status(404).send({ error: "Not found", message: "Customer wallet not found" });
        }
        return reply.status(400).send({ error: "Bad Request", message: "Insufficient balance for debit" });
      }

      providerMerchantAudit(request, {
        action: "provider.wallet.adjusted",
        merchantId: result.wallet.merchantId,
        resource: result.wallet.id,
        meta: {
          walletType: "customer",
          direction: body.direction,
          amount: toMoneyString(amount),
          previousBalance: toMoneyString(result.previousBalance),
          currentBalance: toMoneyString(result.nextBalance),
          reason: body.reason,
          referenceId: body.referenceId,
        },
      });

      return {
        walletId: result.wallet.id,
        merchantId: result.wallet.merchantId,
        direction: body.direction,
        amount: toMoneyString(amount),
        previousBalance: toMoneyString(result.previousBalance),
        currentBalance: toMoneyString(result.nextBalance),
      };
    }
  );

  app.post(
    "/provider/merchants/:merchantId/wallet-adjustments",
    {
      schema: {
        params: z.object({ merchantId: merchantRefParamSchema }),
        body: z.object({
          environment: z.enum(["test", "live"]).default("live"),
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
      if (!(await requireProviderStepUp(request, reply, "wallet.adjust"))) return;
      const { merchantId: merchantRef } = request.params as { merchantId: string };
      const resolved = await resolveMerchantParam(merchantRef, reply);
      if (!resolved) return;
      const { merchantId } = resolved;
      const body = request.body as {
        environment: "test" | "live";
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
              environment: body.environment,
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

        providerMerchantAudit(request, {
          action: "provider.wallet.adjusted",
          merchantId,
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
          .where(and(eq(wallets.merchantId, merchantId), eq(wallets.environment, body.environment), eq(wallets.type, "merchant")))
          .limit(1);
        if (!wallet) return { error: "WALLET_NOT_FOUND" as const };

        const previousBalance = Number(wallet.balance);
        const nextBalance =
          body.direction === "credit" ? previousBalance + amount : previousBalance - amount;
        if (nextBalance < 0) return { error: "INSUFFICIENT_BALANCE" as const, wallet };

        await tx.insert(ledgerEntries).values({
          walletId: wallet.id,
          environment: wallet.environment,
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

      providerMerchantAudit(request, {
        action: "provider.wallet.adjusted",
        merchantId,
        resource: result.wallet.id,
        meta: {
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

  const transactionRailFieldsSchema = z.object({
    currency: z.string(),
    rail: z.enum(["bangladesh", "brazil", "india", "europe", "pyusd", "internal", "unknown"]),
    railLabel: z.string(),
  });

  const providerTransactionListItemSchema = z.object({
    id: z.string(),
    merchantId: z.string(),
    merchantName: z.string(),
    type: z.string(),
    status: z.string(),
    amount: z.string(),
    paidAmount: z.string().nullable(),
    currency: z.string(),
    environment: z.string(),
    provider: z.string().nullable(),
    platformOrderId: z.string().nullable(),
    reviewRequired: z.boolean(),
    rail: transactionRailFieldsSchema.shape.rail,
    railLabel: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  });

  app.get(
    "/provider/transactions",
    {
      schema: {
        querystring: z.object({
          merchantId: z.string().uuid().optional(),
          type: z.enum(TRANSACTION_TYPE).optional(),
          status: z.enum(TRANSACTION_STATUS).optional(),
          environment: z.enum(["test", "live"]).optional(),
          reviewRequired: z.coerce.boolean().optional(),
          limit: z.coerce.number().min(1).max(100).default(20),
          offset: z.coerce.number().min(0).default(0),
        }),
        response: {
          200: z.object({
            items: z.array(providerTransactionListItemSchema),
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
      const { merchantId, type, status, environment, reviewRequired, limit, offset } = request.query as {
        merchantId?: string;
        type?: (typeof TRANSACTION_TYPE)[number];
        status?: (typeof TRANSACTION_STATUS)[number];
        environment?: "test" | "live";
        reviewRequired?: boolean;
        limit: number;
        offset: number;
      };
      const conditions = [];
      if (merchantId) conditions.push(eq(transactions.merchantId, merchantId));
      if (type) conditions.push(eq(transactions.type, type));
      if (status) conditions.push(eq(transactions.status, status));
      if (environment) conditions.push(eq(transactions.environment, environment));
      if (reviewRequired === true) {
        conditions.push(ilike(transactions.metadata, '%"reviewRequired":true%'));
      }

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
          currency: transactions.currency,
          environment: transactions.environment,
          provider: transactions.provider,
          metadata: transactions.metadata,
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
        items: rows.map((r) => {
          const rail = presentTransactionRail({
            provider: r.provider,
            currency: r.currency,
            metadata: r.metadata,
          });
          return {
            id: r.id,
            merchantId: r.merchantId,
            merchantName: r.merchantName,
            type: r.type,
            status: r.status,
            amount: String(r.amount),
            paidAmount: r.paidAmount ? String(r.paidAmount) : null,
            currency: r.currency,
            environment: r.environment,
            provider: r.provider,
            platformOrderId: r.platformOrderId,
            reviewRequired: isReviewRequired(r.metadata),
            rail: rail.rail,
            railLabel: rail.railLabel,
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
          };
        }),
        total: Number(totalResult?.count ?? 0),
        limit,
        offset,
      };
    }
  );

  app.get(
    "/provider/transactions/:transactionId",
    {
      schema: {
        params: z.object({ transactionId: z.string().uuid() }),
        response: {
          200: z.object({
            id: z.string(),
            merchantId: z.string(),
            merchantName: z.string(),
            walletId: z.string().nullable(),
            customer: z
              .object({
                walletId: z.string(),
                label: z.string().nullable(),
              })
              .nullable(),
            type: z.string(),
            status: z.string(),
            amount: z.string(),
            paidAmount: z.string().nullable(),
            currency: z.string(),
            settlementCurrency: z.string(),
            environment: z.string(),
            provider: z.string().nullable(),
            platformOrderId: z.string().nullable(),
            reviewRequired: z.boolean(),
            reconcileStatus: z.enum(["open", "settled", "failed", "review_required"]),
            rail: transactionRailFieldsSchema.shape.rail,
            railLabel: z.string(),
            fees: z
              .object({
                platformFee: z.string(),
                feeType: z.enum(["payin", "payout"]),
                feeStatus: z.enum(["none", "estimated", "applied"]),
              })
              .optional(),
            netAmount: z.string().nullable().optional(),
            totalWalletDebit: z.string().nullable().optional(),
            metadata: z.record(z.unknown()).nullable(),
            createdAt: z.string(),
            updatedAt: z.string(),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "tx.read")) return;
      const { transactionId } = request.params as { transactionId: string };

      const [row] = await db
        .select({
          id: transactions.id,
          merchantId: transactions.merchantId,
          merchantName: merchants.name,
          walletId: transactions.walletId,
          type: transactions.type,
          status: transactions.status,
          amount: transactions.amount,
          paidAmount: transactions.paidAmount,
          currency: transactions.currency,
          environment: transactions.environment,
          provider: transactions.provider,
          externalId: transactions.externalId,
          metadata: transactions.metadata,
          createdAt: transactions.createdAt,
          updatedAt: transactions.updatedAt,
        })
        .from(transactions)
        .innerJoin(merchants, eq(transactions.merchantId, merchants.id))
        .where(eq(transactions.id, transactionId))
        .limit(1);

      if (!row) {
        return reply.status(404).send({ error: "Not found", message: "Transaction not found" });
      }

      const rail = presentTransactionRail({
        provider: row.provider,
        currency: row.currency,
        metadata: row.metadata,
      });

      const {
        presentTransactionListItemBase,
        reconcileStatusFromTransaction,
      } = await import("../../src/lib/present-transaction.js");
      const {
        buildTransactionFeeBreakdown,
        feeSummaryFromBreakdown,
      } = await import("../../src/lib/billing/transaction-fee-breakdown.js");

      const presented = presentTransactionListItemBase({
        id: row.id,
        type: row.type,
        status: row.status,
        amount: row.amount,
        paidAmount: row.paidAmount,
        currency: row.currency,
        provider: row.provider,
        externalId: row.externalId,
        walletId: row.walletId,
        metadata: row.metadata,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });

      const feeBreakdown = await buildTransactionFeeBreakdown({
        merchantId: row.merchantId,
        environment: row.environment as "test" | "live",
        transactionId: row.id,
        type: row.type,
        status: row.status,
        amount: String(row.amount),
        paidAmount: row.paidAmount ? String(row.paidAmount) : null,
        currency: row.currency,
        provider: row.provider,
        metadata: row.metadata,
      });
      const feeSummary = feeSummaryFromBreakdown(feeBreakdown);

      let customer: { walletId: string; label: string | null } | null = null;
      if (row.walletId) {
        const [cw] = await db
          .select({ id: wallets.id, label: wallets.label })
          .from(wallets)
          .where(eq(wallets.id, row.walletId))
          .limit(1);
        if (cw) customer = { walletId: cw.id, label: cw.label };
      }

      return {
        id: row.id,
        merchantId: row.merchantId,
        merchantName: row.merchantName,
        walletId: row.walletId,
        customer,
        type: row.type,
        status: row.status,
        amount: String(row.amount),
        paidAmount: row.paidAmount ? String(row.paidAmount) : null,
        currency: row.currency,
        settlementCurrency: presented.settlementCurrency,
        environment: row.environment,
        provider: row.provider,
        platformOrderId: row.externalId,
        reviewRequired: isReviewRequired(row.metadata),
        reconcileStatus: reconcileStatusFromTransaction({
          status: row.status,
          metadata: row.metadata,
        }),
        rail: rail.rail,
        railLabel: rail.railLabel,
        ...feeSummary,
        metadata: parseTransactionMetadata(row.metadata),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
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
      if (!(await requireProviderStepUp(request, reply, "tx.status.write"))) return;
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

        providerMerchantAudit(request, {
          action: "provider.transaction.status_changed",
          merchantId: existing.merchantId,
          resource: transactionId,
          meta: {
            queuedOnly: true,
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

      providerMerchantAudit(request, {
        action: "provider.transaction.status_changed",
        merchantId: existing.merchantId,
        resource: transactionId,
        meta: {
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
          merchantId: z.string().uuid().optional(),
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
                merchantId: z.string().nullable(),
                ticketId: z.string().nullable(),
                riskLevel: z.string(),
                reason: z.string().nullable(),
                rejectedReason: z.string().nullable(),
                requestedBy: z.string().nullable(),
                approvedBy: z.string().nullable(),
                payload: z.record(z.unknown()),
                createdAt: z.string(),
                updatedAt: z.string(),
                reviewPath: z.string(),
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
      const { status, actionType, merchantId, limit, offset } = request.query as {
        status?: (typeof APPROVAL_STATUS)[number];
        actionType?: (typeof APPROVAL_ACTION)[number];
        merchantId?: string;
        limit: number;
        offset: number;
      };
      const conditions = [];
      if (status) conditions.push(eq(providerActionRequests.status, status));
      if (actionType) conditions.push(eq(providerActionRequests.actionType, actionType));
      if (merchantId) {
        conditions.push(sql`(${providerActionRequests.payload}::json->>'merchantId') = ${merchantId}`);
      }

      const whereClause = conditions.length ? and(...conditions) : undefined;

      const [totalResult] = await db
        .select({ count: count() })
        .from(providerActionRequests)
        .where(whereClause);

      const rows = await db
        .select()
        .from(providerActionRequests)
        .where(whereClause)
        .orderBy(desc(providerActionRequests.createdAt))
        .limit(limit)
        .offset(offset);

      return {
        items: rows.map((r) => {
          const payload = parsePayload(r.payload);
          const mid = typeof payload.merchantId === "string" ? payload.merchantId : null;
          return {
            id: r.id,
            actionType: r.actionType,
            status: r.status,
            resourceType: r.resourceType,
            resourceId: r.resourceId,
            merchantId: mid,
            ticketId: r.ticketId,
            riskLevel: r.riskLevel,
            reason: r.reason,
            rejectedReason: r.rejectedReason,
            requestedBy: r.requestedBy,
            approvedBy: r.approvedBy,
            payload,
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
            reviewPath: `/provider/approvals/${r.id}`,
          };
        }),
        total: Number(totalResult?.count ?? 0),
        limit,
        offset,
      };
    }
  );

  app.get(
    "/provider/approvals/:requestId",
    {
      schema: {
        params: z.object({ requestId: z.string().uuid() }),
        response: {
          200: z.object({
            id: z.string(),
            actionType: z.string(),
            status: z.string(),
            resourceType: z.string(),
            resourceId: z.string(),
            ticketId: z.string().nullable(),
            riskLevel: z.string(),
            reason: z.string().nullable(),
            rejectedReason: z.string().nullable(),
            requestedBy: z.string().nullable(),
            approvedBy: z.string().nullable(),
            payload: z.record(z.unknown()),
            executedAt: z.string().nullable(),
            rejectedAt: z.string().nullable(),
            createdAt: z.string(),
            updatedAt: z.string(),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "approval.read")) return;
      const { requestId } = request.params as { requestId: string };

      const [row] = await db
        .select()
        .from(providerActionRequests)
        .where(eq(providerActionRequests.id, requestId))
        .limit(1);

      if (!row) {
        return reply.status(404).send({ error: "Not found", message: "Approval request not found" });
      }

      return {
        id: row.id,
        actionType: row.actionType,
        status: row.status,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        ticketId: row.ticketId,
        riskLevel: row.riskLevel,
        reason: row.reason,
        rejectedReason: row.rejectedReason,
        requestedBy: row.requestedBy,
        approvedBy: row.approvedBy,
        payload: parsePayload(row.payload),
        executedAt: row.executedAt?.toISOString() ?? null,
        rejectedAt: row.rejectedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
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
          const walletId = String(payload.walletId ?? "");
          const environment = String(payload.environment ?? "live") as "test" | "live";
          const direction = String(payload.direction ?? "") as "credit" | "debit";
          const amount = Number(payload.amount ?? 0);
          const referenceId = String(payload.referenceId ?? "");
          if (!merchantId || !direction || !amount || !referenceId) return { error: "INVALID_PAYLOAD" as const };

          const [wallet] = walletId
            ? await tx
                .select()
                .from(wallets)
                .where(and(eq(wallets.id, walletId), eq(wallets.type, "customer")))
                .limit(1)
            : await tx
                .select()
                .from(wallets)
                .where(and(eq(wallets.merchantId, merchantId), eq(wallets.environment, environment), eq(wallets.type, "merchant")))
                .limit(1);
          if (!wallet) return { error: "WALLET_NOT_FOUND" as const };

          const previousBalance = Number(wallet.balance);
          const nextBalance = direction === "credit" ? previousBalance + amount : previousBalance - amount;
          if (nextBalance < 0) return { error: "INSUFFICIENT_BALANCE" as const };

          await tx.insert(ledgerEntries).values({
            walletId: wallet.id,
            environment: wallet.environment,
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
            environment: z.enum(["test", "live"]),
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
      const txEnvironment = getTransactionPayokEnvironment(txRow.metadata);
      try {
        if (txRow.type === "payin") {
          const res = await payokPayinInquiry(txRow.id, txEnvironment);
          inquiryStatus = res.status;
          inquiryBody = res.body;
        } else {
          const res = await payokPayoutInquiry(txRow.id, txEnvironment);
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

      providerMerchantAudit(request, {
        action: "provider.transaction.reconciled",
        merchantId: txRow.merchantId,
        resource: txRow.id,
        meta: {
          type: txRow.type,
          localStatus: txRow.status,
          environment: txEnvironment,
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
        environment: txEnvironment,
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

  app.post(
    "/provider/tylt/crossramp/reconcile-payin",
    {
      schema: {
        body: z.object({ transactionId: z.string().uuid() }),
        response: {
          200: z.object({
            outcome: z.enum(["finalized", "not_terminal", "skipped"]),
            transactionId: z.string(),
            detail: z.string().optional(),
            reason: z.enum(["already_terminal", "wrong_rail"]).optional(),
            sourcesTried: z.array(z.string()).optional(),
            merchantWebhookQueued: z.boolean().optional(),
          }),
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
          503: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "tx.reconcile")) return;
      const body = request.body as { transactionId: string };
      try {
        const result = await reconcileCrossRampPayinByTransactionId(body.transactionId);
        if (result.outcome === "error") {
          if (result.detail === "transaction_not_found") {
            return reply.status(404).send({ error: "Not found", message: "Transaction not found" });
          }
          return reply.status(400).send({
            error: "Bad Request",
            message: result.detail === "not_payin" ? "Transaction is not a pay-in" : result.detail,
          });
        }
        if (result.outcome === "skipped") {
          if (result.reason === "wrong_rail") {
            return reply.status(400).send({
              error: "Bad Request",
              message: "Not a Tylt CrossRamp UPI pay-in transaction",
            });
          }
          return reply.status(200).send({
            outcome: "skipped",
            transactionId: result.transactionId,
            reason: result.reason,
          });
        }
        if (result.outcome === "finalized") {
          queueMerchantWebhook(result.merchantWebhook.merchantId, result.merchantWebhook.event).catch((e) =>
            request.log.warn(e, "merchant webhook queue failed after Tylt reconcile")
          );
          audit({
            action: "provider.tylt.crossramp.reconcile",
            actor: request.provider?.providerUserId ?? "provider:api_key",
            resource: body.transactionId,
            meta: { outcome: "finalized", sourcesTried: result.sourcesTried },
          });
          return reply.status(200).send({
            outcome: "finalized",
            transactionId: result.transactionId,
            sourcesTried: result.sourcesTried,
            merchantWebhookQueued: true,
          });
        }
        audit({
          action: "provider.tylt.crossramp.reconcile",
          actor: request.provider?.providerUserId ?? "provider:api_key",
          resource: body.transactionId,
          meta: {
            outcome: "not_terminal",
            sourcesTried: result.sourcesTried,
            detail: result.detail,
          },
        });
        return reply.status(200).send({
          outcome: "not_terminal",
          transactionId: result.transactionId,
          sourcesTried: result.sourcesTried,
          detail: result.detail,
        });
      } catch (err) {
        if (err instanceof ProviderCircuitOpenError) {
          return reply.status(503).send({
            error: "Service Unavailable",
            message: "Upstream temporarily unavailable",
          });
        }
        throw err;
      }
    }
  );

  app.post(
    "/provider/payok/payin/reconcile",
    {
      schema: {
        body: z.object({ transactionId: z.string().uuid() }),
        response: {
          200: z.object({
            outcome: z.enum(["finalized", "not_terminal", "skipped"]),
            transactionId: z.string(),
            detail: z.string().optional(),
            reason: z.enum(["already_terminal", "wrong_rail"]).optional(),
            payokCode: z.string().nullable().optional(),
            payokStatus: z.string().nullable().optional(),
            merchantWebhookQueued: z.boolean().optional(),
          }),
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
          502: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "tx.reconcile")) return;
      const body = request.body as { transactionId: string };
      try {
        const result = await reconcilePayokPayinByTransactionId(body.transactionId);
        if (result.outcome === "error") {
          if (result.detail === "transaction_not_found") {
            return reply.status(404).send({ error: "Not found", message: "Transaction not found" });
          }
          if (result.detail === "not_payin") {
            return reply.status(400).send({ error: "Bad Request", message: "Transaction is not a pay-in" });
          }
          return reply.status(502).send({
            error: "Bad Gateway",
            message: `Payok reconcile failed: ${result.detail}`,
          });
        }
        if (result.outcome === "skipped") {
          if (result.reason === "wrong_rail") {
            return reply.status(400).send({
              error: "Bad Request",
              message: "Not a Payok domestic pay-in transaction (Bangladesh or Brazil)",
            });
          }
          return reply.status(200).send({
            outcome: "skipped",
            transactionId: result.transactionId,
            reason: result.reason,
          });
        }
        if (result.outcome === "finalized") {
          if (result.merchantWebhook) {
            queueMerchantWebhook(result.merchantWebhook.merchantId, result.merchantWebhook.event).catch((e) =>
              request.log.warn(e, "merchant webhook queue failed after Payok reconcile")
            );
          }
          audit({
            action: "provider.payok.payin.reconcile",
            actor: request.provider?.providerUserId ?? "provider:api_key",
            resource: body.transactionId,
            meta: {
              outcome: "finalized",
              payokCode: result.payokCode ?? null,
              payokStatus: result.payokStatus ?? null,
            },
          });
          return reply.status(200).send({
            outcome: "finalized",
            transactionId: result.transactionId,
            payokCode: result.payokCode ?? null,
            payokStatus: result.payokStatus ?? null,
            merchantWebhookQueued: Boolean(result.merchantWebhook),
          });
        }
        audit({
          action: "provider.payok.payin.reconcile",
          actor: request.provider?.providerUserId ?? "provider:api_key",
          resource: body.transactionId,
          meta: {
            outcome: "not_terminal",
            payokCode: result.payokCode ?? null,
            payokStatus: result.payokStatus ?? null,
            detail: result.detail,
          },
        });
        return reply.status(200).send({
          outcome: "not_terminal",
          transactionId: result.transactionId,
          payokCode: result.payokCode ?? null,
          payokStatus: result.payokStatus ?? null,
          detail: result.detail,
        });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({ error: "Internal Server Error" });
      }
    }
  );

  app.post(
    "/provider/tekko/pyusd/reconcile",
    {
      schema: {
        body: z.object({ transactionId: z.string().uuid() }),
        response: {
          200: z.object({
            outcome: z.enum(["finalized", "not_terminal", "skipped"]),
            transactionId: z.string(),
            detail: z.string().optional(),
            reason: z.enum(["already_terminal", "wrong_rail"]).optional(),
            paymentStatus: z.string().nullable().optional(),
            settlementStatus: z.string().nullable().optional(),
            merchantWebhookQueued: z.boolean().optional(),
          }),
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
          503: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "tx.reconcile")) return;
      const body = request.body as { transactionId: string };
      try {
        const result = await reconcileTekkoPyusdPayinByTransactionId(body.transactionId);
        if (result.outcome === "error") {
          if (result.detail === "transaction_not_found") {
            return reply.status(404).send({ error: "Not found", message: "Transaction not found" });
          }
          if (result.detail === "not_payin") {
            return reply.status(400).send({ error: "Bad Request", message: "Transaction is not a pay-in" });
          }
          return reply.status(500).send({
            error: "Internal Server Error",
            message: `Tekko reconcile failed: ${result.detail}`,
          });
        }
        if (result.outcome === "skipped") {
          if (result.reason === "wrong_rail") {
            return reply.status(400).send({
              error: "Bad Request",
              message: "Not a Tekko PYUSD pay-in transaction",
            });
          }
          return reply.status(200).send({
            outcome: "skipped",
            transactionId: result.transactionId,
            reason: result.reason,
          });
        }
        if (result.outcome === "finalized") {
          if (result.merchantWebhook) {
            queueMerchantWebhook(result.merchantWebhook.merchantId, result.merchantWebhook.event).catch((e) =>
              request.log.warn(e, "merchant webhook queue failed after Tekko reconcile")
            );
          }
          audit({
            action: "provider.tekko.pyusd.reconcile",
            actor: request.provider?.providerUserId ?? "provider:api_key",
            resource: body.transactionId,
            meta: {
              outcome: "finalized",
              paymentStatus: result.paymentStatus,
              settlementStatus: result.settlementStatus,
            },
          });
          return reply.status(200).send({
            outcome: "finalized",
            transactionId: result.transactionId,
            paymentStatus: result.paymentStatus,
            settlementStatus: result.settlementStatus,
            merchantWebhookQueued: Boolean(result.merchantWebhook),
          });
        }
        audit({
          action: "provider.tekko.pyusd.reconcile",
          actor: request.provider?.providerUserId ?? "provider:api_key",
          resource: body.transactionId,
          meta: {
            outcome: "not_terminal",
            paymentStatus: result.paymentStatus,
            settlementStatus: result.settlementStatus,
            detail: result.detail,
          },
        });
        return reply.status(200).send({
          outcome: "not_terminal",
          transactionId: result.transactionId,
          paymentStatus: result.paymentStatus,
          settlementStatus: result.settlementStatus,
          detail: result.detail,
        });
      } catch (err) {
        if (err instanceof ProviderCircuitOpenError) {
          return reply.status(503).send({
            error: "Service Unavailable",
            message: "Tekko provider circuit is open; try again shortly",
          });
        }
        request.log.error(err);
        return reply.status(500).send({ error: "Internal Server Error" });
      }
    }
  );

  app.get(
    "/provider/merchants/:merchantId/reconciliation-report",
    {
      schema: {
        params: z.object({ merchantId: merchantRefParamSchema }),
        querystring: z.object({
          environment: z.enum(["test", "live"]).default("test"),
          from: z.string().datetime(),
          to: z.string().datetime(),
          format: z.enum(["json", "csv"]).default("json"),
        }),
        response: {
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          400: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensureProviderPermission(request, reply, "tx.read")) return;
      const { merchantId: merchantRef } = request.params as { merchantId: string };
      const q = request.query as {
        environment: "test" | "live";
        from: string;
        to: string;
        format: "json" | "csv";
      };
      const resolved = await resolveMerchantParam(merchantRef, reply);
      if (!resolved) return;
      const { merchantId } = resolved;
      const from = new Date(q.from);
      const to = new Date(q.to);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
        return reply.status(400).send({ error: "Bad Request", message: "Invalid from/to range" });
      }
      const report = await buildReconciliationReport({
        merchantId,
        environment: q.environment,
        from,
        to,
      });
      if (q.format === "csv") {
        return reply
          .header("Content-Type", "text/csv; charset=utf-8")
          .header("Content-Disposition", `attachment; filename="reconciliation-${merchantId}.csv"`)
          .send(reconciliationReportToCsv(report));
      }
      return report;
    }
  );
}

