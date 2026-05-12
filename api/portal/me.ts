/**
 * Portal me routes: profile, activation status.
 * Requires portal JWT auth.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, asc, count, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  merchants,
  merchantBusinessProfiles,
  merchantPersons,
  merchantKycDocuments,
  merchantUsers,
  wallets,
} from "../../src/db/schema/index.js";
import { LIMITS } from "../../src/lib/limits.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
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
          200: z.object({
            balance: z.string(),
            availableBalance: z.string(),
            pendingBalance: z.string(),
            currency: z.string(),
            lastUpdated: z.string().nullable(),
            limits: z.object({
              payin: z.object({ min: z.number(), max: z.number() }),
              payout: z.object({ min: z.number(), max: z.number() }),
            }),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      const { environment } = request.query as { environment: "test" | "live" };

      // Prefer BDT when multiple active merchant wallets exist (e.g. BDT + USDT for
      // Tylt). Single-wallet merchants behave exactly as before. Deterministic tie-break.
      const [w] = await db
        .select({
          balance: wallets.balance,
          currency: wallets.currency,
          updatedAt: wallets.updatedAt,
        })
        .from(wallets)
        .where(
          and(
            eq(wallets.merchantId, user.merchantId),
            eq(wallets.environment, environment),
            eq(wallets.type, "merchant"),
            eq(wallets.status, "active")
          )
        )
        .orderBy(
          sql`(case when ${wallets.currency} = 'BDT' then 0 else 1 end)`,
          asc(wallets.currency),
          asc(wallets.id)
        )
        .limit(1);

      if (!w) {
        return reply.send({
          balance: "0",
          availableBalance: "0",
          pendingBalance: "0",
          currency: "BDT",
          lastUpdated: null,
          limits: LIMITS,
        });
      }

      return reply.send({
        balance: String(w.balance),
        availableBalance: String(w.balance),
        pendingBalance: "0",
        currency: w.currency,
        lastUpdated: w.updatedAt?.toISOString() ?? null,
        limits: LIMITS,
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
            items: z.array(
              z.object({
                id: z.string(),
                currency: z.string(),
                balance: z.string(),
                status: z.string(),
                label: z.string().nullable(),
                updatedAt: z.string().nullable(),
                createdAt: z.string(),
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

      const rows = await db
        .select({
          id: wallets.id,
          currency: wallets.currency,
          balance: wallets.balance,
          status: wallets.status,
          label: wallets.label,
          updatedAt: wallets.updatedAt,
          createdAt: wallets.createdAt,
        })
        .from(wallets)
        .where(
          and(
            eq(wallets.merchantId, user.merchantId),
            eq(wallets.environment, environment),
            eq(wallets.type, "merchant"),
            eq(wallets.status, "active")
          )
        )
        .orderBy(
          sql`(case when ${wallets.currency} = 'BDT' then 0 else 1 end)`,
          asc(wallets.currency),
          asc(wallets.id)
        );

      return reply.send({
        environment,
        items: rows.map((r) => ({
          id: r.id,
          currency: r.currency,
          balance: String(r.balance),
          status: r.status,
          label: r.label ?? null,
          updatedAt: r.updatedAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
      });
    }
  );
}
