/**
 * Portal me routes: profile, activation status.
 * Requires portal JWT auth.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, count } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  merchants,
  merchantBusinessProfiles,
  merchantPersons,
  merchantKycDocuments,
  merchantUsers,
} from "../../src/db/schema/index.js";
import {
  buildMerchantMarketBoard,
  buildMerchantServicesBoard,
  buildPortalWalletCatalog,
  isMerchantMarket,
  MARKET_BLOCKER_CODES,
  MARKET_ENTITLEMENT_STATUSES,
  MARKET_KYB_STATUSES,
  MERCHANT_MARKETS,
  requestMerchantMarket,
  WALLET_ACTIVATION_STATUSES,
} from "../../src/lib/merchant-markets.js";
import {
  isPortalMfaRequired,
  isPortalPayoutPinRequired,
} from "../../src/lib/portal-auth.js";
import { getMerchantPayoutPinStatus } from "../../src/lib/merchant-payout-pin.js";
import {
  portalWalletBalanceItemSchema,
  portalWalletLimitsSchema,
  pickPrimaryPortalWalletItem,
  limitsForMerchantWalletCurrency,
} from "../../src/lib/portal-wallet-balance.js";
import { sumPendingPayinAmountsByCurrency } from "../../src/lib/merchant-pending-balance.js";
import {
  buildReconciliationReport,
  reconciliationReportToCsv,
} from "../../src/lib/reconciliation-report.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

const portalBalanceTopLevelSchema = z.object({
  balance: z.string(),
  availableBalance: z.string(),
  pendingBalance: z.string(),
  currency: z.string(),
  lastUpdated: z.string().nullable(),
  limits: portalWalletLimitsSchema,
});

const portalMarketBlockerSchema = z.object({
  code: z.enum(MARKET_BLOCKER_CODES),
  message: z.string(),
});

const portalMarketRowSchema = z.object({
  market: z.enum(MERCHANT_MARKETS),
  displayName: z.string(),
  entitlementStatus: z.enum(MARKET_ENTITLEMENT_STATUSES),
  kybStatus: z.enum(MARKET_KYB_STATUSES),
  activationStatus: z.enum(WALLET_ACTIVATION_STATUSES),
  canRequest: z.boolean(),
  ready: z.boolean(),
  unlockReason: z.string().nullable(),
  blockers: z.array(portalMarketBlockerSchema),
  walletsProvisioned: z.boolean(),
  requestedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  settlementCurrencies: z.array(z.string()),
});

function serializeMarketBoardRow(r: {
  market: (typeof MERCHANT_MARKETS)[number];
  displayName: string;
  entitlementStatus: (typeof MARKET_ENTITLEMENT_STATUSES)[number];
  kybStatus: (typeof MARKET_KYB_STATUSES)[number];
  activationStatus: (typeof WALLET_ACTIVATION_STATUSES)[number];
  canRequest: boolean;
  ready: boolean;
  unlockReason: string | null;
  blockers: Array<{ code: string; message: string }>;
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

export async function registerPortalMeRoutes(app: FastifyInstance) {
  app.get(
    "/portal/me",
    {
      schema: {
        querystring: z.object({
          environment: z.enum(["test", "live"]).default("test"),
        }),
        response: {
          200: z.object({
            merchantId: z.string(),
            merchantSlug: z.string(),
            slug: z.string(),
            businessName: z.string(),
            email: z.string(),
            role: z.string(),
            kycStatus: z.string(),
            needsActivation: z.boolean(),
            canCreateApiKeys: z.boolean(),
            businessProfile: z
              .object({
                id: z.string(),
                legalName: z.string(),
                tradingName: z.string().nullable(),
                businessType: z.string(),
                status: z.string(),
              })
              .nullable(),
            personsCount: z.number(),
            documentsCount: z.number(),
            mfaEnabled: z.boolean(),
            mfaPendingSetup: z.boolean(),
            mfaSetupRequired: z.boolean(),
            payoutPinConfigured: z.boolean(),
            payoutPinSetupRequired: z.boolean(),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const [mu] = await db
        .select({
          mfaEnabled: merchantUsers.mfaEnabled,
          mfaPending: merchantUsers.mfaPending,
        })
        .from(merchantUsers)
        .where(eq(merchantUsers.id, user.merchantUserId))
        .limit(1);

      const [merchant] = await db
        .select({
          id: merchants.id,
          name: merchants.name,
          slug: merchants.slug,
          kycStatus: merchants.kycStatus,
        })
        .from(merchants)
        .where(eq(merchants.id, user.merchantId))
        .limit(1);

      if (!merchant) {
        return reply.status(404).send({ error: "Not found", message: "Merchant not found" });
      }

      const { ensureMerchantSlug } = await import("../../src/lib/merchant-slug.js");
      const merchantSlug = await ensureMerchantSlug(merchant.id, merchant.name);

      const [[profile], [personsResult], [documentsResult]] = await Promise.all([
        db
          .select({
            id: merchantBusinessProfiles.id,
            legalName: merchantBusinessProfiles.legalName,
            tradingName: merchantBusinessProfiles.tradingName,
            businessType: merchantBusinessProfiles.businessType,
            status: merchantBusinessProfiles.status,
          })
          .from(merchantBusinessProfiles)
          .where(eq(merchantBusinessProfiles.merchantId, user.merchantId))
          .limit(1),
        db
          .select({ count: count() })
          .from(merchantPersons)
          .where(eq(merchantPersons.merchantId, user.merchantId)),
        db
          .select({ count: count() })
          .from(merchantKycDocuments)
          .where(eq(merchantKycDocuments.merchantId, user.merchantId)),
      ]);

      const kycStatus = merchant.kycStatus ?? "pending";
      const canCreateApiKeys = kycStatus === "verified";
      const needsActivation = !profile || profile.status === "draft";
      const payoutPin = await getMerchantPayoutPinStatus(user.merchantId);
      const mfaEnabled = mu?.mfaEnabled ?? false;

      return reply.send({
        merchantId: merchant.id,
        merchantSlug,
        slug: merchantSlug,
        businessName: merchant.name,
        email: user.email,
        role: user.role,
        kycStatus,
        needsActivation,
        canCreateApiKeys,
        businessProfile: profile
          ? {
              id: profile.id,
              legalName: profile.legalName,
              tradingName: profile.tradingName,
              businessType: profile.businessType,
              status: profile.status,
            }
          : null,
        personsCount: Number(personsResult?.count ?? 0),
        documentsCount: Number(documentsResult?.count ?? 0),
        mfaEnabled,
        mfaPendingSetup: !!(mu?.mfaPending && !mfaEnabled),
        mfaSetupRequired: isPortalMfaRequired() && !mfaEnabled,
        payoutPinConfigured: payoutPin.configured,
        payoutPinSetupRequired: isPortalPayoutPinRequired() && !payoutPin.configured,
      });
    }
  );

  app.patch(
    "/portal/me",
    {
      schema: {
        body: z.object({
          businessName: z.string().min(1).max(200).optional(),
        }),
        response: {
          200: z.object({ ok: z.boolean() }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const body = request.body as { businessName?: string };
      if (body.businessName) {
        await db
          .update(merchants)
          .set({ name: body.businessName.trim(), updatedAt: new Date() })
          .where(eq(merchants.id, user.merchantId));
      }

      return reply.send({ ok: true });
    }
  );

  app.get(
    "/portal/me/balance",
    {
      schema: {
        querystring: z.object({
          environment: z.enum(["test", "live"]).default("test"),
        }),
        response: {
          200: portalBalanceTopLevelSchema.extend({
            environment: z.enum(["test", "live"]),
            items: z.array(portalWalletBalanceItemSchema),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      const { environment } = request.query as { environment: "test" | "live" };

      const pendingByCurrency = await sumPendingPayinAmountsByCurrency({
        merchantId: user.merchantId,
        environment,
      });
      const items = await buildPortalWalletCatalog({
        merchantId: user.merchantId,
        environment,
        pendingByCurrency,
      });
      const primary = pickPrimaryPortalWalletItem(items);

      if (!primary) {
        return reply.send({
          environment,
          balance: "0",
          availableBalance: "0",
          pendingBalance: "0",
          currency: "BDT",
          lastUpdated: null,
          limits: limitsForMerchantWalletCurrency("BDT"),
          items: [],
        });
      }

      return reply.send({
        environment,
        balance: primary.balance,
        availableBalance: primary.availableBalance,
        pendingBalance: primary.pendingBalance,
        currency: primary.currency,
        lastUpdated: primary.lastUpdated,
        limits: primary.limits,
        items,
      });
    }
  );

  app.get(
    "/portal/me/wallets",
    {
      schema: {
        querystring: z.object({
          environment: z.enum(["test", "live"]).default("test"),
        }),
        response: {
          200: z.object({
            environment: z.enum(["test", "live"]),
            items: z.array(portalWalletBalanceItemSchema),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      const { environment } = request.query as { environment: "test" | "live" };

      const pendingByCurrency = await sumPendingPayinAmountsByCurrency({
        merchantId: user.merchantId,
        environment,
      });
      const items = await buildPortalWalletCatalog({
        merchantId: user.merchantId,
        environment,
        pendingByCurrency,
      });

      return reply.send({
        environment,
        items,
      });
    }
  );

  app.get(
    "/portal/me/markets",
    {
      schema: {
        querystring: z.object({
          environment: z.enum(["test", "live"]).default("live"),
        }),
        response: {
          200: z.object({
            globalKycStatus: z.string(),
            items: z.array(portalMarketRowSchema),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      const { environment } = request.query as { environment: "test" | "live" };
      const board = await buildMerchantMarketBoard({
        merchantId: user.merchantId,
        environment,
      });
      return reply.send({
        globalKycStatus: board.globalKycStatus,
        items: board.items.map(serializeMarketBoardRow),
      });
    }
  );

  app.get(
    "/portal/me/services",
    {
      schema: {
        querystring: z.object({
          environment: z.enum(["test", "live"]).default("test"),
        }),
        response: {
          200: z.object({
            environment: z.enum(["test", "live"]),
            globalKycStatus: z.string(),
            markets: z.array(portalMarketRowSchema),
            wallets: z.array(portalWalletBalanceItemSchema),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      const { environment } = request.query as { environment: "test" | "live" };
      const pendingByCurrency = await sumPendingPayinAmountsByCurrency({
        merchantId: user.merchantId,
        environment,
      });
      const board = await buildMerchantServicesBoard({
        merchantId: user.merchantId,
        environment,
        pendingByCurrency,
      });
      return reply.send({
        environment: board.environment,
        globalKycStatus: board.globalKycStatus,
        markets: board.markets.map(serializeMarketBoardRow),
        wallets: board.wallets,
      });
    }
  );

  const moneyCountsSchema = z.object({
    pending: z.number(),
    success: z.number(),
    failed: z.number(),
    total: z.number(),
  });

  app.get(
    "/portal/me/money/overview",
    {
      schema: {
        querystring: z.object({
          environment: z.enum(["test", "live"]).default("test"),
        }),
        response: {
          200: z.object({
            environment: z.enum(["test", "live"]),
            globalKycStatus: z.string(),
            rails: z.array(
              z.object({
                market: z.enum(MERCHANT_MARKETS),
                displayName: z.string(),
                ready: z.boolean(),
                unlockReason: z.string().nullable(),
                settlementCurrencies: z.array(z.string()),
                counts: z.object({
                  payin: moneyCountsSchema,
                  payout: moneyCountsSchema,
                }),
                capabilities: z.object({
                  canCreatePayin: z.boolean(),
                  canCreatePayout: z.boolean(),
                  payinPath: z.string().nullable(),
                  payoutPath: z.string().nullable(),
                  statusPath: z.string().nullable(),
                  integrationHint: z.string().nullable(),
                }),
                transactionsQuery: z.string(),
              })
            ),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      const { environment } = request.query as { environment: "test" | "live" };
      const { buildPortalMoneyOverview } = await import("../../src/lib/portal-money-overview.js");
      return reply.send(
        await buildPortalMoneyOverview({
          merchantId: user.merchantId,
          environment,
        })
      );
    }
  );

  app.post(
    "/portal/me/markets/:market/request",
    {
      schema: {
        params: z.object({ market: z.string() }),
        response: {
          200: portalMarketRowSchema,
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      const { market: marketParam } = request.params as { market: string };
      if (!isMerchantMarket(marketParam)) {
        return reply.status(400).send({ error: "Bad Request", message: "Invalid market" });
      }
      await requestMerchantMarket(user.merchantId, marketParam);
      const board = await buildMerchantMarketBoard({
        merchantId: user.merchantId,
        environment: "live",
      });
      const row = board.items.find((r) => r.market === marketParam);
      if (!row) {
        return reply.status(400).send({ error: "Bad Request", message: "Invalid market" });
      }
      return reply.send(serializeMarketBoardRow(row));
    }
  );

  app.get(
    "/portal/me/reconciliation",
    {
      schema: {
        querystring: z.object({
          environment: z.enum(["test", "live"]).default("test"),
          from: z.string().datetime(),
          to: z.string().datetime(),
          format: z.enum(["json", "csv"]).default("json"),
        }),
        response: {
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      const q = request.query as {
        environment: "test" | "live";
        from: string;
        to: string;
        format: "json" | "csv";
      };
      const from = new Date(q.from);
      const to = new Date(q.to);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
        return reply.status(400).send({ error: "Bad Request", message: "Invalid from/to range" });
      }
      const maxRangeMs = 93 * 24 * 60 * 60 * 1000;
      if (to.getTime() - from.getTime() > maxRangeMs) {
        return reply.status(400).send({ error: "Bad Request", message: "Date range max 93 days" });
      }

      const report = await buildReconciliationReport({
        merchantId: user.merchantId,
        environment: q.environment,
        from,
        to,
      });

      if (q.format === "csv") {
        return reply
          .header("Content-Type", "text/csv; charset=utf-8")
          .header("Content-Disposition", `attachment; filename="reconciliation-${q.environment}.csv"`)
          .send(reconciliationReportToCsv(report));
      }
      return reply.send(report);
    }
  );
}
