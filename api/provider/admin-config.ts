/**
 * Provider admin: FX rate profiles, merchant FX overrides, fee schedules, IP allowlists.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  fxRateProfiles,
  merchantFeeSchedules,
  merchantFxOverrides,
} from "../../src/db/schema/index.js";
import {
  canProviderAccess,
  canProviderActionContext,
  requireProviderStepUp,
  type ProviderPermission,
} from "../../src/lib/provider-auth.js";
import { providerMerchantAudit } from "../../src/lib/provider-audit.js";
import { applySpreadToCryptoAmount } from "../../src/lib/fx/spread.js";
import { resolveFxSpread } from "../../src/lib/fx/rate-resolver.js";
import { merchantRefParamSchema, resolveMerchantId } from "../../src/lib/merchant-ref.js";
import {
  getMerchantApiIpRules,
  upsertMerchantApiIpRules,
} from "../../src/lib/merchant-api-ip-rules.js";
import { parseFeePercentageInput } from "../../src/lib/billing/fee-percentage.js";
import { buildAdminPricingOverview } from "../../src/lib/merchant-pricing-experience.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
  code: z.string().optional(),
});

const FX_PRODUCT = ["cpg_payout", "eur_payout"] as const;
const FEE_RAIL = ["bangladesh", "brazil", "india", "europe", "cpg_crypto"] as const;
const FEE_TYPE = ["payin", "payout"] as const;
const ENV = ["test", "live"] as const;

function ensurePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  permission: ProviderPermission
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
          : "Insufficient permission";
    reply.status(403).send({ error: "Forbidden", message });
    return false;
  }
  return true;
}

async function ensureMerchantFromRef(merchantRef: string, reply: FastifyReply): Promise<string | null> {
  const merchantId = await resolveMerchantId(merchantRef);
  if (!merchantId) {
    reply.status(404).send({ error: "Not found", message: "Merchant not found" });
    return null;
  }
  return merchantId;
}

const fxProfileSchema = z.object({
  id: z.string(),
  product: z.enum(FX_PRODUCT),
  settledCurrency: z.string(),
  networkSymbol: z.string().nullable(),
  quoteCurrency: z.string().nullable(),
  source: z.string(),
  manualRate: z.string().nullable(),
  spreadBps: z.number(),
  spreadMode: z.string(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  status: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export async function registerProviderAdminConfigRoutes(app: FastifyInstance) {
  app.get(
    "/provider/fx-rate-profiles",
    {
      schema: {
        querystring: z.object({
          product: z.enum(FX_PRODUCT).optional(),
          settledCurrency: z.string().optional(),
          status: z.enum(["active", "archived"]).optional(),
          limit: z.coerce.number().min(1).max(100).default(50),
        }),
        response: {
          200: z.object({ items: z.array(fxProfileSchema) }),
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensurePermission(request, reply, "merchant.rates.read")) return;
      const q = request.query as {
        product?: (typeof FX_PRODUCT)[number];
        settledCurrency?: string;
        status?: string;
        limit: number;
      };
      const conditions = [];
      if (q.product) conditions.push(eq(fxRateProfiles.product, q.product));
      if (q.settledCurrency) conditions.push(eq(fxRateProfiles.settledCurrency, q.settledCurrency.trim().toUpperCase()));
      if (q.status) conditions.push(eq(fxRateProfiles.status, q.status));

      const rows = await db
        .select()
        .from(fxRateProfiles)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(fxRateProfiles.effectiveFrom))
        .limit(q.limit);

      return {
        items: rows.map((r) => ({
          id: r.id,
          product: r.product as (typeof FX_PRODUCT)[number],
          settledCurrency: r.settledCurrency,
          networkSymbol: r.networkSymbol,
          quoteCurrency: r.quoteCurrency,
          source: r.source,
          manualRate: r.manualRate != null ? String(r.manualRate) : null,
          spreadBps: r.spreadBps,
          spreadMode: r.spreadMode,
          effectiveFrom: r.effectiveFrom.toISOString(),
          effectiveTo: r.effectiveTo?.toISOString() ?? null,
          status: r.status,
          createdBy: r.createdBy,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
      };
    }
  );

  app.post(
    "/provider/fx-rate-profiles",
    {
      schema: {
        body: z.object({
          product: z.enum(FX_PRODUCT),
          settledCurrency: z.string().min(2).max(8),
          networkSymbol: z.string().optional().nullable(),
          quoteCurrency: z.string().optional().nullable(),
          source: z.enum(["manual_fixed", "upstream_mirror"]).default("manual_fixed"),
          manualRate: z.string().optional().nullable(),
          spreadBps: z.number().int().min(0).max(10_000).default(0),
          spreadMode: z.enum(["on_output", "on_rate"]).default("on_output"),
          effectiveFrom: z.string().datetime().optional(),
          effectiveTo: z.string().datetime().optional().nullable(),
        }),
        response: { 201: fxProfileSchema, 401: errorResponse, 403: errorResponse },
      },
    },
    async (request, reply) => {
      if (!ensurePermission(request, reply, "merchant.rates.write")) return;
      if (!(await requireProviderStepUp(request, reply, "merchant.rates.write"))) return;
      const body = request.body as {
        product: (typeof FX_PRODUCT)[number];
        settledCurrency: string;
        networkSymbol?: string | null;
        quoteCurrency?: string | null;
        source: "manual_fixed" | "upstream_mirror";
        manualRate?: string | null;
        spreadBps: number;
        spreadMode: "on_output" | "on_rate";
        effectiveFrom?: string;
        effectiveTo?: string | null;
      };
      const actor = request.provider?.email ?? request.provider?.providerUserId ?? "provider";
      const [row] = await db
        .insert(fxRateProfiles)
        .values({
          product: body.product,
          settledCurrency: String(body.settledCurrency).trim().toUpperCase(),
          networkSymbol: body.networkSymbol?.trim() || null,
          quoteCurrency: body.quoteCurrency?.trim()?.toUpperCase() || null,
          source: body.source,
          manualRate: body.manualRate ?? null,
          spreadBps: body.spreadBps,
          spreadMode: body.spreadMode,
          effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : new Date(),
          effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : null,
          status: "active",
          createdBy: actor,
        })
        .returning();
      if (!row) throw new Error("Failed to create FX rate profile");
      return reply.status(201).send({
        id: row.id,
        product: row.product as (typeof FX_PRODUCT)[number],
        settledCurrency: row.settledCurrency,
        networkSymbol: row.networkSymbol,
        quoteCurrency: row.quoteCurrency,
        source: row.source,
        manualRate: row.manualRate != null ? String(row.manualRate) : null,
        spreadBps: row.spreadBps,
        spreadMode: row.spreadMode,
        effectiveFrom: row.effectiveFrom.toISOString(),
        effectiveTo: row.effectiveTo?.toISOString() ?? null,
        status: row.status,
        createdBy: row.createdBy,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
    }
  );

  app.patch(
    "/provider/fx-rate-profiles/:id",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          spreadBps: z.number().int().min(0).max(10_000).optional(),
          manualRate: z.string().optional().nullable(),
          status: z.enum(["active", "archived"]).optional(),
          effectiveTo: z.string().datetime().optional().nullable(),
        }),
        response: { 200: fxProfileSchema, 404: errorResponse, 401: errorResponse, 403: errorResponse },
      },
    },
    async (request, reply) => {
      if (!ensurePermission(request, reply, "merchant.rates.write")) return;
      if (!(await requireProviderStepUp(request, reply, "merchant.rates.write"))) return;
      const { id } = request.params as { id: string };
      const body = request.body as Record<string, unknown>;
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (body.spreadBps != null) patch.spreadBps = body.spreadBps;
      if (body.manualRate !== undefined) patch.manualRate = body.manualRate;
      if (body.status != null) patch.status = body.status;
      if (body.effectiveTo !== undefined) {
        patch.effectiveTo = body.effectiveTo ? new Date(body.effectiveTo as string) : null;
      }
      const [row] = await db.update(fxRateProfiles).set(patch).where(eq(fxRateProfiles.id, id)).returning();
      if (!row) return reply.status(404).send({ error: "Not found", message: "Rate profile not found" });
      return {
        id: row.id,
        product: row.product as (typeof FX_PRODUCT)[number],
        settledCurrency: row.settledCurrency,
        networkSymbol: row.networkSymbol,
        quoteCurrency: row.quoteCurrency,
        source: row.source,
        manualRate: row.manualRate != null ? String(row.manualRate) : null,
        spreadBps: row.spreadBps,
        spreadMode: row.spreadMode,
        effectiveFrom: row.effectiveFrom.toISOString(),
        effectiveTo: row.effectiveTo?.toISOString() ?? null,
        status: row.status,
        createdBy: row.createdBy,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    }
  );

  app.post(
    "/provider/fx-rate-profiles/preview-quote",
    {
      schema: {
        body: z.object({
          product: z.enum(FX_PRODUCT),
          amount: z.string(),
          settledCurrency: z.string(),
          networkSymbol: z.string().optional().nullable(),
          merchantId: z.string().uuid().optional(),
          environment: z.enum(ENV).default("test"),
        }),
        response: {
          200: z.object({
            baseAmount: z.string(),
            spreadBps: z.number(),
            spreadAmount: z.string(),
            totalDebit: z.string(),
            disabled: z.boolean(),
          }),
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensurePermission(request, reply, "merchant.rates.read")) return;
      const body = request.body as {
        product: (typeof FX_PRODUCT)[number];
        amount: string;
        settledCurrency: string;
        networkSymbol?: string | null;
        merchantId?: string;
        environment: (typeof ENV)[number];
      };
      const resolved = body.merchantId
        ? await resolveFxSpread({
            merchantId: body.merchantId,
            environment: body.environment,
            product: body.product,
            settledCurrency: body.settledCurrency,
            networkSymbol: body.networkSymbol,
          })
        : null;
      const spreadBps = resolved?.spreadBps ?? 0;
      if (resolved?.disabled) {
        return { baseAmount: body.amount, spreadBps: 0, spreadAmount: "0.00", totalDebit: body.amount, disabled: true };
      }
      const spread = applySpreadToCryptoAmount(body.amount, spreadBps);
      return { ...spread, spreadBps, disabled: false };
    }
  );

  app.get(
    "/provider/merchants/:merchantId/fx-overrides",
    {
      schema: {
        params: z.object({ merchantId: merchantRefParamSchema }),
        querystring: z.object({ environment: z.enum(ENV).optional() }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                environment: z.enum(ENV),
                product: z.enum(FX_PRODUCT),
                settledCurrency: z.string(),
                networkSymbol: z.string().nullable(),
                spreadBpsOverride: z.number().nullable(),
                manualRateOverride: z.string().nullable(),
                disabled: z.boolean(),
                effectiveFrom: z.string(),
                effectiveTo: z.string().nullable(),
              })
            ),
          }),
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensurePermission(request, reply, "merchant.rates.read")) return;
      const { merchantId: merchantRef } = request.params as { merchantId: string };
      const merchantId = await ensureMerchantFromRef(merchantRef, reply);
      if (!merchantId) return;
      const { environment } = request.query as { environment?: (typeof ENV)[number] };
      const conditions = [eq(merchantFxOverrides.merchantId, merchantId)];
      if (environment) conditions.push(eq(merchantFxOverrides.environment, environment));
      const rows = await db
        .select()
        .from(merchantFxOverrides)
        .where(and(...conditions))
        .orderBy(desc(merchantFxOverrides.updatedAt));
      return {
        items: rows.map((r) => ({
          id: r.id,
          environment: r.environment as (typeof ENV)[number],
          product: r.product as (typeof FX_PRODUCT)[number],
          settledCurrency: r.settledCurrency,
          networkSymbol: r.networkSymbol,
          spreadBpsOverride: r.spreadBpsOverride,
          manualRateOverride: r.manualRateOverride != null ? String(r.manualRateOverride) : null,
          disabled: r.disabled,
          effectiveFrom: r.effectiveFrom.toISOString(),
          effectiveTo: r.effectiveTo?.toISOString() ?? null,
        })),
      };
    }
  );

  app.put(
    "/provider/merchants/:merchantId/fx-overrides",
    {
      schema: {
        params: z.object({ merchantId: merchantRefParamSchema }),
        body: z.object({
          environment: z.enum(ENV),
          product: z.enum(FX_PRODUCT),
          settledCurrency: z.string(),
          networkSymbol: z.string().optional().nullable(),
          spreadBpsOverride: z.number().int().min(0).max(10_000).optional().nullable(),
          manualRateOverride: z.string().optional().nullable(),
          disabled: z.boolean().optional(),
          effectiveFrom: z.string().datetime().optional(),
          effectiveTo: z.string().datetime().optional().nullable(),
        }),
        response: { 200: z.object({ id: z.string() }), 401: errorResponse, 403: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      if (!ensurePermission(request, reply, "merchant.rates.write")) return;
      if (!(await requireProviderStepUp(request, reply, "merchant.rates.write"))) return;
      const { merchantId: merchantRef } = request.params as { merchantId: string };
      const merchantId = await ensureMerchantFromRef(merchantRef, reply);
      if (!merchantId) return;
      const body = request.body as Record<string, unknown>;
      const currency = String(body.settledCurrency).trim().toUpperCase();
      const network = (body.networkSymbol as string | null | undefined)?.trim() || null;

      const [existing] = await db
        .select()
        .from(merchantFxOverrides)
        .where(
          and(
            eq(merchantFxOverrides.merchantId, merchantId),
            eq(merchantFxOverrides.environment, body.environment as string),
            eq(merchantFxOverrides.product, body.product as string),
            eq(merchantFxOverrides.settledCurrency, currency),
            network
              ? eq(merchantFxOverrides.networkSymbol, network)
              : isNull(merchantFxOverrides.networkSymbol)
          )
        )
        .limit(1);

      let id: string;
      if (existing) {
        const [updated] = await db
          .update(merchantFxOverrides)
          .set({
            spreadBpsOverride: (body.spreadBpsOverride as number | null | undefined) ?? null,
            manualRateOverride: (body.manualRateOverride as string | null | undefined) ?? null,
            disabled: (body.disabled as boolean | undefined) ?? existing.disabled,
            effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom as string) : existing.effectiveFrom,
            effectiveTo:
              body.effectiveTo !== undefined
                ? body.effectiveTo
                  ? new Date(body.effectiveTo as string)
                  : null
                : existing.effectiveTo,
            updatedAt: new Date(),
          })
          .where(eq(merchantFxOverrides.id, existing.id))
          .returning({ id: merchantFxOverrides.id });
        id = updated!.id;
      } else {
        const [inserted] = await db
          .insert(merchantFxOverrides)
          .values({
            merchantId,
            environment: body.environment as string,
            product: body.product as string,
            settledCurrency: currency,
            networkSymbol: network,
            spreadBpsOverride: (body.spreadBpsOverride as number | null | undefined) ?? null,
            manualRateOverride: (body.manualRateOverride as string | null | undefined) ?? null,
            disabled: (body.disabled as boolean | undefined) ?? false,
            effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom as string) : new Date(),
            effectiveTo: body.effectiveTo ? new Date(body.effectiveTo as string) : null,
          })
          .returning({ id: merchantFxOverrides.id });
        id = inserted!.id;
      }

      providerMerchantAudit(request, {
        action: "provider.merchant.rates_changed",
        merchantId,
        meta: { overrideId: id, product: body.product, settledCurrency: currency },
      });
      return { id };
    }
  );

  const feeScheduleSchema = z.object({
    id: z.string(),
    environment: z.enum(ENV),
    rail: z.enum(FEE_RAIL),
    currency: z.string(),
    feeType: z.enum(FEE_TYPE),
    billingMode: z.string(),
    feePercentage: z.string().nullable(),
    feeFlat: z.string().nullable(),
    feeMin: z.string().nullable(),
    feeMax: z.string().nullable(),
    effectiveFrom: z.string(),
    effectiveTo: z.string().nullable(),
    status: z.string(),
  });

  app.get(
    "/provider/merchants/:merchantId/fee-schedules",
    {
      schema: {
        params: z.object({ merchantId: merchantRefParamSchema }),
        querystring: z.object({ environment: z.enum(ENV).optional(), status: z.string().optional() }),
        response: {
          200: z.object({ items: z.array(feeScheduleSchema) }),
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensurePermission(request, reply, "merchant.pricing.read")) return;
      const { merchantId: merchantRef } = request.params as { merchantId: string };
      const merchantId = await ensureMerchantFromRef(merchantRef, reply);
      if (!merchantId) return;
      const q = request.query as { environment?: (typeof ENV)[number]; status?: string };
      const conditions = [eq(merchantFeeSchedules.merchantId, merchantId)];
      if (q.environment) conditions.push(eq(merchantFeeSchedules.environment, q.environment));
      if (q.status) conditions.push(eq(merchantFeeSchedules.status, q.status));
      const rows = await db
        .select()
        .from(merchantFeeSchedules)
        .where(and(...conditions))
        .orderBy(desc(merchantFeeSchedules.effectiveFrom));
      return {
        items: rows.map((r) => ({
          id: r.id,
          environment: r.environment as (typeof ENV)[number],
          rail: r.rail as (typeof FEE_RAIL)[number],
          currency: r.currency,
          feeType: r.feeType as (typeof FEE_TYPE)[number],
          billingMode: r.billingMode,
          feePercentage: r.feePercentage != null ? String(r.feePercentage) : null,
          feeFlat: r.feeFlat != null ? String(r.feeFlat) : null,
          feeMin: r.feeMin != null ? String(r.feeMin) : null,
          feeMax: r.feeMax != null ? String(r.feeMax) : null,
          effectiveFrom: r.effectiveFrom.toISOString(),
          effectiveTo: r.effectiveTo?.toISOString() ?? null,
          status: r.status,
        })),
      };
    }
  );

  app.post(
    "/provider/merchants/:merchantId/fee-schedules",
    {
      schema: {
        params: z.object({ merchantId: merchantRefParamSchema }),
        body: z.object({
          environment: z.enum(ENV),
          rail: z.enum(FEE_RAIL),
          currency: z.string().min(2).max(8),
          feeType: z.enum(FEE_TYPE),
          billingMode: z.enum(["percentage_only", "monthly_only", "both"]).default("percentage_only"),
          feePercentage: z.string().optional(),
          feeFlat: z.string().optional(),
          feeMin: z.string().optional(),
          feeMax: z.string().optional().nullable(),
          effectiveFrom: z.string().datetime().optional(),
          effectiveTo: z.string().datetime().optional().nullable(),
        }),
        response: { 201: feeScheduleSchema, 400: errorResponse, 401: errorResponse, 403: errorResponse, 404: errorResponse },
      },
    },
    async (request, reply) => {
      if (!ensurePermission(request, reply, "merchant.pricing.write")) return;
      if (!(await requireProviderStepUp(request, reply, "merchant.pricing.write"))) return;
      const { merchantId: merchantRef } = request.params as { merchantId: string };
      const merchantId = await ensureMerchantFromRef(merchantRef, reply);
      if (!merchantId) return;
      const body = request.body as Record<string, unknown>;
      const feePct = parseFeePercentageInput(body.feePercentage as string | undefined);
      if (!feePct.ok) {
        return reply.status(400).send({ error: "Bad Request", message: feePct.message });
      }
      const [row] = await db
        .insert(merchantFeeSchedules)
        .values({
          merchantId,
          environment: body.environment as string,
          rail: body.rail as string,
          currency: String(body.currency).trim().toUpperCase(),
          feeType: body.feeType as string,
          billingMode: (body.billingMode as string) ?? "percentage_only",
          feePercentage: feePct.value,
          feeFlat: (body.feeFlat as string | undefined) ?? "0",
          feeMin: (body.feeMin as string | undefined) ?? "0",
          feeMax: (body.feeMax as string | null | undefined) ?? null,
          effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom as string) : new Date(),
          effectiveTo: body.effectiveTo ? new Date(body.effectiveTo as string) : null,
          status: "active",
        })
        .returning();
      if (!row) throw new Error("Failed to create fee schedule");
      providerMerchantAudit(request, {
        action: "provider.merchant.fee_schedule_changed",
        merchantId,
        meta: { scheduleId: row.id, rail: row.rail, currency: row.currency, feeType: row.feeType },
      });
      return reply.status(201).send({
        id: row.id,
        environment: row.environment as (typeof ENV)[number],
        rail: row.rail as (typeof FEE_RAIL)[number],
        currency: row.currency,
        feeType: row.feeType as (typeof FEE_TYPE)[number],
        billingMode: row.billingMode,
        feePercentage: row.feePercentage != null ? String(row.feePercentage) : null,
        feeFlat: row.feeFlat != null ? String(row.feeFlat) : null,
        feeMin: row.feeMin != null ? String(row.feeMin) : null,
        feeMax: row.feeMax != null ? String(row.feeMax) : null,
        effectiveFrom: row.effectiveFrom.toISOString(),
        effectiveTo: row.effectiveTo?.toISOString() ?? null,
        status: row.status,
      });
    }
  );

  app.get(
    "/provider/merchants/:merchantId/api-ip-rules",
    {
      schema: {
        params: z.object({ merchantId: merchantRefParamSchema }),
        querystring: z.object({ environment: z.enum(ENV) }),
        response: {
          200: z.object({
            merchantId: z.string(),
            environment: z.enum(ENV),
            enabled: z.boolean(),
            enforceMode: z.string(),
            cidrs: z.array(z.string()),
            notes: z.string().nullable(),
            updatedBy: z.string().nullable(),
            updatedAt: z.string().nullable(),
          }),
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensurePermission(request, reply, "merchant.ip_whitelist.read")) return;
      const { merchantId: merchantRef } = request.params as { merchantId: string };
      const merchantId = await ensureMerchantFromRef(merchantRef, reply);
      if (!merchantId) return;
      const { environment } = request.query as { environment: (typeof ENV)[number] };
      return getMerchantApiIpRules(merchantId, environment);
    }
  );

  app.put(
    "/provider/merchants/:merchantId/api-ip-rules",
    {
      schema: {
        params: z.object({ merchantId: merchantRefParamSchema }),
        body: z.object({
          environment: z.enum(ENV),
          enabled: z.boolean(),
          enforceMode: z.enum(["strict", "log_only"]).default("strict"),
          cidrs: z.array(z.string()),
          notes: z.string().optional().nullable(),
        }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensurePermission(request, reply, "merchant.ip_whitelist.write")) return;
      if (!(await requireProviderStepUp(request, reply, "merchant.ip_whitelist.write"))) return;
      const { merchantId: merchantRef } = request.params as { merchantId: string };
      const merchantId = await ensureMerchantFromRef(merchantRef, reply);
      if (!merchantId) return;
      const body = request.body as {
        environment: (typeof ENV)[number];
        enabled: boolean;
        enforceMode: "strict" | "log_only";
        cidrs: string[];
        notes?: string | null;
      };
      const actor = request.provider?.email ?? request.provider?.providerUserId ?? "provider";
      const result = await upsertMerchantApiIpRules({
        merchantId,
        updatedBy: actor,
        rules: body,
      });
      if (!result.ok) {
        return reply.status(400).send({
          error: "Bad Request",
          message: result.message,
        });
      }
      providerMerchantAudit(request, {
        action: "provider.merchant.ip_whitelist_changed",
        merchantId,
        meta: { environment: body.environment, enabled: body.enabled, cidrCount: body.cidrs.length },
      });
      return { ok: true as const };
    }
  );

  const feeLineSchema = z.object({
    id: z.string(),
    source: z.enum(["schedule", "legacy"]),
    environment: z.union([z.enum(ENV), z.literal("legacy")]),
    rail: z.string(),
    currency: z.string(),
    feeType: z.enum(FEE_TYPE),
    billingMode: z.string(),
    feePercentage: z.string().nullable(),
    feeFlat: z.string().nullable(),
    feeMin: z.string().nullable(),
    feeMax: z.string().nullable(),
    effectiveFrom: z.string().nullable(),
    effectiveTo: z.string().nullable(),
    status: z.string(),
  });

  app.get(
    "/provider/merchants/:merchantId/pricing/overview",
    {
      schema: {
        params: z.object({ merchantId: merchantRefParamSchema }),
        response: {
          200: z.object({
            legacy: z.object({
              billingMode: z.string(),
              feePercentagePayin: z.string().nullable(),
              feePercentagePayout: z.string().nullable(),
              feeMinPayin: z.string().nullable(),
              feeMaxPayin: z.string().nullable(),
              feeMinPayout: z.string().nullable(),
              feeMaxPayout: z.string().nullable(),
              monthlyAmount: z.string().nullable(),
            }),
            feeSchedules: z.array(feeLineSchema),
            pendingAdjustments: z.object({
              count: z.number(),
              items: z.array(
                z.object({
                  id: z.string(),
                  actionType: z.string(),
                  status: z.string(),
                  resourceType: z.string(),
                  resourceId: z.string(),
                  riskLevel: z.string(),
                  direction: z.string().nullable(),
                  amount: z.string().nullable(),
                  reason: z.string().nullable(),
                  ticketId: z.string().nullable(),
                  requestedBy: z.string().nullable(),
                  createdAt: z.string(),
                  reviewPath: z.string(),
                })
              ),
            }),
            recentPricingActions: z.array(
              z.object({
                id: z.string(),
                action: z.string(),
                resource: z.string().nullable(),
                actorEmail: z.string().nullable(),
                createdAt: z.string(),
              })
            ),
            links: z.object({
              legacyPricing: z.string(),
              feeSchedules: z.string(),
              createFeeSchedule: z.string(),
              approvals: z.string(),
              merchantWalletAdjust: z.string(),
            }),
          }),
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensurePermission(request, reply, "merchant.pricing.read")) return;
      const { merchantId: merchantRef } = request.params as { merchantId: string };
      const merchantId = await ensureMerchantFromRef(merchantRef, reply);
      if (!merchantId) return;
      return buildAdminPricingOverview(merchantId);
    }
  );
}
