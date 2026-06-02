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
  limitsForMerchantWalletCurrency,
  pickPrimaryPortalWalletItem,
  portalWalletBalanceItemSchema,
  portalWalletLimitsSchema,
} from "../../src/lib/portal-wallet-balance.js";
import { sumPendingPayinAmountsByCurrency } from "../../src/lib/merchant-pending-balance.js";
import {
  buildPortalWalletCatalog,
  isMerchantMarket,
  listMerchantMarkets,
  MARKET_ENTITLEMENT_STATUSES,
  MARKET_KYB_STATUSES,
  MARKET_SETTLEMENT_CURRENCIES,
  MERCHANT_MARKETS,
  requestMerchantMarket,
} from "../../src/lib/merchant-markets.js";

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

const portalMarketRowSchema = z.object({
  market: z.enum(MERCHANT_MARKETS),
  entitlementStatus: z.enum(MARKET_ENTITLEMENT_STATUSES),
  kybStatus: z.enum(MARKET_KYB_STATUSES),
  requestedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  settlementCurrencies: z.array(z.string()),
});

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
          kycStatus: merchants.kycStatus,
        })
        .from(merchants)
        .where(eq(merchants.id, user.merchantId))
        .limit(1);

      if (!merchant) {
        return reply.status(404).send({ error: "Not found", message: "Merchant not found" });
      }

      const [profile] = await db
        .select({
          id: merchantBusinessProfiles.id,
          legalName: merchantBusinessProfiles.legalName,
          tradingName: merchantBusinessProfiles.tradingName,
          businessType: merchantBusinessProfiles.businessType,
          status: merchantBusinessProfiles.status,
        })
        .from(merchantBusinessProfiles)
        .where(eq(merchantBusinessProfiles.merchantId, user.merchantId))
        .limit(1);

      const [personsResult] = await db
        .select({ count: count() })
        .from(merchantPersons)
        .where(eq(merchantPersons.merchantId, user.merchantId));

      const [documentsResult] = await db
        .select({ count: count() })
        .from(merchantKycDocuments)
        .where(eq(merchantKycDocuments.merchantId, user.merchantId));

      const kycStatus = merchant.kycStatus ?? "pending";
      const canCreateApiKeys = kycStatus === "verified";
      const needsActivation = !profile || profile.status === "draft";

      return reply.send({
        merchantId: merchant.id,
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
        mfaEnabled: mu?.mfaEnabled ?? false,
        mfaPendingSetup: !!(mu?.mfaPending && !mu?.mfaEnabled),
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
        response: {
          200: z.object({ items: z.array(portalMarketRowSchema) }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      const rows = await listMerchantMarkets(user.merchantId);
      return reply.send({
        items: rows.map((r) => ({
          market: r.market,
          entitlementStatus: r.entitlementStatus,
          kybStatus: r.kybStatus,
          requestedAt: r.requestedAt?.toISOString() ?? null,
          approvedAt: r.approvedAt?.toISOString() ?? null,
          settlementCurrencies: [...MARKET_SETTLEMENT_CURRENCIES[r.market]],
        })),
      });
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
      const row = await requestMerchantMarket(user.merchantId, marketParam);
      return reply.send({
        market: row.market,
        entitlementStatus: row.entitlementStatus,
        kybStatus: row.kybStatus,
        requestedAt: row.requestedAt?.toISOString() ?? null,
        approvedAt: row.approvedAt?.toISOString() ?? null,
        settlementCurrencies: [...MARKET_SETTLEMENT_CURRENCIES[row.market]],
      });
    }
  );
}
