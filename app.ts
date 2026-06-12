import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import Fastify, { type FastifyRequest, type FastifyReply, type FastifyError } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import compress from "@fastify/compress";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { sql, eq, and, count, desc } from "drizzle-orm";
import { db } from "./src/db/index.js";
import { getRedis } from "./src/lib/redis.js";
import {
  getAuthLoginRateLimitConfig,
  getWebhookRateLimitConfig,
  isAuthRateLimitPath,
  isWebhookRoutePath,
} from "./src/lib/security-config.js";
import { logSecurityEvent } from "./src/lib/security-events.js";
import {
  computeDedupeHash,
  markWebhookFailed,
  markWebhookProcessed,
  tryClaimWebhookEvent,
} from "./src/lib/webhook-events.js";
import { withIdempotency } from "./src/lib/idempotency.js";
import {
  merchantPayoutRecipientSchema,
  parsePayoutRecipientFromMetadata,
} from "./src/lib/merchant-payout-recipient.js";
import {
  wallets,
  transactions,
  merchants,
  merchantBusinessProfiles,
  merchantPersons,
  merchantKycDocuments,
} from "./src/db/schema/index.js";
import { apiKeyAuth } from "./src/lib/auth.js";
import { merchantAuth } from "./src/lib/merchant-auth.js";
import { portalAuth } from "./src/lib/portal-auth.js";
import { providerAuth } from "./src/lib/provider-auth.js";
import { registerPortalRoutes } from "./api/portal/index.js";
import { registerProviderRoutes } from "./api/provider/index.js";
import { registerProviderAuthRoutes } from "./api/provider/auth.js";
import {
  createPayinOrder,
  handlePayinCallback,
  createPayoutOrder,
  handlePayoutCallback,
  getPayokCallbackPublicKeys,
  verifyPayokCallbackWithFallbacks,
  verifyPayokCallbackWithFallbacksDebug,
} from "./services/domestic/bangladesh/index.js";
import {
  applyTyltWebhookByProductRoute,
  applyTyltWebhookByStoredRailProduct,
  extractTyltWebhookMerchantOrderId,
  isTyltManualSettlementSuccessWebhook,
  parseCrossRampEventId,
  readTyltWebhookSignatureHeader,
  verifyTyltWebhookSignature,
  type TyltWebhookCredentialMode,
  cpgGetPayinTransactionHistory,
  cpgGetPayinTransactionInformation,
  cpgGetPayoutTransactionHistory,
  cpgGetPayoutTransactionInformation,
  createTyltCpgPayinRequest,
  createTyltCpgPayoutRequest,
  executeTyltInternalTransfer,
  createTyltH2hPayinInstance,
  getMerchantH2hPayinStatus,
  isTyltCpgPayinMetadata,
  isTyltCpgPayoutMetadata,
  isTyltH2hPayinMetadata,
  parseTransactionMetadata,
  tyltH2hBuyerConfirmsPayment,
  tyltH2hGetCryptoCurrencyListForPrime,
  tyltH2hGetMerchantRampSpecialRates,
  tyltH2hGetPaymentMethodsP2pOnRamp,
  pickTyltJsonPrimaryMessage,
  tyltGetAccountBalance,
  tyltGetMerchantDetails,
  tyltGetSupportedBaseCurrenciesList,
  tyltGetSupportedCryptoCurrenciesList,
  tyltGetSupportedCryptoNetworksList,
  tyltGetSupportedFiatCurrenciesList,
  createTyltEurPayinInstance,
  createTyltEurPayoutInstance,
  approveTyltEurPayout,
  getMerchantEurPayinStatus,
  getMerchantEurPayoutStatus,
  isTyltEurPayoutMetadata,
} from "./services/integrations/tylt/index.js";
import { LIMITS } from "./src/lib/limits.js";
import {
  createCustomerWallet,
  transferToCustomer,
} from "./services/operations/transfers.js";
import { sumPendingPayinAmountsByCurrency } from "./src/lib/merchant-pending-balance.js";
import {
  assertMerchantMarketApiAccess,
  type MerchantMarket,
} from "./src/lib/merchant-markets.js";
import {
  limitsForMerchantWalletCurrency,
  portalWalletBalanceItemSchema,
  presentPortalWalletBalanceItem,
} from "./src/lib/portal-wallet-balance.js";
import { presentTransactionRail } from "./src/lib/transaction-rail-label.js";
import { validateMerchantReturnUrl } from "./src/lib/merchant-return-url.js";
import { queueMerchantWebhook, type WebhookEvent } from "./src/lib/merchant-webhook.js";
import { encrypt, getSecret } from "./src/lib/encryption.js";
import { pingRedis } from "./src/lib/redis.js";
import { recordHttpRequest, renderMetrics, getMetricsContentType } from "./src/lib/metrics.js";
import { registerProviderMfaRoutes } from "./api/provider/mfa.js";
import { merchantPaymentFlowErrorResponse, sendMerchantFacingReply } from "./src/lib/merchant-facing-errors.js";
import {
  merchantApiErrorResponse as errorResponse,
  merchantApiFacingError as merchantFacingError,
} from "./src/lib/merchant-api-zod.js";
import {
  tyltMerchantProxyResponses,
  tyltPassthroughQuerySchema,
  tyltRowsPageQuerySchema,
  tyltTransactionIdParamSchema,
} from "./src/lib/tylt-merchant-api-schemas.js";

export async function buildApp() {
  /** Avoid duplicate 5xx logs when Fastify's error handler already logged the thrown error. */
  const serverErrorHandledByErrorHandler = new WeakSet<FastifyRequest>();

  const isProduction = process.env.NODE_ENV === "production";
  const debugBodyEnvSet = process.env.PAYOK_WEBHOOK_DEBUG_BODY === "1";
  const allowDebugBody = debugBodyEnvSet && !isProduction;
  const debugTyltWebhookBodyEnvSet = process.env.TYLT_WEBHOOK_DEBUG_BODY === "1";
  const allowTyltWebhookDebugBody = debugTyltWebhookBodyEnvSet && !isProduction;
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-api-key"]',
          'req.headers["x-portal-token"]',
          'req.headers["x-provider-token"]',
          'req.headers["x-transacty-key"]',
          'req.headers["x-transacty-signature"]',
          'req.headers.sign',
          'req.headers.Sign',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          '*.password',
          '*.token',
          '*.secret',
          '*.rawBody',
          '*.signature',
          '*.authorization',
          '*.accessToken',
          '*.refreshToken',
          '*.apiKey',
          '*.privateKey',
          '*.webhookSecret',
        ],
        censor: "[REDACTED]",
      },
    },
    genReqId: (req) => {
      const x = req.headers["x-request-id"];
      if (typeof x === "string" && x.trim()) return x.trim();
      return randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();

  if (debugBodyEnvSet && isProduction) {
    app.log.warn(
      "PAYOK_WEBHOOK_DEBUG_BODY is set but NODE_ENV=production; raw-body diagnostics suppressed for security."
    );
  }
  if (debugTyltWebhookBodyEnvSet && isProduction) {
    app.log.warn(
      "TYLT_WEBHOOK_DEBUG_BODY is set but NODE_ENV=production; raw-body diagnostics suppressed for security."
    );
  } else if (debugTyltWebhookBodyEnvSet) {
    app.log.warn("TYLT_WEBHOOK_DEBUG_BODY=1: full TL Pay webhook payloads will be logged.");
  }

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler(async (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const statusCode =
      typeof error.statusCode === "number" && error.statusCode >= 100 && error.statusCode <= 599
        ? error.statusCode
        : 500;
    const path = request.url.split("?")[0];
    const routeTemplate =
      request.routeOptions?.method != null && request.routeOptions?.url != null
        ? `${String(request.routeOptions.method)} ${String(request.routeOptions.url)}`
        : undefined;

    const meta = {
      statusCode,
      method: request.method,
      path,
      route: routeTemplate,
      message: error.message,
      code: typeof error.code === "string" ? error.code : undefined,
      validation: error.validation,
      reqId: request.id,
    };

    if (statusCode >= 500) {
      serverErrorHandledByErrorHandler.add(request);
      request.log.error({ err: error, ...meta }, `server error: ${request.method} ${path}`);
    } else if (statusCode >= 400) {
      request.log.warn({ err: error, ...meta }, `client error: ${request.method} ${path}`);
    } else {
      request.log.info({ err: error, ...meta }, `request error: ${request.method} ${path}`);
    }

    await reply.send(error);
  });

  app.addHook("onRequest", async (request) => {
    (request as FastifyRequest & { metricsStart?: bigint }).metricsStart = process.hrtime.bigint();
  });

  app.addHook("onResponse", async (request, reply) => {
    const path = request.url.split("?")[0];
    const status = reply.statusCode;
    if (status >= 500 && !serverErrorHandledByErrorHandler.has(request)) {
      const routeTemplate =
        request.routeOptions?.method != null && request.routeOptions?.url != null
          ? `${String(request.routeOptions.method)} ${String(request.routeOptions.url)}`
          : undefined;
      request.log.error(
        {
          statusCode: status,
          method: request.method,
          path,
          route: routeTemplate,
          reqId: request.id,
        },
        `5xx response (no route throw): ${request.method} ${path}${routeTemplate ? ` => ${routeTemplate}` : ""}`
      );
    }
    if (path === "/metrics" || path === "/health") return;
    const start = (request as FastifyRequest & { metricsStart?: bigint }).metricsStart;
    if (start == null) return;
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    recordHttpRequest({ request, reply, durationSeconds: seconds });
  });

  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    const raw = typeof body === "string" ? body : body?.toString("utf8") ?? "";
    (req as FastifyRequest & { rawBody?: string }).rawBody = raw;
    try {
      done(null, raw ? JSON.parse(raw) : {});
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  // Capture raw body for Payok webhooks (any content-type) for signature verification
  app.addHook("preParsing", async (request, _reply, payload) => {
    const path = request.url.split("?")[0];
    if (!path.startsWith("/webhooks/payok/") && !path.startsWith("/webhooks/tylt/")) return payload;
    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    (request as FastifyRequest & { rawBody?: string }).rawBody = raw;
    return Readable.from(Buffer.concat(chunks));
  });

  await app.register(helmet, { global: true });
  // Rate limit: prefer Redis when configured so all instances share the
  // same counter window. Falls back to in-memory if Redis is unavailable.
  const rateLimitRedis = (() => {
    try {
      return getRedis();
    } catch {
      return null;
    }
  })();
  const rateLimitMaxRaw = Number(process.env.RATE_LIMIT_MAX);
  const rateLimitMax =
    Number.isFinite(rateLimitMaxRaw) && rateLimitMaxRaw > 0
      ? Math.floor(rateLimitMaxRaw)
      : 100;
  const rateLimitWindow = process.env.RATE_LIMIT_WINDOW?.trim() || "1 minute";
  await app.register(rateLimit, {
    max: rateLimitMax,
    timeWindow: rateLimitWindow,
    nameSpace: "tx-rl:",
    continueExceeding: true,
    onExceeded: (request) => {
      const path = request.url.split("?")[0];
      const event =
        isAuthRateLimitPath(path) ? "auth.login_rate_limited" : "rate_limit.exceeded";
      logSecurityEvent(event, { path, method: request.method });
    },
    // When Redis is configured but unreachable, ioredis throws before /health can run;
    // skipOnError lets requests through (no distributed limit until Redis is back).
    ...(rateLimitRedis ? { redis: rateLimitRedis as never, skipOnError: true } : {}),
  });
  app.addHook("onRoute", (routeOptions) => {
    const path = routeOptions.url;
    if (typeof path !== "string") return;
    const baseConfig =
      typeof routeOptions.config === "object" && routeOptions.config !== null
        ? routeOptions.config
        : {};

    if (isWebhookRoutePath(path)) {
      routeOptions.config = {
        ...baseConfig,
        rateLimit: getWebhookRateLimitConfig(),
      };
      return;
    }

    if (isAuthRateLimitPath(path)) {
      routeOptions.config = {
        ...baseConfig,
        rateLimit: getAuthLoginRateLimitConfig(),
      };
    }
  });
  app.log.info(
    {
      store: rateLimitRedis ? "redis" : "memory",
      max: rateLimitMax,
      window: rateLimitWindow,
      webhookLimit: getWebhookRateLimitConfig(),
      authLoginLimit: getAuthLoginRateLimitConfig(),
    },
    "rate-limit configured"
  );
  await app.register(compress, { global: true });
  const corsAllowedOrigins = new Set<string>([
    "https://transacty-admin.vercel.app",
    "https://dashboard.transacty.ai",
    "http://localhost:3000",
    "http://localhost:5173",
  ]);
  const corsExtra = process.env.CORS_ALLOWED_ORIGINS?.split(",")
    .map((v) => v.trim().replace(/\/$/, ""))
    .filter(Boolean) ?? [];
  for (const origin of corsExtra) {
    corsAllowedOrigins.add(origin);
  }
  if (corsExtra.length > 0) {
    app.log.info(
      { extraOrigins: corsExtra.length },
      "CORS: merged CORS_ALLOWED_ORIGINS into allowlist (merchant/provider SPAs must be listed or preflight returns 404)"
    );
  }

  /** Same primary domain as API (e.g. dashboard vs www vs apex). */
  function isTransactyAiOrigin(originUrl: string): boolean {
    try {
      const u = new URL(originUrl);
      const host = u.hostname.toLowerCase();
      if (u.protocol !== "https:") return false;
      return host === "transacty.ai" || host.endsWith(".transacty.ai");
    } catch {
      return false;
    }
  }

  function isAllowedCorsOrigin(origin: string): boolean {
    const normalized = origin.trim().replace(/\/$/, "");
    if (corsAllowedOrigins.has(normalized)) return true;
    if (isTransactyAiOrigin(normalized)) return true;
    return false;
  }

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const normalized = origin.trim().replace(/\/$/, "");
      cb(null, isAllowedCorsOrigin(normalized));
    },
  });

  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?")[0];
    if (path === "/" || path === "/health" || path === "/metrics") return;
    if (path.startsWith("/webhooks/payok/") || path.startsWith("/webhooks/tylt/")) return;
    if (
      path === "/portal/auth/signup" ||
      path === "/portal/auth/login" ||
      path === "/portal/auth/logout" ||
      path === "/portal/auth/forgot-password" ||
      path === "/portal/auth/reset-password" ||
      path === "/portal/auth/mfa/verify"
    ) {
      return;
    }
    if (
      path === "/provider/auth/login" ||
      path === "/provider/auth/logout" ||
      path === "/provider/auth/forgot-password" ||
      path === "/provider/auth/reset-password" ||
      path === "/provider/auth/mfa/verify"
    ) {
      return;
    }
    if (path.startsWith("/portal/")) return portalAuth(request, reply);
    if (path.startsWith("/provider/")) return providerAuth(request, reply);
    if (path.startsWith("/v1/")) return merchantAuth(request, reply);
    return apiKeyAuth(request, reply);
  });

  await registerPortalRoutes(app);
  await registerProviderAuthRoutes(app);
  await registerProviderMfaRoutes(app);
  await registerProviderRoutes(app);

  app.get(
    "/health",
    {
      schema: {
        response: {
          200: z.object({
            status: z.literal("ok"),
            timestamp: z.string(),
            database: z.literal("connected"),
            redis: z.enum(["ok", "skipped", "error"]).optional(),
          }),
        },
      },
    },
    async () => {
      const hasRedis = !!getSecret("REDIS_URL", "REDIS_URL_ENC")?.trim();
      const [, redisPingOk] = await Promise.all([
        db.execute(sql`SELECT 1`),
        hasRedis ? pingRedis() : Promise.resolve<boolean | null>(null),
      ]);
      const redis: "ok" | "skipped" | "error" = !hasRedis
        ? "skipped"
        : redisPingOk
          ? "ok"
          : "error";
      return {
        status: "ok" as const,
        timestamp: new Date().toISOString(),
        database: "connected" as const,
        redis,
      };
    }
  );

  app.get("/metrics", async (request, reply) => {
    const token = process.env.METRICS_TOKEN?.trim();
    if (token) {
      const auth = request.headers.authorization;
      const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;
      if (bearer !== token) {
        return reply.status(401).type("text/plain").send("Unauthorized");
      }
    } else if (process.env.NODE_ENV === "production") {
      return reply.status(404).send({ error: "Not Found", message: "Set METRICS_TOKEN to expose /metrics in production" });
    }
    reply.header("Content-Type", getMetricsContentType());
    return reply.send(await renderMetrics());
  });

  app.get(
    "/",
    {
      schema: {
        response: {
          200: z.object({
            name: z.string(),
            version: z.string(),
          }),
        },
      },
    },
    async () => ({
      name: "transacty",
      version: "0.1.0",
    })
  );

  app.get(
    "/v1/me",
    {
      schema: {
        response: {
          200: z.object({
            merchantId: z.string(),
            scopes: z.array(z.string()),
            environment: z.string(),
          }),
        },
      },
    },
    async (request) => {
      const m = request.merchant;
      if (!m) throw new Error("Not authenticated");
      return {
        merchantId: m.merchantId,
        scopes: m.scopes,
        environment: m.environment,
      };
    }
  );

  app.patch(
    "/v1/me/webhook",
    {
      schema: {
        body: z.object({ webhookUrl: z.string().url().optional().nullable() }),
        response: {
          200: z.object({
            webhookUrl: z.string().nullable(),
            webhookSecret: z.string().optional(),
          }),
          401: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      const body = request.body as { webhookUrl?: string | null };
      const masterKey = process.env.ENCRYPTION_MASTER_KEY;
      if (!masterKey) return reply.status(500).send({ error: "Internal", message: "Webhook config unavailable" });
      const url = body.webhookUrl === null || body.webhookUrl === "" ? null : body.webhookUrl?.trim() ?? null;
      const webhookSecret = url ? randomBytes(32).toString("hex") : null;
      const webhookSecretEnc = webhookSecret ? encrypt(webhookSecret, masterKey) : null;
      await db
        .update(merchants)
        .set({
          webhookUrl: url,
          webhookSecretEnc,
          updatedAt: new Date(),
        })
        .where(eq(merchants.id, m.merchantId));
      return {
        webhookUrl: url,
        ...(webhookSecret && { webhookSecret }),
      };
    }
  );

  app.get(
    "/v1/me/kyc",
    {
      schema: {
        response: {
          200: z.object({
            status: z.string(),
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
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      const [merchant] = await db.select({ kycStatus: merchants.kycStatus }).from(merchants).where(eq(merchants.id, m.merchantId)).limit(1);
      const [profile] = await db
        .select({
          id: merchantBusinessProfiles.id,
          legalName: merchantBusinessProfiles.legalName,
          tradingName: merchantBusinessProfiles.tradingName,
          businessType: merchantBusinessProfiles.businessType,
          status: merchantBusinessProfiles.status,
        })
        .from(merchantBusinessProfiles)
        .where(eq(merchantBusinessProfiles.merchantId, m.merchantId))
        .limit(1);
      const [personsCount] = await db
        .select({ count: count() })
        .from(merchantPersons)
        .where(eq(merchantPersons.merchantId, m.merchantId));
      const [documentsCount] = await db
        .select({ count: count() })
        .from(merchantKycDocuments)
        .where(eq(merchantKycDocuments.merchantId, m.merchantId));
      return {
        status: merchant?.kycStatus ?? "pending",
        businessProfile: profile
          ? {
              id: profile.id,
              legalName: profile.legalName,
              tradingName: profile.tradingName,
              businessType: profile.businessType,
              status: profile.status,
            }
          : null,
        personsCount: Number(personsCount?.count ?? 0),
        documentsCount: Number(documentsCount?.count ?? 0),
      };
    }
  );

  app.put(
    "/v1/me/kyc/business",
    {
      schema: {
        body: z.object({
          legalName: z.string().min(1),
          tradingName: z.string().optional(),
          businessType: z.string().min(1),
          registrationNumber: z.string().optional(),
          incorporationDate: z.string().datetime().optional(),
          industry: z.string().optional(),
          registeredAddress: z.string().min(1),
          operatingAddress: z.string().optional(),
          taxId: z.string().optional(),
          contactPhone: z.string().min(1),
          contactEmail: z.string().email(),
        }),
        response: {
          200: z.object({
            id: z.string(),
            status: z.string(),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      const body = request.body as {
        legalName: string;
        tradingName?: string;
        businessType: string;
        registrationNumber?: string;
        incorporationDate?: string;
        industry?: string;
        registeredAddress: string;
        operatingAddress?: string;
        taxId?: string;
        contactPhone: string;
        contactEmail: string;
      };
      const [existing] = await db
        .select()
        .from(merchantBusinessProfiles)
        .where(eq(merchantBusinessProfiles.merchantId, m.merchantId))
        .limit(1);
      const data = {
        legalName: body.legalName,
        tradingName: body.tradingName ?? null,
        businessType: body.businessType,
        registrationNumber: body.registrationNumber ?? null,
        incorporationDate: body.incorporationDate ? new Date(body.incorporationDate) : null,
        industry: body.industry ?? null,
        registeredAddress: body.registeredAddress,
        operatingAddress: body.operatingAddress ?? null,
        taxId: body.taxId ?? null,
        contactPhone: body.contactPhone,
        contactEmail: body.contactEmail,
        updatedAt: new Date(),
      };
      if (existing) {
        await db.update(merchantBusinessProfiles).set(data).where(eq(merchantBusinessProfiles.id, existing.id));
        return { id: existing.id, status: existing.status };
      }
      const [inserted] = await db
        .insert(merchantBusinessProfiles)
        .values({
          merchantId: m.merchantId,
          ...data,
        })
        .returning({ id: merchantBusinessProfiles.id, status: merchantBusinessProfiles.status });
      return { id: inserted!.id, status: inserted!.status };
    }
  );

  app.post(
    "/v1/me/kyc/persons",
    {
      schema: {
        body: z.object({
          role: z.enum(["director", "ubo", "authorized_signatory"]),
          fullName: z.string().min(1),
          nationality: z.string().min(1),
          dateOfBirth: z.string().datetime().optional(),
          idType: z.enum(["nid", "passport"]),
          idNumber: z.string().min(1),
          address: z.string().min(1),
          ownershipPercentage: z.number().min(0).max(100).optional(),
        }),
        response: {
          200: z.object({ id: z.string() }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      const body = request.body as {
        role: "director" | "ubo" | "authorized_signatory";
        fullName: string;
        nationality: string;
        dateOfBirth?: string;
        idType: "nid" | "passport";
        idNumber: string;
        address: string;
        ownershipPercentage?: number;
      };
      const [inserted] = await db
        .insert(merchantPersons)
        .values({
          merchantId: m.merchantId,
          role: body.role,
          fullName: body.fullName,
          nationality: body.nationality,
          dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : null,
          idType: body.idType,
          idNumber: body.idNumber,
          address: body.address,
          ownershipPercentage: body.ownershipPercentage != null ? String(body.ownershipPercentage) : null,
        })
        .returning({ id: merchantPersons.id });
      return { id: inserted!.id };
    }
  );

  app.get(
    "/v1/me/kyc/persons",
    {
      schema: {
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                role: z.string(),
                fullName: z.string(),
                status: z.string(),
              })
            ),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      const rows = await db
        .select({
          id: merchantPersons.id,
          role: merchantPersons.role,
          fullName: merchantPersons.fullName,
          status: merchantPersons.status,
        })
        .from(merchantPersons)
        .where(eq(merchantPersons.merchantId, m.merchantId));
      return {
        items: rows.map((r) => ({ id: r.id, role: r.role, fullName: r.fullName, status: r.status })),
      };
    }
  );

  app.post(
    "/v1/me/kyc/documents",
    {
      schema: {
        body: z.object({
          documentType: z.string().min(1),
          fileReference: z.string().min(1),
          documentNumber: z.string().optional(),
          merchantPersonId: z.string().uuid().optional(),
        }),
        response: {
          200: z.object({ id: z.string() }),
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      const body = request.body as { documentType: string; fileReference: string; documentNumber?: string; merchantPersonId?: string };
      if (body.merchantPersonId) {
        const [person] = await db
          .select()
          .from(merchantPersons)
          .where(and(eq(merchantPersons.id, body.merchantPersonId), eq(merchantPersons.merchantId, m.merchantId)))
          .limit(1);
        if (!person) return reply.status(400).send({ error: "Invalid merchantPersonId" });
      }
      const [inserted] = await db
        .insert(merchantKycDocuments)
        .values({
          merchantId: m.merchantId,
          documentType: body.documentType,
          fileReference: body.fileReference,
          documentNumber: body.documentNumber ?? null,
          merchantPersonId: body.merchantPersonId ?? null,
        })
        .returning({ id: merchantKycDocuments.id });
      return { id: inserted!.id };
    }
  );

  app.get(
    "/v1/me/kyc/documents",
    {
      schema: {
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                documentType: z.string(),
                status: z.string(),
                submittedAt: z.string(),
              })
            ),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      const rows = await db
        .select({
          id: merchantKycDocuments.id,
          documentType: merchantKycDocuments.documentType,
          status: merchantKycDocuments.status,
          submittedAt: merchantKycDocuments.submittedAt,
        })
        .from(merchantKycDocuments)
        .where(eq(merchantKycDocuments.merchantId, m.merchantId));
      return {
        items: rows.map((r) => ({
          id: r.id,
          documentType: r.documentType,
          status: r.status,
          submittedAt: r.submittedAt.toISOString(),
        })),
      };
    }
  );

  app.post(
    "/v1/me/kyc/submit",
    {
      schema: {
        response: {
          200: z.object({ status: z.string() }),
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      const [profile] = await db
        .select()
        .from(merchantBusinessProfiles)
        .where(eq(merchantBusinessProfiles.merchantId, m.merchantId))
        .limit(1);
      if (!profile) return reply.status(400).send({ error: "Business profile required before submit" });
      if (profile.status === "verified") return reply.status(400).send({ error: "Already verified" });
      await db
        .update(merchantBusinessProfiles)
        .set({ status: "submitted", updatedAt: new Date() })
        .where(eq(merchantBusinessProfiles.id, profile.id));
      return { status: "submitted" };
    }
  );

  const PAYIN_WEBHOOK_PATH = "/webhooks/payok/payin";
  const PAYOUT_WEBHOOK_PATH = "/webhooks/payok/payout";
  const baseUrl = process.env.APP_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
  const base = baseUrl.replace(/\/$/, "");
  const fullPayinUrl = `${base}${PAYIN_WEBHOOK_PATH}`;
  const fullPayoutUrl = `${base}${PAYOUT_WEBHOOK_PATH}`;
  // Doc: Plaintext = {json_body}&{endpoint_path}. Try path, full URL, variants, Payok internal path.
  const payinPathCandidates = [
    PAYIN_WEBHOOK_PATH,
    fullPayinUrl,
    PAYIN_WEBHOOK_PATH.slice(1),
    `${fullPayinUrl}/`,
    "/api-pay/payment/V3.5/order/notify",
  ];
  const payoutPathCandidates = [
    PAYOUT_WEBHOOK_PATH,
    fullPayoutUrl,
    PAYOUT_WEBHOOK_PATH.slice(1),
    `${fullPayoutUrl}/`,
    "/api-pay/remit/V3.5/order/notify",
  ];

  const debugWebhookBody = allowDebugBody;

  app.post(PAYIN_WEBHOOK_PATH, async (request, reply) => {
    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? "";
    const sign = (request.headers.sign ?? request.headers.Sign) as string | undefined;
    const callbackPublicKeys = getPayokCallbackPublicKeys();
    const verifyDebug =
      !!sign && debugWebhookBody
        ? callbackPublicKeys
            .map((key) => verifyPayokCallbackWithFallbacksDebug(rawBody, payinPathCandidates, sign, key))
            .find((d) => d.verified) ?? null
        : null;
    const verified =
      !!sign &&
      (verifyDebug?.verified ??
        callbackPublicKeys.some((key) => verifyPayokCallbackWithFallbacks(rawBody, payinPathCandidates, sign, key)));
    if (!verified) {
      const debugPayload: Record<string, unknown> = {
        hasSign: !!sign,
        rawBodyLen: rawBody.length,
        contentType: request.headers["content-type"],
        path: PAYIN_WEBHOOK_PATH,
        pathCandidates: payinPathCandidates,
      };
      if (debugWebhookBody) {
        debugPayload.rawBody = rawBody;
        debugPayload.signHeaderPrefix = sign ? sign.slice(0, 60) + "..." : null;
        debugPayload.verifyDiagnostics = verifyDebug?.diagnostics ?? null;
      }
      app.log.warn(debugPayload, "payin webhook 401: invalid signature");
      logSecurityEvent("webhook.signature_rejected", { path: PAYIN_WEBHOOK_PATH, rail: "payok-bd-payin" });
      return reply.status(401).send("Invalid signature");
    }
    if (debugWebhookBody && verifyDebug?.match) {
      app.log.info(
        {
          path: PAYIN_WEBHOOK_PATH,
          signatureMatch: verifyDebug.match,
          verifyDiagnostics: verifyDebug.diagnostics,
        },
        "payin webhook signature matched"
      );
    }
    const body = typeof request.body === "object" ? request.body : {};
    const externalIdGuess =
      typeof (body as Record<string, unknown>).platformOrderId === "string"
        ? ((body as Record<string, unknown>).platformOrderId as string)
        : null;
    const claim = await tryClaimWebhookEvent({
      rail: "payok-bd-payin",
      environment: "unknown",
      rawBody,
      signature: sign ?? null,
      signatureValid: true,
      externalId: externalIdGuess,
    });
    if (claim.kind === "duplicate") {
      app.log.info(
        { rail: "payok-bd-payin", eventId: claim.eventId, status: claim.previousStatus },
        "payin webhook duplicate (replay absorbed by webhook_events)"
      );
      return reply.type("text/plain").send("SUCCESS");
    }
    try {
      const webhook = await handlePayinCallback(body as Parameters<typeof handlePayinCallback>[0]);
      await markWebhookProcessed(claim.eventId, {
        transactionId: webhook?.event?.transactionId ?? null,
      });
      if (webhook) {
        queueMerchantWebhook(webhook.merchantId, webhook.event).catch((e) => app.log.warn(e, "Merchant webhook queue failed"));
      }
    } catch (err) {
      await markWebhookFailed(claim.eventId, err).catch(() => {});
      app.log.error(err);
      return reply.status(500).send("INTERNAL");
    }
    return reply.type("text/plain").send("SUCCESS");
  });

  app.post(PAYOUT_WEBHOOK_PATH, async (request, reply) => {
    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? "";
    const sign = (request.headers.sign ?? request.headers.Sign) as string | undefined;
    const callbackPublicKeys = getPayokCallbackPublicKeys();
    const verifyDebug =
      !!sign && debugWebhookBody
        ? callbackPublicKeys
            .map((key) => verifyPayokCallbackWithFallbacksDebug(rawBody, payoutPathCandidates, sign, key))
            .find((d) => d.verified) ?? null
        : null;
    const verified =
      !!sign &&
      (verifyDebug?.verified ??
        callbackPublicKeys.some((key) => verifyPayokCallbackWithFallbacks(rawBody, payoutPathCandidates, sign, key)));
    if (!verified) {
      const debugPayload: Record<string, unknown> = {
        hasSign: !!sign,
        rawBodyLen: rawBody.length,
        contentType: request.headers["content-type"],
        path: PAYOUT_WEBHOOK_PATH,
        pathCandidates: payoutPathCandidates,
      };
      if (debugWebhookBody) {
        debugPayload.rawBody = rawBody;
        debugPayload.signHeaderPrefix = sign ? sign.slice(0, 60) + "..." : null;
        debugPayload.verifyDiagnostics = verifyDebug?.diagnostics ?? null;
      }
      app.log.warn(debugPayload, "payout webhook 401: invalid signature");
      logSecurityEvent("webhook.signature_rejected", { path: PAYOUT_WEBHOOK_PATH, rail: "payok-bd-payout" });
      return reply.status(401).send("Invalid signature");
    }
    if (debugWebhookBody && verifyDebug?.match) {
      app.log.info(
        {
          path: PAYOUT_WEBHOOK_PATH,
          signatureMatch: verifyDebug.match,
          verifyDiagnostics: verifyDebug.diagnostics,
        },
        "payout webhook signature matched"
      );
    }
    const body = typeof request.body === "object" ? request.body : {};
    const externalIdGuess =
      typeof (body as Record<string, unknown>).platformOrderId === "string"
        ? ((body as Record<string, unknown>).platformOrderId as string)
        : null;
    const claim = await tryClaimWebhookEvent({
      rail: "payok-bd-payout",
      environment: "unknown",
      rawBody,
      signature: sign ?? null,
      signatureValid: true,
      externalId: externalIdGuess,
    });
    if (claim.kind === "duplicate") {
      app.log.info(
        { rail: "payok-bd-payout", eventId: claim.eventId, status: claim.previousStatus },
        "payout webhook duplicate (replay absorbed by webhook_events)"
      );
      return reply.type("text/plain").send("SUCCESS");
    }
    try {
      const webhook = await handlePayoutCallback(body as Parameters<typeof handlePayoutCallback>[0]);
      await markWebhookProcessed(claim.eventId, {
        transactionId: webhook?.event?.transactionId ?? null,
      });
      if (webhook) {
        queueMerchantWebhook(webhook.merchantId, webhook.event).catch((e) => app.log.warn(e, "Merchant webhook queue failed"));
      }
    } catch (err) {
      await markWebhookFailed(claim.eventId, err).catch(() => {});
      app.log.error(err);
      return reply.status(500).send("INTERNAL");
    }
    return reply.type("text/plain").send("SUCCESS");
  });

  async function handleTyltWebhookPost(
    request: FastifyRequest,
    reply: FastifyReply,
    opts: {
      pathConstant: string;
      /** Rail label for webhook_events. Differentiates crossramp / h2h /
       * cpg-payin / cpg-payout / unified so dedupe works per-product. */
      rail: string;
      rejectLogMessage: string;
      /** Tylt signs webhooks with the secret for the matching dashboard service. */
      tyltWebhookCredential: TyltWebhookCredentialMode;
      apply: (body: unknown) => Promise<{ merchantId: string; event: WebhookEvent } | null>;
    }
  ): Promise<void> {
    const environment = (request.params as { environment?: string }).environment;
    if (environment !== "test" && environment !== "live") {
      return reply.status(404).type("text/plain").send("Not found");
    }
    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? "";
    const sig = readTyltWebhookSignatureHeader(request.headers as Record<string, string | string[] | undefined>);
    if (!verifyTyltWebhookSignature(environment, rawBody, sig, opts.tyltWebhookCredential)) {
      app.log.warn({ path: opts.pathConstant, hasSig: !!sig, rawBodyLen: rawBody.length }, opts.rejectLogMessage);
      logSecurityEvent("webhook.signature_rejected", {
        path: opts.pathConstant,
        rail: opts.rail,
        environment,
      });
      return reply.status(401).type("text/plain").send("Invalid signature");
    }
    const body = typeof request.body === "object" && request.body !== null ? request.body : {};
    const externalIdGuess = (() => {
      const root = body as Record<string, unknown>;
      for (const key of ["platformOrderId", "instanceId", "orderId", "transactionId"]) {
        const v = root[key];
        if (typeof v === "string" && v.length > 0) return v;
      }
      return null;
    })();
    const dedupeHash = computeDedupeHash(opts.rail, environment, rawBody);
    const tyltWebhookSummary = {
      rail: opts.rail,
      environment,
      dedupeHash,
      tyltEventId: parseCrossRampEventId(body),
      merchantOrderId: extractTyltWebhookMerchantOrderId(body),
      externalId: externalIdGuess,
      rawBodyLen: rawBody.length,
      ...(allowTyltWebhookDebugBody && rawBody
        ? { tyltWebhookPayload: rawBody }
        : {}),
    };

    const claim = await tryClaimWebhookEvent({
      rail: opts.rail,
      environment,
      rawBody,
      signature: typeof sig === "string" ? sig : null,
      signatureValid: true,
      externalId: externalIdGuess,
    });
    if (claim.kind === "duplicate") {
      if (!isTyltManualSettlementSuccessWebhook(body)) {
        app.log.info(
          {
            ...tyltWebhookSummary,
            webhookEventId: claim.eventId,
            claim: "duplicate",
            previousStatus: claim.previousStatus,
          },
          "tylt webhook duplicate (replay absorbed by webhook_events)"
        );
        return reply.type("text/plain").send("ok");
      }
      app.log.info(
        {
          ...tyltWebhookSummary,
          webhookEventId: claim.eventId,
          claim: "duplicate_manual_retry",
          previousStatus: claim.previousStatus,
        },
        "tylt webhook duplicate re-applying for manual settlement"
      );
    } else {
      app.log.info(
        { ...tyltWebhookSummary, webhookEventId: claim.eventId, claim: "fresh" },
        "tylt webhook received (fresh)"
      );
    }
    try {
      const webhook = await opts.apply(body);
      await markWebhookProcessed(claim.eventId, {
        transactionId: webhook?.event?.transactionId ?? null,
      });
      app.log.info(
        {
          ...tyltWebhookSummary,
          webhookEventId: claim.eventId,
          claim: claim.kind === "duplicate" ? "duplicate_manual_retry" : "fresh",
          applyResult: webhook ? "applied" : "no_op",
          transactionId: webhook?.event?.transactionId ?? null,
          merchantWebhookType: webhook?.event?.type ?? null,
        },
        webhook ? "tylt webhook applied" : "tylt webhook processed (no state change)"
      );
      if (webhook) {
        queueMerchantWebhook(webhook.merchantId, webhook.event).catch((e) =>
          app.log.warn(e, "Merchant webhook queue failed")
        );
      }
    } catch (err) {
      await markWebhookFailed(claim.eventId, err).catch(() => {});
      app.log.error(
        {
          ...tyltWebhookSummary,
          webhookEventId: claim.eventId,
          claim: "fresh",
          applyResult: "error",
          err: err instanceof Error ? err.message : String(err),
        },
        "tylt webhook apply failed"
      );
      return reply.status(500).type("text/plain").send("INTERNAL");
    }
    return reply.type("text/plain").send("ok");
  }

  const TYLT_CROSSRAMP_WEBHOOK_PATH = "/webhooks/tylt/crossramp/:environment";

  app.post(TYLT_CROSSRAMP_WEBHOOK_PATH, async (request, reply) => {
    await handleTyltWebhookPost(request, reply, {
      pathConstant: TYLT_CROSSRAMP_WEBHOOK_PATH,
      rail: "tylt-crossramp",
      rejectLogMessage: "tylt webhook rejected: invalid or missing signature",
      tyltWebhookCredential: "india_payin",
      apply: (body) => applyTyltWebhookByStoredRailProduct(body),
    });
  });

  const TYLT_H2H_WEBHOOK_PATH = "/webhooks/tylt/h2h/:environment";

  app.post(TYLT_H2H_WEBHOOK_PATH, async (request, reply) => {
    await handleTyltWebhookPost(request, reply, {
      pathConstant: TYLT_H2H_WEBHOOK_PATH,
      rail: "tylt-h2h-upi",
      rejectLogMessage: "tylt H2H webhook rejected: invalid or missing signature",
      tyltWebhookCredential: "india_payin",
      apply: (body) => applyTyltWebhookByStoredRailProduct(body),
    });
  });

  const TYLT_CPG_PAYIN_WEBHOOK_PATH = "/webhooks/tylt/cpg-payin/:environment";

  app.post(TYLT_CPG_PAYIN_WEBHOOK_PATH, async (request, reply) => {
    await handleTyltWebhookPost(request, reply, {
      pathConstant: TYLT_CPG_PAYIN_WEBHOOK_PATH,
      rail: "tylt-cpg-payin",
      rejectLogMessage: "tylt CPG pay-in webhook rejected: invalid or missing signature",
      tyltWebhookCredential: "india_payin",
      apply: (body) => applyTyltWebhookByProductRoute("cpg_payin", body),
    });
  });

  const TYLT_CPG_PAYOUT_WEBHOOK_PATH = "/webhooks/tylt/cpg-payout/:environment";

  app.post(TYLT_CPG_PAYOUT_WEBHOOK_PATH, async (request, reply) => {
    await handleTyltWebhookPost(request, reply, {
      pathConstant: TYLT_CPG_PAYOUT_WEBHOOK_PATH,
      rail: "tylt-cpg-payout",
      rejectLogMessage: "tylt CPG payout webhook rejected: invalid or missing signature",
      tyltWebhookCredential: "india_payout",
      apply: (body) => applyTyltWebhookByProductRoute("cpg_payout", body),
    });
  });

  const TYLT_EUR_PAYIN_WEBHOOK_PATH = "/webhooks/tylt/eur-payin/:environment";

  app.post(TYLT_EUR_PAYIN_WEBHOOK_PATH, async (request, reply) => {
    await handleTyltWebhookPost(request, reply, {
      pathConstant: TYLT_EUR_PAYIN_WEBHOOK_PATH,
      rail: "tylt-eur-payin",
      rejectLogMessage: "tylt EU pay-in webhook rejected: invalid or missing signature",
      tyltWebhookCredential: "eur_payin",
      apply: (body) => applyTyltWebhookByStoredRailProduct(body),
    });
  });

  const TYLT_EUR_PAYOUT_WEBHOOK_PATH = "/webhooks/tylt/eur-payout/:environment";

  app.post(TYLT_EUR_PAYOUT_WEBHOOK_PATH, async (request, reply) => {
    await handleTyltWebhookPost(request, reply, {
      pathConstant: TYLT_EUR_PAYOUT_WEBHOOK_PATH,
      rail: "tylt-eur-payout",
      rejectLogMessage: "tylt EU payout webhook rejected: invalid or missing signature",
      tyltWebhookCredential: "eur_payout",
      apply: (body) => applyTyltWebhookByStoredRailProduct(body),
    });
  });

  /** Optional single callback URL: routes by `transactions.metadata` (`rail` + `tyltProduct`). Legacy paths remain preferred. */
  const TYLT_UNIFIED_WEBHOOK_PATH = "/webhooks/tylt/unified/:environment";

  app.post(TYLT_UNIFIED_WEBHOOK_PATH, async (request, reply) => {
    await handleTyltWebhookPost(request, reply, {
      pathConstant: TYLT_UNIFIED_WEBHOOK_PATH,
      rail: "tylt-unified",
      rejectLogMessage: "tylt unified webhook rejected: invalid or missing signature",
      tyltWebhookCredential: "unified",
      apply: (body) => applyTyltWebhookByStoredRailProduct(body),
    });
  });

  const kycRequired = process.env.KYC_REQUIRED === "true";

  async function requireKycVerified(merchantId: string, reply: FastifyReply): Promise<boolean> {
    if (!kycRequired) return true;
    const [m] = await db.select({ kycStatus: merchants.kycStatus }).from(merchants).where(eq(merchants.id, merchantId)).limit(1);
    if (m?.kycStatus !== "verified") {
      reply.status(403).send({ error: "Forbidden", message: "KYC verification required" });
      return false;
    }
    return true;
  }

  async function requireMerchantMarketEnabled(
    merchantId: string,
    market: MerchantMarket,
    reply: FastifyReply
  ): Promise<boolean> {
    const gate = await assertMerchantMarketApiAccess({
      merchantId,
      market,
      kycRequired,
    });
    if (!gate.ok) {
      reply.status(403).send({
        error: "Forbidden",
        message: gate.message,
        code: gate.code,
        market: gate.market,
      });
      return false;
    }
    return true;
  }

  async function requireKycAndMarket(
    merchantId: string,
    market: MerchantMarket,
    reply: FastifyReply
  ): Promise<boolean> {
    if (!(await requireKycVerified(merchantId, reply))) return false;
    return requireMerchantMarketEnabled(merchantId, market, reply);
  }

  function merchantHasTyltDiscoveryListScope(m: { scopes: string[] }): boolean {
    return (
      m.scopes.includes("*") ||
      m.scopes.includes("balance:read") ||
      m.scopes.includes("payin:create") ||
      m.scopes.includes("payout:create")
    );
  }

  function merchantHasBalanceReadScope(m: { scopes: string[] }): boolean {
    return m.scopes.includes("*") || m.scopes.includes("balance:read");
  }

  /** Cross-border wallet-to-wallet moves (`/v1/internal-transfer`, legacy `tylt:internal_transfer` scope still accepted). */
  function merchantHasInternalTransferScope(m: { scopes: string[] }): boolean {
    return (
      m.scopes.includes("*") ||
      m.scopes.includes("internal_transfer:create") ||
      m.scopes.includes("tylt:internal_transfer")
    );
  }

  function tyltPassthroughQuery(query: unknown): Record<string, unknown> {
    if (!query || typeof query !== "object") return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
      if (v === undefined || v === "") continue;
      out[k] = v;
    }
    return out;
  }

  /** Proxy routes forward upstream HTTP status; serializer schema only lists a subset — cast for typing. */
  function replyWithTyltUpstreamJson(reply: FastifyReply, upstreamStatus: number, json: unknown) {
    const code = upstreamStatus >= 500 ? 502 : upstreamStatus;
    return (reply as FastifyReply).code(code).send(json);
  }

  app.post(
    "/v1/payins",
    {
      schema: {
        body: z.object({
          amount: z.string(),
          paymentMethodCode: z.enum(["BKASH", "NAGAD", "UPAY"]),
          /** Where the customer is sent after PayOK checkout (your site/app). Forwarded to the provider; never exposed to the merchant as PayOK. */
          returnUrl: z.string().min(1),
          customer: z.object({
            name: z.string(),
            email: z.string().email(),
            phone: z.string(),
            deviceId: z.string(),
          }),
          goodsInfo: z.object({
            name: z.string(),
            id: z.string().optional(),
            price: z.string().optional(),
          }),
        }),
        response: {
          200: z.object({
            transactionId: z.string(),
            status: z.string(),
            amount: z.string(),
            platformOrderId: z.string().optional(),
            paymentInfo: z.unknown().optional(),
            expiresAt: z.string().nullable().optional(),
          }),
          400: merchantFacingError,
          401: errorResponse,
          403: errorResponse,
          503: merchantFacingError,
          500: merchantFacingError,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      if (!m.scopes.includes("payin:create") && !m.scopes.includes("*")) {
        return reply.status(403).send({ error: "Forbidden", message: "Missing scope: payin:create" });
      }
      if (!(await requireKycAndMarket(m.merchantId, "bangladesh", reply))) return;
      const body = request.body as {
        amount: string;
        paymentMethodCode: string;
        returnUrl: string;
        customer: { name: string; email: string; phone: string; deviceId: string };
        goodsInfo: { name: string; id?: string; price?: string };
      };
      const amount = parseFloat(body.amount);
      if (!Number.isFinite(amount) || amount < LIMITS.payin.min || amount > LIMITS.payin.max) {
        return reply.status(400).send({ error: `Amount must be between ${LIMITS.payin.min} and ${LIMITS.payin.max} BDT` });
      }
      const returnCheck = validateMerchantReturnUrl(body.returnUrl);
      if (!returnCheck.ok) {
        return reply.status(400).send({ error: "Bad Request", message: returnCheck.message });
      }
      try {
        const response = await withIdempotency(
          { request, reply, merchantId: m.merchantId, body },
          async () => {
            const result = await createPayinOrder({
              merchantId: m.merchantId,
              environment: m.environment,
              amount: body.amount,
              paymentMethodCode: body.paymentMethodCode,
              baseUrl,
              merchantReturnUrl: returnCheck.normalized,
              customer: body.customer,
              goodsInfo: body.goodsInfo,
            });
            const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
            return {
              ...result,
              status: "pending",
              amount: body.amount,
              expiresAt,
            };
          }
        );
        if (response === undefined) return; // 409 conflict already sent
        return response;
      } catch (err) {
        app.log.error(err);
        const mapped = merchantPaymentFlowErrorResponse(err);
        if (mapped.logDetail) {
          app.log.warn({ logDetail: mapped.logDetail }, "v1 payins merchant-facing error detail");
        }
        sendMerchantFacingReply(reply, mapped);
        return;
      }
    }
  );

  /** Merchant docs use `/v1/...` without a provider segment; `/v1/tylt/...` remains for backward compatibility. */
  function merchantV1GetPair(canonicalPath: string, legacyPath: string, register: (path: string) => void): void {
    register(canonicalPath);
    register(legacyPath);
  }

  function merchantV1PostPair(canonicalPath: string, legacyPath: string, register: (path: string) => void): void {
    register(canonicalPath);
    register(legacyPath);
  }

  /** India UPI on `/v1` is H2H only; hosted CrossRamp pay-in create is intentionally not registered. */
  merchantV1PostPair("/v1/h2h/payin-instances", "/v1/tylt/h2h/payin-instances", (path) =>
    app.post(path, {
      schema: {
        body: z
          .object({
            amount: z.string(),
            currencySymbol: z.enum(["USDT", "INR"]),
            returnUrl: z.string().min(1).optional(),
            /** @deprecated Prefer `userDetails` — Tylt requires a `userDetails` object on create. */
            userEmail: z.string().email().optional(),
            userDetails: z
              .object({
                email: z.string().email(),
                name: z.string().min(1).optional(),
                phone: z.string().optional(),
              })
              .optional(),
          })
          .refine((b) => b.userDetails != null || b.userEmail != null, {
            message: "userDetails (preferred) or userEmail is required",
            path: ["userDetails"],
          }),
        response: {
          200: z.object({
            transactionId: z.string(),
            status: z.literal("pending"),
            amount: z.string(),
            currency: z.enum(["USDT", "INR"]),
            instanceId: z.string(),
            tradeEventId: z.number().nullable().optional(),
            paymentDetails: z.record(z.unknown()),
            paymentInstructions: z.record(z.unknown()).nullable().optional(),
            detailsSource: z.literal("create").optional(),
            expiresAt: z.string().nullable().optional(),
          }),
          400: merchantFacingError,
          401: errorResponse,
          403: errorResponse,
          503: merchantFacingError,
          500: merchantFacingError,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      if (!m.scopes.includes("payin:create") && !m.scopes.includes("*")) {
        return reply.status(403).send({ error: "Forbidden", message: "Missing scope: payin:create" });
      }
      if (!(await requireKycAndMarket(m.merchantId, "india", reply))) return;
      const body = request.body as {
        amount: string;
        currencySymbol: "USDT" | "INR";
        returnUrl?: string;
        userEmail?: string;
        userDetails?: { email: string; name?: string; phone?: string };
      };
      let normalizedReturn: string | undefined;
      if (body.returnUrl?.trim()) {
        const returnCheck = validateMerchantReturnUrl(body.returnUrl);
        if (!returnCheck.ok) {
          return reply.status(400).send({ error: "Bad Request", message: returnCheck.message });
        }
        normalizedReturn = returnCheck.normalized;
      }
      const bounds = LIMITS.tyltCrossRamp[body.currencySymbol];
      const amt = parseFloat(body.amount);
      if (!Number.isFinite(amt) || amt < bounds.min || amt > bounds.max) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Amount must be between ${bounds.min} and ${bounds.max} ${body.currencySymbol}`,
        });
      }
      try {
        const response = await withIdempotency(
          { request, reply, merchantId: m.merchantId, body },
          async () => {
            const userDetails =
              body.userDetails ??
              (body.userEmail != null ? { email: body.userEmail } : { email: "" });
            const result = await createTyltH2hPayinInstance({
              merchantId: m.merchantId,
              environment: m.environment,
              baseUrl,
              amount: body.amount,
              currencySymbol: body.currencySymbol,
              userDetails,
              returnUrl: normalizedReturn,
            });
            const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
            return {
              transactionId: result.transactionId,
              status: "pending" as const,
              amount: result.amount,
              currency: result.currency,
              instanceId: result.instanceId,
              tradeEventId: result.tradeEventId ?? null,
              paymentDetails: result.paymentDetails,
              paymentInstructions: result.paymentInstructions ?? null,
              detailsSource: "create" as const,
              expiresAt,
            };
          }
        );
        if (response === undefined) return; // 409 conflict already sent
        return response;
      } catch (err) {
        app.log.error(err);
        const mapped = merchantPaymentFlowErrorResponse(err);
        if (mapped.logDetail) {
          app.log.warn({ logDetail: mapped.logDetail }, "v1 tylt h2h payins merchant-facing error detail");
        }
        sendMerchantFacingReply(reply, mapped);
        return;
      }
    })
  );

  const h2hPayinStatusResponseSchema = z.object({
    transactionId: z.string(),
    status: z.string(),
    amount: z.string(),
    currency: z.string(),
    instanceId: z.string().nullable(),
    tradeEventId: z.number().nullable(),
    paymentDetails: z.record(z.unknown()),
    paymentInstructions: z.record(z.unknown()).nullable(),
    detailsSource: z.enum(["live", "webhook", "create"]),
    expiresAt: z.string().nullable(),
  });

  merchantV1GetPair(
    "/v1/h2h/payin-instances/:transactionId",
    "/v1/tylt/h2h/payin-instances/:transactionId",
    (path) =>
      app.get(path, {
        schema: {
          params: z.object({ transactionId: z.string().uuid() }),
          response: {
            200: h2hPayinStatusResponseSchema,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
          },
        },
      },
      async (request, reply) => {
        const m = request.merchant;
        if (!m) return reply.status(401).send({ error: "Unauthorized" });
        if (!m.scopes.includes("payin:create") && !m.scopes.includes("*")) {
          return reply.status(403).send({ error: "Forbidden", message: "Missing scope: payin:create" });
        }
        const { transactionId } = request.params as { transactionId: string };
        const view = await getMerchantH2hPayinStatus({
          merchantId: m.merchantId,
          environment: m.environment,
          transactionId,
        });
        if (!view) {
          return reply.status(404).send({ error: "Not found", message: "H2H pay-in not found" });
        }
        return view;
      })
  );

  merchantV1PostPair("/v1/h2h/buyer-confirms-payment", "/v1/tylt/h2h/buyer-confirms-payment", (path) =>
    app.post(path, {
      schema: {
        body: z.object({
          transactionId: z.string().uuid(),
          /** TL Pay requires UTR when create sent `isUTRNeeded: 1` (always the case on our create). */
          utr: z.string().min(4).max(64),
        }),
        response: {
          200: z.object({
            transactionId: z.string(),
            acknowledged: z.boolean(),
          }),
          400: merchantFacingError,
          401: errorResponse,
          403: errorResponse,
          503: merchantFacingError,
          500: merchantFacingError,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      if (!m.scopes.includes("payin:create") && !m.scopes.includes("*")) {
        return reply.status(403).send({ error: "Forbidden", message: "Missing scope: payin:create" });
      }
      if (!(await requireKycAndMarket(m.merchantId, "india", reply))) return;
      const body = request.body as { transactionId: string; utr: string };
      const [txRow] = await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.id, body.transactionId), eq(transactions.merchantId, m.merchantId)))
        .limit(1);
      if (!txRow || txRow.type !== "payin") {
        return reply.status(400).send({ error: "Bad Request", message: "Transaction not found" });
      }
      const meta = parseTransactionMetadata(txRow);
      if (!isTyltH2hPayinMetadata(meta)) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Not a Tylt H2H UPI pay-in",
        });
      }
      if (!txRow.externalId?.trim()) {
        return reply.status(400).send({ error: "Bad Request", message: "Missing provider instance id" });
      }
      try {
        const upstream = await tyltH2hBuyerConfirmsPayment({
          environment: m.environment,
          instanceId: txRow.externalId,
          utr: body.utr,
        });
        if (upstream.status >= 400) {
          const merchantMsg4xx =
            pickTyltJsonPrimaryMessage(upstream.json) ??
            "Could not confirm payment. Check UTR, timing (after payer completed UPI), and TL Pay trade state.";
          const merchantMsg5xx =
            pickTyltJsonPrimaryMessage(upstream.json) ??
            "Payment confirmation is temporarily unavailable. Try again shortly.";
          const merchantMsg = upstream.status >= 500 ? merchantMsg5xx : merchantMsg4xx;
          app.log.warn(
            {
              transactionId: body.transactionId,
              status: upstream.status,
              upstreamMessage: merchantMsg,
            },
            "tylt H2H buyer confirm rejected"
          );
          if (upstream.status >= 500) {
            return reply.status(503).send({
              error: "Service Unavailable",
              message: merchantMsg,
              code: "payment_unavailable",
            });
          }
          return reply.status(400).send({
            error: "Bad Request",
            message: merchantMsg,
            code: "payment_provider_rejected",
          });
        }
        return { transactionId: txRow.id, acknowledged: true };
      } catch (err) {
        app.log.error(err);
        const mapped = merchantPaymentFlowErrorResponse(err);
        sendMerchantFacingReply(reply, mapped);
        return;
      }
    })
  );

  merchantV1GetPair("/v1/h2h/payment-methods", "/v1/tylt/h2h/payment-methods", (path) =>
    app.get(path, { schema: { response: tyltMerchantProxyResponses } },
    async (request, reply) => {
    const m = request.merchant;
    if (!m) return reply.status(401).send({ error: "Unauthorized" });
    if (!m.scopes.includes("payin:create") && !m.scopes.includes("*")) {
      return reply.status(403).send({ error: "Forbidden", message: "Missing scope: payin:create" });
    }
    try {
      const res = await tyltH2hGetPaymentMethodsP2pOnRamp(m.environment);
      return replyWithTyltUpstreamJson(reply, res.status, res.json);
    } catch (err) {
      app.log.error(err);
      const mapped = merchantPaymentFlowErrorResponse(err);
      sendMerchantFacingReply(reply, mapped);
      return;
    }
  })
  );

  merchantV1GetPair("/v1/h2h/crypto-currencies", "/v1/tylt/h2h/crypto-currencies", (path) =>
    app.get(path, { schema: { response: tyltMerchantProxyResponses } },
    async (request, reply) => {
    const m = request.merchant;
    if (!m) return reply.status(401).send({ error: "Unauthorized" });
    if (!m.scopes.includes("payin:create") && !m.scopes.includes("*")) {
      return reply.status(403).send({ error: "Forbidden", message: "Missing scope: payin:create" });
    }
    try {
      const res = await tyltH2hGetCryptoCurrencyListForPrime(m.environment);
      return replyWithTyltUpstreamJson(reply, res.status, res.json);
    } catch (err) {
      app.log.error(err);
      const mapped = merchantPaymentFlowErrorResponse(err);
      sendMerchantFacingReply(reply, mapped);
      return;
    }
  })
  );

  merchantV1GetPair("/v1/h2h/conversion-rates", "/v1/tylt/h2h/conversion-rates", (path) =>
    app.get(path, { schema: { response: tyltMerchantProxyResponses } },
    async (request, reply) => {
    const m = request.merchant;
    if (!m) return reply.status(401).send({ error: "Unauthorized" });
    if (!m.scopes.includes("payin:create") && !m.scopes.includes("*")) {
      return reply.status(403).send({ error: "Forbidden", message: "Missing scope: payin:create" });
    }
    try {
      const res = await tyltH2hGetMerchantRampSpecialRates(m.environment);
      return replyWithTyltUpstreamJson(reply, res.status, res.json);
    } catch (err) {
      app.log.error(err);
      const mapped = merchantPaymentFlowErrorResponse(err);
      sendMerchantFacingReply(reply, mapped);
      return;
    }
  })
  );

  merchantV1GetPair("/v1/supported/crypto-currencies", "/v1/tylt/supported/crypto-currencies", (path) =>
    app.get(path, { schema: { response: tyltMerchantProxyResponses } },
    async (request, reply) => {
    const m = request.merchant;
    if (!m) return reply.status(401).send({ error: "Unauthorized" });
    if (!merchantHasTyltDiscoveryListScope(m)) {
      return reply.status(403).send({
        error: "Forbidden",
        message: "Missing scope: use balance:read, payin:create, or payout:create",
      });
    }
    try {
      const res = await tyltGetSupportedCryptoCurrenciesList(m.environment);
      return replyWithTyltUpstreamJson(reply, res.status, res.json);
    } catch (err) {
      app.log.error(err);
      const mapped = merchantPaymentFlowErrorResponse(err);
      sendMerchantFacingReply(reply, mapped);
      return;
    }
  })
  );

  merchantV1GetPair("/v1/supported/fiat-currencies", "/v1/tylt/supported/fiat-currencies", (path) =>
    app.get(path, { schema: { response: tyltMerchantProxyResponses } },
    async (request, reply) => {
    const m = request.merchant;
    if (!m) return reply.status(401).send({ error: "Unauthorized" });
    if (!merchantHasTyltDiscoveryListScope(m)) {
      return reply.status(403).send({
        error: "Forbidden",
        message: "Missing scope: use balance:read, payin:create, or payout:create",
      });
    }
    try {
      const res = await tyltGetSupportedFiatCurrenciesList(m.environment);
      return replyWithTyltUpstreamJson(reply, res.status, res.json);
    } catch (err) {
      app.log.error(err);
      const mapped = merchantPaymentFlowErrorResponse(err);
      sendMerchantFacingReply(reply, mapped);
      return;
    }
  })
  );

  merchantV1GetPair("/v1/supported/crypto-networks", "/v1/tylt/supported/crypto-networks", (path) =>
    app.get(path, { schema: { response: tyltMerchantProxyResponses } },
    async (request, reply) => {
    const m = request.merchant;
    if (!m) return reply.status(401).send({ error: "Unauthorized" });
    if (!merchantHasTyltDiscoveryListScope(m)) {
      return reply.status(403).send({
        error: "Forbidden",
        message: "Missing scope: use balance:read, payin:create, or payout:create",
      });
    }
    try {
      const res = await tyltGetSupportedCryptoNetworksList(m.environment);
      return replyWithTyltUpstreamJson(reply, res.status, res.json);
    } catch (err) {
      app.log.error(err);
      const mapped = merchantPaymentFlowErrorResponse(err);
      sendMerchantFacingReply(reply, mapped);
      return;
    }
  })
  );

  merchantV1GetPair("/v1/supported/base-currencies", "/v1/tylt/supported/base-currencies", (path) =>
    app.get(path, { schema: { response: tyltMerchantProxyResponses } },
    async (request, reply) => {
    const m = request.merchant;
    if (!m) return reply.status(401).send({ error: "Unauthorized" });
    if (!merchantHasTyltDiscoveryListScope(m)) {
      return reply.status(403).send({
        error: "Forbidden",
        message: "Missing scope: use balance:read, payin:create, or payout:create",
      });
    }
    try {
      const res = await tyltGetSupportedBaseCurrenciesList(m.environment);
      return replyWithTyltUpstreamJson(reply, res.status, res.json);
    } catch (err) {
      app.log.error(err);
      const mapped = merchantPaymentFlowErrorResponse(err);
      sendMerchantFacingReply(reply, mapped);
      return;
    }
  })
  );

  merchantV1GetPair("/v1/account-balance", "/v1/tylt/account-balance", (path) =>
    app.get(path, {
      schema: {
        querystring: tyltPassthroughQuerySchema,
        response: tyltMerchantProxyResponses,
      },
    },
    async (request, reply) => {
    const m = request.merchant;
    if (!m) return reply.status(401).send({ error: "Unauthorized" });
    if (!merchantHasBalanceReadScope(m)) {
      return reply.status(403).send({
        error: "Forbidden",
        message: "Missing scope: balance:read",
      });
    }
    try {
      const qp = tyltPassthroughQuery(request.query);
      const res = await tyltGetAccountBalance(m.environment, qp);
      return replyWithTyltUpstreamJson(reply, res.status, res.json);
    } catch (err) {
      app.log.error(err);
      const mapped = merchantPaymentFlowErrorResponse(err);
      sendMerchantFacingReply(reply, mapped);
      return;
    }
  })
  );

  merchantV1PostPair("/v1/cpg/payin-requests", "/v1/tylt/cpg/payin-requests", (path) =>
    app.post(path, {
      schema: {
        body: z.object({
          baseAmount: z.string(),
          baseCurrency: z.string().min(1),
          settledCurrency: z.string().min(1),
          networkSymbol: z.string().min(1),
          settleUnderpayment: z.coerce.number().int().min(0).max(1).optional(),
          payeeDetails: z.record(z.string(), z.unknown()),
        }),
        response: {
          200: z.object({
            transactionId: z.string(),
            status: z.literal("pending"),
            amount: z.string(),
            currency: z.string(),
            platformOrderId: z.string().nullable(),
          }),
          400: merchantFacingError,
          401: errorResponse,
          403: errorResponse,
          503: merchantFacingError,
          500: merchantFacingError,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      if (!m.scopes.includes("payin:create") && !m.scopes.includes("*")) {
        return reply.status(403).send({ error: "Forbidden", message: "Missing scope: payin:create" });
      }
      if (!(await requireKycAndMarket(m.merchantId, "india", reply))) return;
      const body = request.body as {
        baseAmount: string;
        baseCurrency: string;
        settledCurrency: string;
        networkSymbol: string;
        settleUnderpayment?: number;
        payeeDetails: Record<string, unknown>;
      };
      const amt = parseFloat(body.baseAmount);
      const bounds = LIMITS.tyltCpgPayin;
      if (!Number.isFinite(amt) || amt < bounds.baseAmountMin || amt > bounds.baseAmountMax) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Invalid baseAmount",
        });
      }
      if (!body.payeeDetails || typeof body.payeeDetails !== "object" || Object.keys(body.payeeDetails).length === 0) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "payeeDetails is required",
        });
      }
      try {
        const response = await withIdempotency(
          { request, reply, merchantId: m.merchantId, body },
          async () => {
            const result = await createTyltCpgPayinRequest({
              merchantId: m.merchantId,
              environment: m.environment,
              baseUrl,
              baseAmount: body.baseAmount,
              baseCurrency: body.baseCurrency,
              settledCurrency: body.settledCurrency,
              networkSymbol: body.networkSymbol,
              payeeDetails: body.payeeDetails,
              settleUnderpayment: body.settleUnderpayment,
            });
            return {
              transactionId: result.transactionId,
              status: "pending" as const,
              amount: result.amount,
              currency: result.currency,
              platformOrderId: result.platformOrderId,
            };
          }
        );
        if (response === undefined) return; // 409 conflict already sent
        return response;
      } catch (err) {
        app.log.error(err);
        const mapped = merchantPaymentFlowErrorResponse(err);
        if (mapped.logDetail) {
          app.log.warn({ logDetail: mapped.logDetail }, "v1 tylt cpg payin merchant-facing error detail");
        }
        sendMerchantFacingReply(reply, mapped);
        return;
      }
    })
  );

  merchantV1GetPair("/v1/cpg/payin-information/:transactionId", "/v1/tylt/cpg/payin-information/:transactionId", (path) =>
    app.get(path, {
      schema: {
        params: tyltTransactionIdParamSchema,
        response: tyltMerchantProxyResponses,
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      if (!m.scopes.includes("payin:create") && !m.scopes.includes("*")) {
        return reply.status(403).send({ error: "Forbidden", message: "Missing scope: payin:create" });
      }
      const transactionId = request.params.transactionId;
      const [txRow] = await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.id, transactionId), eq(transactions.merchantId, m.merchantId)))
        .limit(1);
      if (!txRow || txRow.type !== "payin") {
        return reply.status(404).send({ error: "Not found", message: "Transaction not found" });
      }
      const meta = parseTransactionMetadata(txRow);
      if (!isTyltCpgPayinMetadata(meta)) {
        return reply.status(400).send({ error: "Bad Request", message: "Not a CPG pay-in" });
      }
      try {
        const res = await cpgGetPayinTransactionInformation({ environment: m.environment, orderId: txRow.id });
        return replyWithTyltUpstreamJson(reply, res.status, res.json);
      } catch (err) {
        app.log.error(err);
        const mapped = merchantPaymentFlowErrorResponse(err);
        sendMerchantFacingReply(reply, mapped);
        return;
      }
    })
  );

  merchantV1GetPair("/v1/cpg/payin-history", "/v1/tylt/cpg/payin-history", (path) =>
    app.get(path, {
      schema: {
        querystring: tyltRowsPageQuerySchema,
        response: tyltMerchantProxyResponses,
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      if (!m.scopes.includes("payin:create") && !m.scopes.includes("*")) {
        return reply.status(403).send({ error: "Forbidden", message: "Missing scope: payin:create" });
      }
      const q = request.query as { rows?: number; page?: number };
      const rows = Math.min(100, Math.max(1, q.rows ?? 20));
      const page = Math.max(1, q.page ?? 1);
      try {
        const res = await cpgGetPayinTransactionHistory({
          environment: m.environment,
          rows,
          page,
        });
        return replyWithTyltUpstreamJson(reply, res.status, res.json);
      } catch (err) {
        app.log.error(err);
        const mapped = merchantPaymentFlowErrorResponse(err);
        sendMerchantFacingReply(reply, mapped);
        return;
      }
    })
  );

  merchantV1PostPair("/v1/cpg/payout-requests", "/v1/tylt/cpg/payout-requests", (path) =>
    app.post(path, {
      schema: {
        body: z.object({
          amount: z.string(),
          settledCurrency: z.string().min(1),
          networkSymbol: z.string().min(1),
          destinationDetails: z.record(z.string(), z.unknown()),
        }),
        response: {
          200: z.object({
            transactionId: z.string(),
            status: z.literal("pending"),
            amount: z.string(),
            platformOrderId: z.string().nullable(),
          }),
          400: merchantFacingError,
          401: errorResponse,
          403: errorResponse,
          503: merchantFacingError,
          500: merchantFacingError,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      if (!m.scopes.includes("payout:create") && !m.scopes.includes("*")) {
        return reply.status(403).send({ error: "Forbidden", message: "Missing scope: payout:create" });
      }
      if (!(await requireKycAndMarket(m.merchantId, "india", reply))) return;
      const body = request.body as {
        amount: string;
        settledCurrency: string;
        networkSymbol: string;
        destinationDetails: Record<string, unknown>;
      };
      const amt = parseFloat(body.amount);
      const bounds = LIMITS.tyltCpgPayout;
      if (!Number.isFinite(amt) || amt < bounds.amountMin || amt > bounds.amountMax) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Invalid amount",
        });
      }
      if (
        !body.destinationDetails ||
        typeof body.destinationDetails !== "object" ||
        Object.keys(body.destinationDetails).length === 0
      ) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "destinationDetails is required",
        });
      }
      try {
        const response = await withIdempotency(
          { request, reply, merchantId: m.merchantId, body },
          async () => {
            const result = await createTyltCpgPayoutRequest({
              merchantId: m.merchantId,
              environment: m.environment,
              baseUrl,
              amount: body.amount,
              settledCurrency: body.settledCurrency,
              networkSymbol: body.networkSymbol,
              destinationDetails: body.destinationDetails,
            });
            return {
              transactionId: result.transactionId,
              status: "pending" as const,
              amount: body.amount,
              platformOrderId: result.platformOrderId,
            };
          }
        );
        if (response === undefined) return; // 409 conflict already sent
        return response;
      } catch (err) {
        app.log.error(err);
        const mapped = merchantPaymentFlowErrorResponse(err);
        if (mapped.logDetail) {
          app.log.warn({ logDetail: mapped.logDetail }, "v1 tylt cpg payout merchant-facing error detail");
        }
        sendMerchantFacingReply(reply, mapped);
        return;
      }
    })
  );

  merchantV1GetPair("/v1/cpg/payout-information/:transactionId", "/v1/tylt/cpg/payout-information/:transactionId", (path) =>
    app.get(path, {
      schema: {
        params: tyltTransactionIdParamSchema,
        response: tyltMerchantProxyResponses,
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      if (!m.scopes.includes("payout:create") && !m.scopes.includes("*")) {
        return reply.status(403).send({ error: "Forbidden", message: "Missing scope: payout:create" });
      }
      const transactionId = request.params.transactionId;
      const [txRow] = await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.id, transactionId), eq(transactions.merchantId, m.merchantId)))
        .limit(1);
      if (!txRow || txRow.type !== "payout") {
        return reply.status(404).send({ error: "Not found", message: "Transaction not found" });
      }
      const meta = parseTransactionMetadata(txRow);
      if (!isTyltCpgPayoutMetadata(meta)) {
        return reply.status(400).send({ error: "Bad Request", message: "Not a CPG payout" });
      }
      try {
        const res = await cpgGetPayoutTransactionInformation({ environment: m.environment, orderId: txRow.id });
        return replyWithTyltUpstreamJson(reply, res.status, res.json);
      } catch (err) {
        app.log.error(err);
        const mapped = merchantPaymentFlowErrorResponse(err);
        sendMerchantFacingReply(reply, mapped);
        return;
      }
    })
  );

  merchantV1GetPair("/v1/cpg/payout-history", "/v1/tylt/cpg/payout-history", (path) =>
    app.get(path, {
      schema: {
        querystring: tyltRowsPageQuerySchema,
        response: tyltMerchantProxyResponses,
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      if (!m.scopes.includes("payout:create") && !m.scopes.includes("*")) {
        return reply.status(403).send({ error: "Forbidden", message: "Missing scope: payout:create" });
      }
      const q = request.query as { rows?: number; page?: number };
      const rows = Math.min(100, Math.max(1, q.rows ?? 20));
      const page = Math.max(1, q.page ?? 1);
      try {
        const res = await cpgGetPayoutTransactionHistory({
          environment: m.environment,
          rows,
          page,
        });
        return replyWithTyltUpstreamJson(reply, res.status, res.json);
      } catch (err) {
        app.log.error(err);
        const mapped = merchantPaymentFlowErrorResponse(err);
        sendMerchantFacingReply(reply, mapped);
        return;
      }
    })
  );

  const tyltEurMerchantDetailsBodySchema = z
    .object({
      merchantName: z.string().min(1),
      merchantUrl: z.string().url(),
      merchantInternalId: z.string().min(1),
    })
    .optional();

  const eurPayinCreateResponseSchema = z.object({
    transactionId: z.string(),
    status: z.literal("pending"),
    amount: z.string(),
    fiatCurrency: z.string(),
    settlementCurrency: z.literal("USDC"),
    instanceId: z.string(),
    checkoutUrl: z.string().url(),
    cryptoAmount: z.string().nullable(),
    rate: z.number().nullable(),
  });

  merchantV1PostPair("/v1/eur/payin-instances", "/v1/tylt/eur/payin-instances", (path) =>
    app.post(path, {
      schema: {
        body: z.object({
          amount: z.string(),
          currencySymbol: z.enum(["EUR", "GBP"]),
          returnUrl: z.string().min(1),
          merchantUrl: z.string().url().optional(),
          merchantDetails: tyltEurMerchantDetailsBodySchema,
          userDetails: z.record(z.string(), z.unknown()).default({}),
          cryptoUi: z.union([z.literal(0), z.literal(1)]).optional(),
        }),
        response: {
          200: eurPayinCreateResponseSchema,
          400: merchantFacingError,
          401: errorResponse,
          403: errorResponse,
          503: merchantFacingError,
          500: merchantFacingError,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      if (!m.scopes.includes("payin:create") && !m.scopes.includes("*")) {
        return reply.status(403).send({ error: "Forbidden", message: "Missing scope: payin:create" });
      }
      if (!(await requireKycAndMarket(m.merchantId, "europe", reply))) return;
      const body = request.body as {
        amount: string;
        currencySymbol: "EUR" | "GBP";
        returnUrl: string;
        merchantUrl?: string;
        merchantDetails?: { merchantName: string; merchantUrl: string; merchantInternalId: string };
        userDetails: Record<string, unknown>;
        cryptoUi?: 0 | 1;
      };
      const returnCheck = validateMerchantReturnUrl(body.returnUrl);
      if (!returnCheck.ok) {
        return reply.status(400).send({ error: "Bad Request", message: returnCheck.message });
      }
      const bounds = LIMITS.tyltEurOpenBanking[body.currencySymbol];
      const amt = parseFloat(body.amount);
      if (!Number.isFinite(amt) || amt < bounds.min || amt > bounds.max) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Amount must be between ${bounds.min} and ${bounds.max} ${body.currencySymbol}`,
        });
      }
      try {
        const response = await withIdempotency(
          { request, reply, merchantId: m.merchantId, body },
          async () => {
            const result = await createTyltEurPayinInstance({
              merchantId: m.merchantId,
              environment: m.environment,
              baseUrl,
              amount: body.amount,
              currencySymbol: body.currencySymbol,
              returnUrl: returnCheck.normalized!,
              userDetails: body.userDetails ?? {},
              merchantUrl: body.merchantUrl,
              merchantDetails: body.merchantDetails,
              cryptoUi: body.cryptoUi,
            });
            return {
              transactionId: result.transactionId,
              status: "pending" as const,
              amount: result.amount,
              fiatCurrency: result.fiatCurrency,
              settlementCurrency: "USDC" as const,
              instanceId: result.instanceId,
              checkoutUrl: result.checkoutUrl,
              cryptoAmount: result.cryptoAmount,
              rate: result.rate,
            };
          }
        );
        if (response === undefined) return;
        return response;
      } catch (err) {
        app.log.error(err);
        const mapped = merchantPaymentFlowErrorResponse(err);
        if (mapped.logDetail) {
          app.log.warn({ logDetail: mapped.logDetail }, "v1 eur payin merchant-facing error detail");
        }
        sendMerchantFacingReply(reply, mapped);
        return;
      }
    })
  );

  merchantV1GetPair(
    "/v1/eur/payin-instances/:transactionId",
    "/v1/tylt/eur/payin-instances/:transactionId",
    (path) =>
      app.get(path, {
        schema: {
          params: z.object({ transactionId: z.string().uuid() }),
          response: {
            200: z.object({
              transactionId: z.string(),
              status: z.string(),
              amount: z.string(),
              fiatCurrency: z.string(),
              settlementCurrency: z.string(),
              instanceId: z.string().nullable(),
              checkoutUrl: z.string().nullable(),
              eventId: z.number().nullable(),
              detailsSource: z.enum(["live", "local"]),
              upstream: z.record(z.unknown()).nullable().optional(),
            }),
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
          },
        },
      },
      async (request, reply) => {
        const m = request.merchant;
        if (!m) return reply.status(401).send({ error: "Unauthorized" });
        if (!m.scopes.includes("payin:create") && !m.scopes.includes("*")) {
          return reply.status(403).send({ error: "Forbidden", message: "Missing scope: payin:create" });
        }
        const { transactionId } = request.params as { transactionId: string };
        const view = await getMerchantEurPayinStatus({
          merchantId: m.merchantId,
          environment: m.environment,
          transactionId,
        });
        if (!view) {
          return reply.status(404).send({ error: "Not found", message: "EU pay-in not found" });
        }
        return view;
      })
  );

  merchantV1PostPair("/v1/eur/payout-instances", "/v1/tylt/eur/payout-instances", (path) =>
    app.post(path, {
      schema: {
        body: z.object({
          amount: z.string(),
          currencySymbol: z.literal("EUR"),
          returnUrl: z.string().min(1),
          merchantUrl: z.string().url().optional(),
          merchantDetails: tyltEurMerchantDetailsBodySchema,
          userDetails: z.record(z.string(), z.unknown()).default({}),
          payeeDetails: z.record(z.string(), z.unknown()),
          autoMerchantApproval: z.union([z.literal(0), z.literal(1)]).optional(),
          cryptoUi: z.union([z.literal(0), z.literal(1)]).optional(),
        }),
        response: {
          200: eurPayinCreateResponseSchema,
          400: merchantFacingError,
          401: errorResponse,
          403: errorResponse,
          503: merchantFacingError,
          500: merchantFacingError,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      if (!m.scopes.includes("payout:create") && !m.scopes.includes("*")) {
        return reply.status(403).send({ error: "Forbidden", message: "Missing scope: payout:create" });
      }
      if (!(await requireKycAndMarket(m.merchantId, "europe", reply))) return;
      const body = request.body as {
        amount: string;
        currencySymbol: "EUR";
        returnUrl: string;
        merchantUrl?: string;
        merchantDetails?: { merchantName: string; merchantUrl: string; merchantInternalId: string };
        userDetails: Record<string, unknown>;
        payeeDetails: Record<string, unknown>;
        autoMerchantApproval?: 0 | 1;
        cryptoUi?: 0 | 1;
      };
      const returnCheck = validateMerchantReturnUrl(body.returnUrl);
      if (!returnCheck.ok) {
        return reply.status(400).send({ error: "Bad Request", message: returnCheck.message });
      }
      const bounds = LIMITS.tyltEurOpenBanking.EUR;
      const amt = parseFloat(body.amount);
      if (!Number.isFinite(amt) || amt < bounds.min || amt > bounds.max) {
        return reply.status(400).send({
          error: "Bad Request",
          message: `Amount must be between ${bounds.min} and ${bounds.max} EUR`,
        });
      }
      try {
        const response = await withIdempotency(
          { request, reply, merchantId: m.merchantId, body },
          async () => {
            const result = await createTyltEurPayoutInstance({
              merchantId: m.merchantId,
              environment: m.environment,
              baseUrl,
              amount: body.amount,
              currencySymbol: "EUR",
              returnUrl: returnCheck.normalized!,
              userDetails: body.userDetails ?? {},
              payeeDetails: body.payeeDetails,
              autoMerchantApproval: body.autoMerchantApproval,
              merchantUrl: body.merchantUrl,
              merchantDetails: body.merchantDetails,
              cryptoUi: body.cryptoUi,
            });
            return {
              transactionId: result.transactionId,
              status: "pending" as const,
              amount: result.amount,
              fiatCurrency: result.fiatCurrency,
              settlementCurrency: "USDC" as const,
              instanceId: result.instanceId,
              checkoutUrl: result.checkoutUrl,
              cryptoAmount: result.cryptoAmount,
              rate: result.rate,
            };
          }
        );
        if (response === undefined) return;
        return response;
      } catch (err) {
        app.log.error(err);
        const mapped = merchantPaymentFlowErrorResponse(err);
        sendMerchantFacingReply(reply, mapped);
        return;
      }
    })
  );

  merchantV1PostPair(
    "/v1/eur/payout-instances/:transactionId/approve",
    "/v1/tylt/eur/payout-instances/:transactionId/approve",
    (path) =>
      app.post(path, {
        schema: {
          params: z.object({ transactionId: z.string().uuid() }),
          response: {
            200: z.object({ transactionId: z.string(), acknowledged: z.boolean() }),
            400: merchantFacingError,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            503: merchantFacingError,
          },
        },
      },
      async (request, reply) => {
        const m = request.merchant;
        if (!m) return reply.status(401).send({ error: "Unauthorized" });
        if (!m.scopes.includes("payout:create") && !m.scopes.includes("*")) {
          return reply.status(403).send({ error: "Forbidden", message: "Missing scope: payout:create" });
        }
        if (!(await requireKycAndMarket(m.merchantId, "europe", reply))) return;
        const { transactionId } = request.params as { transactionId: string };
        const [txRow] = await db
          .select()
          .from(transactions)
          .where(and(eq(transactions.id, transactionId), eq(transactions.merchantId, m.merchantId)))
          .limit(1);
        if (!txRow || txRow.type !== "payout") {
          return reply.status(404).send({ error: "Not found", message: "Payout not found" });
        }
        const meta = parseTransactionMetadata(txRow);
        if (!isTyltEurPayoutMetadata(meta)) {
          return reply.status(404).send({ error: "Not found", message: "EU payout not found" });
        }
        try {
          const res = await approveTyltEurPayout({
            environment: m.environment,
            transactionId,
            merchantId: m.merchantId,
          });
          if (res.status >= 400) {
            return reply.status(400).send({
              error: "Bad Request",
              message: pickTyltJsonPrimaryMessage(res.json) ?? "Payout approval rejected",
              code: "payment_provider_rejected",
            });
          }
          return { transactionId, acknowledged: true };
        } catch (err) {
          app.log.error(err);
          const mapped = merchantPaymentFlowErrorResponse(err);
          sendMerchantFacingReply(reply, mapped);
          return;
        }
      })
  );

  merchantV1GetPair(
    "/v1/eur/payout-instances/:transactionId",
    "/v1/tylt/eur/payout-instances/:transactionId",
    (path) =>
      app.get(path, {
        schema: {
          params: z.object({ transactionId: z.string().uuid() }),
          response: {
            200: z.object({
              transactionId: z.string(),
              status: z.string(),
              amount: z.string(),
              fiatCurrency: z.string(),
              settlementCurrency: z.string(),
              debitAmount: z.string(),
              instanceId: z.string().nullable(),
              checkoutUrl: z.string().nullable(),
              eventId: z.number().nullable(),
              detailsSource: z.enum(["live", "local"]),
              upstream: z.record(z.unknown()).nullable().optional(),
            }),
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
          },
        },
      },
      async (request, reply) => {
        const m = request.merchant;
        if (!m) return reply.status(401).send({ error: "Unauthorized" });
        if (!m.scopes.includes("payout:create") && !m.scopes.includes("*")) {
          return reply.status(403).send({ error: "Forbidden", message: "Missing scope: payout:create" });
        }
        const { transactionId } = request.params as { transactionId: string };
        const view = await getMerchantEurPayoutStatus({
          merchantId: m.merchantId,
          environment: m.environment,
          transactionId,
        });
        if (!view) {
          return reply.status(404).send({ error: "Not found", message: "EU payout not found" });
        }
        return view;
      })
  );

  merchantV1GetPair("/v1/merchant-details", "/v1/tylt/merchant-details", (path) =>
    app.get(path, { schema: { response: tyltMerchantProxyResponses } },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      if (!merchantHasInternalTransferScope(m)) {
        return reply.status(403).send({
          error: "Forbidden",
          message: "Missing scope: internal_transfer:create (legacy tylt:internal_transfer accepted)",
        });
      }
      try {
        const res = await tyltGetMerchantDetails(m.environment);
        return replyWithTyltUpstreamJson(reply, res.status, res.json);
      } catch (err) {
        app.log.error(err);
        const mapped = merchantPaymentFlowErrorResponse(err);
        sendMerchantFacingReply(reply, mapped);
        return;
      }
    })
  );

  merchantV1PostPair("/v1/internal-transfer", "/v1/tylt/internal-transfer", (path) =>
    app.post(path, {
      schema: {
        body: z.object({
          fromUUID: z.string().uuid(),
          toUUID: z.string().uuid(),
          settledAmount: z.string(),
          settledCurrency: z.string().min(1),
          comments: z.string().optional(),
        }),
        response: {
          200: z.object({
            transactionId: z.string(),
            status: z.literal("success"),
            platformOrderId: z.string().nullable(),
          }),
          400: merchantFacingError,
          401: errorResponse,
          403: errorResponse,
          503: merchantFacingError,
          500: merchantFacingError,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      if (!merchantHasInternalTransferScope(m)) {
        return reply.status(403).send({
          error: "Forbidden",
          message: "Missing scope: internal_transfer:create (legacy tylt:internal_transfer accepted)",
        });
      }
      if (!(await requireKycAndMarket(m.merchantId, "india", reply))) return;
      const body = request.body as {
        fromUUID: string;
        toUUID: string;
        settledAmount: string;
        settledCurrency: string;
        comments?: string;
      };
      const amt = parseFloat(body.settledAmount);
      const bounds = LIMITS.tyltInternalTransfer;
      if (!Number.isFinite(amt) || amt < bounds.amountMin || amt > bounds.amountMax) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Invalid settledAmount",
        });
      }
      try {
        const response = await withIdempotency(
          { request, reply, merchantId: m.merchantId, body },
          async () => {
            const result = await executeTyltInternalTransfer({
              merchantId: m.merchantId,
              environment: m.environment,
              fromUUID: body.fromUUID,
              toUUID: body.toUUID,
              settledAmount: body.settledAmount,
              settledCurrency: body.settledCurrency,
              comments: body.comments,
            });
            return {
              transactionId: result.transactionId,
              status: "success" as const,
              platformOrderId: result.platformOrderId,
            };
          }
        );
        if (response === undefined) return; // 409 conflict already sent
        return response;
      } catch (err) {
        app.log.error(err);
        const mapped = merchantPaymentFlowErrorResponse(err);
        if (mapped.logDetail) {
          app.log.warn({ logDetail: mapped.logDetail }, "v1 tylt internal transfer merchant-facing error detail");
        }
        sendMerchantFacingReply(reply, mapped);
        return;
      }
    })
  );

  app.post(
    "/v1/payouts",
    {
      schema: {
        body: z.object({
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
          200: z.object({
            transactionId: z.string(),
            status: z.string(),
            amount: z.string(),
            platformOrderId: z.string().optional(),
            recipient: merchantPayoutRecipientSchema,
            estimatedCompletion: z.string().nullable().optional(),
          }),
          400: merchantFacingError,
          401: errorResponse,
          403: errorResponse,
          503: merchantFacingError,
          500: merchantFacingError,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      if (!m.scopes.includes("payout:create") && !m.scopes.includes("*")) {
        return reply.status(403).send({ error: "Forbidden", message: "Missing scope: payout:create" });
      }
      if (!(await requireKycAndMarket(m.merchantId, "bangladesh", reply))) return;
      const body = request.body as { amount: string; benificiaryAccountInfo: { number: string; orgId: string; orgCode: string; orgName: string; holderName: string }; cardHolderInfo: { firstName: string; lastName: string; email: string; phone: string } };
      const amount = parseFloat(body.amount);
      if (!Number.isFinite(amount) || amount < LIMITS.payout.min || amount > LIMITS.payout.max) {
        return reply.status(400).send({ error: `Amount must be between ${LIMITS.payout.min} and ${LIMITS.payout.max} BDT` });
      }
      try {
        const response = await withIdempotency(
          { request, reply, merchantId: m.merchantId, body },
          async () => {
            const result = await createPayoutOrder({
              merchantId: m.merchantId,
              environment: m.environment,
              amount: body.amount,
              baseUrl,
              benificiaryAccountInfo: body.benificiaryAccountInfo,
              cardHolderInfo: body.cardHolderInfo,
            });
            const estimatedCompletion = new Date(Date.now() + 5 * 60 * 1000).toISOString();
            return {
              ...result,
              status: result.status ?? "pending",
              amount: body.amount,
              recipient: {
                benificiaryAccountInfo: body.benificiaryAccountInfo,
                cardHolderInfo: body.cardHolderInfo,
              },
              estimatedCompletion,
            };
          }
        );
        if (response === undefined) return; // 409 conflict already sent
        return response;
      } catch (err) {
        app.log.error(err);
        const mapped = merchantPaymentFlowErrorResponse(err);
        if (mapped.logDetail) {
          app.log.warn({ logDetail: mapped.logDetail }, "v1 payouts merchant-facing error detail");
        }
        sendMerchantFacingReply(reply, mapped);
        return;
      }
    }
  );

  app.post(
    "/v1/wallets",
    {
      schema: {
        body: z.object({
          label: z.string().max(200).optional(),
        }),
        response: {
          201: z.object({
            id: z.string(),
            currency: z.string(),
            balance: z.string(),
            status: z.string(),
            label: z.string().nullable(),
            createdAt: z.string(),
          }),
          400: merchantFacingError,
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      if (!m.scopes.includes("wallets:create") && !m.scopes.includes("*")) {
        return reply.status(403).send({
          error: "Forbidden",
          message: "Missing scope: wallets:create",
        });
      }
      if (!(await requireKycAndMarket(m.merchantId, "bangladesh", reply))) return;
      const body = request.body as { label?: string };
      try {
        const customer = await createCustomerWallet({
          merchantId: m.merchantId,
          environment: m.environment,
          label: body.label,
        });
        return reply.status(201).send({
          id: customer.id,
          currency: customer.currency,
          balance: String(customer.balance),
          status: customer.status,
          label: customer.label ?? null,
          createdAt: customer.createdAt.toISOString(),
        });
      } catch (err) {
        const mapped = merchantPaymentFlowErrorResponse(err);
        sendMerchantFacingReply(reply, mapped);
      }
    }
  );

  app.get(
    "/v1/wallets/:walletId",
    {
      schema: {
        params: z.object({ walletId: z.string().uuid() }),
        response: {
          200: portalWalletBalanceItemSchema,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      if (!m.scopes.includes("wallets:read") && !m.scopes.includes("balance:read") && !m.scopes.includes("*")) {
        return reply.status(403).send({
          error: "Forbidden",
          message: "Missing scope: wallets:read or balance:read",
        });
      }
      const { walletId } = request.params as { walletId: string };
      const [w] = await db
        .select()
        .from(wallets)
        .where(
          and(
            eq(wallets.id, walletId),
            eq(wallets.merchantId, m.merchantId),
            eq(wallets.environment, m.environment),
            eq(wallets.type, "customer")
          )
        )
        .limit(1);
      if (!w) {
        return reply.status(404).send({ error: "Not found", message: "Customer wallet not found" });
      }
      const pendingByCurrency = await sumPendingPayinAmountsByCurrency({
        merchantId: m.merchantId,
        environment: m.environment,
      });
      return presentPortalWalletBalanceItem(
        {
          id: w.id,
          currency: w.currency,
          balance: String(w.balance),
          status: w.status,
          label: w.label,
          updatedAt: w.updatedAt,
          createdAt: w.createdAt,
        },
        pendingByCurrency
      );
    }
  );

  app.post(
    "/v1/transfers",
    {
      schema: {
        body: z.object({
          customerWalletId: z.string().uuid(),
          amount: z.string(),
          reason: z.string().max(500).optional(),
        }),
        response: {
          201: z.object({
            transactionId: z.string(),
            status: z.string(),
            amount: z.string(),
            customerWalletId: z.string(),
            createdAt: z.string(),
          }),
          400: merchantFacingError,
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      if (!m.scopes.includes("transfer:create") && !m.scopes.includes("*")) {
        return reply.status(403).send({
          error: "Forbidden",
          message: "Missing scope: transfer:create",
        });
      }
      if (!(await requireKycAndMarket(m.merchantId, "bangladesh", reply))) return;
      const body = request.body as {
        customerWalletId: string;
        amount: string;
        reason?: string;
      };
      try {
        const tx = await transferToCustomer({
          merchantId: m.merchantId,
          environment: m.environment,
          customerWalletId: body.customerWalletId,
          amount: body.amount,
          reason: body.reason,
        });
        return reply.status(201).send({
          transactionId: tx.id,
          status: tx.status,
          amount: String(tx.amount),
          customerWalletId: body.customerWalletId,
          createdAt: tx.createdAt.toISOString(),
        });
      } catch (err) {
        const mapped = merchantPaymentFlowErrorResponse(err);
        sendMerchantFacingReply(reply, mapped);
      }
    }
  );

  app.get(
    "/v1/balance",
    {
      schema: {
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
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      const [wallet] = await db
        .select({
          balance: wallets.balance,
          currency: wallets.currency,
          updatedAt: wallets.updatedAt,
        })
        .from(wallets)
        .where(
          and(
            eq(wallets.merchantId, m.merchantId),
            eq(wallets.environment, m.environment),
            eq(wallets.type, "merchant"),
            eq(wallets.status, "active")
          )
        )
        .orderBy(sql`(case when ${wallets.currency} = 'BDT' then 0 else 1 end)`)
        .limit(1);
      if (!wallet) {
        return reply.status(200).send({
          balance: "0",
          availableBalance: "0",
          pendingBalance: "0",
          currency: "BDT",
          lastUpdated: null,
          limits: limitsForMerchantWalletCurrency("BDT"),
        });
      }
      const pendingByCurrency = await sumPendingPayinAmountsByCurrency({
        merchantId: m.merchantId,
        environment: m.environment,
      });
      const bal = String(wallet.balance);
      const pendingBalance = pendingByCurrency.get(wallet.currency) ?? "0";
      return {
        balance: bal,
        availableBalance: bal,
        pendingBalance,
        currency: wallet.currency,
        lastUpdated: wallet.updatedAt?.toISOString() ?? null,
        limits: limitsForMerchantWalletCurrency(wallet.currency),
      };
    }
  );

  app.get(
    "/v1/payins/:id",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({
            id: z.string(),
            transactionId: z.string(),
            status: z.string(),
            amount: z.string(),
            paidAmount: z.string().nullable(),
            platformOrderId: z.string().nullable(),
            paymentMethod: z.string().nullable(),
            createdAt: z.string(),
            completedAt: z.string().nullable(),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      const { id } = request.params as { id: string };
      const [tx] = await db
        .select({
          id: transactions.id,
          status: transactions.status,
          amount: transactions.amount,
          paidAmount: transactions.paidAmount,
          externalId: transactions.externalId,
          metadata: transactions.metadata,
          createdAt: transactions.createdAt,
          updatedAt: transactions.updatedAt,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.id, id),
            eq(transactions.merchantId, m.merchantId),
            eq(transactions.environment, m.environment),
            eq(transactions.type, "payin")
          )
        )
        .limit(1);
      if (!tx) return reply.status(404).send({ error: "Not found" });
      const meta = tx.metadata ? (JSON.parse(tx.metadata) as { paymentMethodCode?: string }) : {};
      return {
        id: tx.id,
        transactionId: tx.id,
        status: tx.status,
        amount: String(tx.amount),
        paidAmount: tx.paidAmount ? String(tx.paidAmount) : null,
        platformOrderId: tx.externalId ?? null,
        paymentMethod: meta.paymentMethodCode ?? null,
        createdAt: tx.createdAt.toISOString(),
        completedAt: tx.status === "success" ? tx.updatedAt.toISOString() : null,
      };
    }
  );

  app.get(
    "/v1/payouts/:id",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: z.object({
            id: z.string(),
            transactionId: z.string(),
            status: z.string(),
            amount: z.string(),
            platformOrderId: z.string().nullable(),
            recipient: merchantPayoutRecipientSchema.nullable(),
            createdAt: z.string(),
            completedAt: z.string().nullable(),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      const { id } = request.params as { id: string };
      const [tx] = await db
        .select({
          id: transactions.id,
          status: transactions.status,
          amount: transactions.amount,
          externalId: transactions.externalId,
          metadata: transactions.metadata,
          createdAt: transactions.createdAt,
          updatedAt: transactions.updatedAt,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.id, id),
            eq(transactions.merchantId, m.merchantId),
            eq(transactions.environment, m.environment),
            eq(transactions.type, "payout")
          )
        )
        .limit(1);
      if (!tx) return reply.status(404).send({ error: "Not found" });
      return {
        id: tx.id,
        transactionId: tx.id,
        status: tx.status,
        amount: String(tx.amount),
        platformOrderId: tx.externalId ?? null,
        recipient: parsePayoutRecipientFromMetadata(tx.metadata),
        createdAt: tx.createdAt.toISOString(),
        completedAt: tx.status === "success" ? tx.updatedAt.toISOString() : null,
      };
    }
  );

  const merchantTransactionItemSchema = z.object({
    id: z.string(),
    type: z.string(),
    status: z.string(),
    amount: z.string(),
    paidAmount: z.string().nullable(),
    currency: z.string(),
    rail: z.enum(["bangladesh", "india", "europe", "internal", "unknown"]),
    railLabel: z.string(),
    platformOrderId: z.string().nullable(),
    instanceId: z.string().nullable(),
    createdAt: z.string(),
    completedAt: z.string().nullable(),
  });

  function toMerchantTransactionItem(tx: {
    id: string;
    type: string;
    status: string;
    amount: string;
    paidAmount: string | null;
    currency: string;
    provider: string | null;
    metadata: string | null;
    externalId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    const rail = presentTransactionRail({
      provider: tx.provider,
      currency: tx.currency,
      metadata: tx.metadata,
    });
    return {
      id: tx.id,
      type: tx.type,
      status: tx.status,
      amount: String(tx.amount),
      paidAmount: tx.paidAmount ? String(tx.paidAmount) : null,
      currency: rail.currency,
      rail: rail.rail,
      railLabel: rail.railLabel,
      platformOrderId: tx.externalId ?? null,
      instanceId: tx.externalId ?? null,
      createdAt: tx.createdAt.toISOString(),
      completedAt: tx.status === "success" ? tx.updatedAt.toISOString() : null,
    };
  }

  app.get(
    "/v1/transactions/:transactionId",
    {
      schema: {
        params: z.object({ transactionId: z.string().uuid() }),
        response: {
          200: merchantTransactionItemSchema,
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      const { transactionId } = request.params as { transactionId: string };
      const [tx] = await db
        .select({
          id: transactions.id,
          type: transactions.type,
          status: transactions.status,
          amount: transactions.amount,
          paidAmount: transactions.paidAmount,
          currency: transactions.currency,
          provider: transactions.provider,
          metadata: transactions.metadata,
          externalId: transactions.externalId,
          createdAt: transactions.createdAt,
          updatedAt: transactions.updatedAt,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.id, transactionId),
            eq(transactions.merchantId, m.merchantId),
            eq(transactions.environment, m.environment)
          )
        )
        .limit(1);
      if (!tx) return reply.status(404).send({ error: "Not found", message: "Transaction not found" });
      return toMerchantTransactionItem(tx);
    }
  );

  app.get(
    "/v1/transactions",
    {
      schema: {
        querystring: z.object({
          type: z.enum(["payin", "payout"]).optional(),
          limit: z.coerce.number().min(1).max(100).default(20),
          offset: z.coerce.number().min(0).default(0),
        }),
        response: {
          200: z.object({
            items: z.array(merchantTransactionItemSchema),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      const { type, limit, offset } = request.query as { type?: "payin" | "payout"; limit: number; offset: number };

      const conditions = [eq(transactions.merchantId, m.merchantId), eq(transactions.environment, m.environment)];
      if (type) conditions.push(eq(transactions.type, type));

      const [countResult] = await db
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
          currency: transactions.currency,
          provider: transactions.provider,
          metadata: transactions.metadata,
          externalId: transactions.externalId,
          createdAt: transactions.createdAt,
          updatedAt: transactions.updatedAt,
        })
        .from(transactions)
        .where(and(...conditions))
        .orderBy(desc(transactions.createdAt))
        .limit(limit)
        .offset(offset);

      const items = rows.map((tx) => toMerchantTransactionItem(tx));

      return {
        items,
        total: Number(countResult?.count ?? 0),
        limit,
        offset,
      };
    }
  );

  return app;
}
