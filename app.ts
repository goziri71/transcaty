import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
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
import { sql, eq, and, count, desc, gt } from "drizzle-orm";
import { db } from "./src/db/index.js";
import {
  wallets,
  transactions,
  idempotencyKeys,
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
  getPayokConfig,
  verifyPayokCallbackWithFallbacks,
  verifyPayokCallbackWithFallbacksDebug,
} from "./services/domestic/bangladesh/index.js";
import { LIMITS } from "./src/lib/limits.js";
import { queueMerchantWebhook } from "./src/lib/merchant-webhook.js";
import { encrypt } from "./src/lib/encryption.js";

export async function buildApp() {
  const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const errorResponse = z.object({ error: z.string(), message: z.string().optional() });

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
    if (!path.startsWith("/webhooks/payok/")) return payload;
    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    (request as FastifyRequest & { rawBody?: string }).rawBody = raw;
    return Readable.from(Buffer.concat(chunks));
  });

  await app.register(helmet, { global: true });
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });
  await app.register(compress, { global: true });
  await app.register(cors, { origin: true });

  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?")[0];
    if (path === "/" || path === "/health") return;
    if (path.startsWith("/webhooks/payok/")) return;
    if (path === "/portal/auth/signup" || path === "/portal/auth/login" || path === "/portal/auth/logout") return;
    if (path === "/provider/auth/login") return;
    if (path.startsWith("/portal/")) return portalAuth(request, reply);
    if (path.startsWith("/provider/")) return providerAuth(request, reply);
    if (path.startsWith("/v1/")) return merchantAuth(request, reply);
    return apiKeyAuth(request, reply);
  });

  await registerPortalRoutes(app);
  await registerProviderAuthRoutes(app);
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
          }),
        },
      },
    },
    async () => {
      await db.execute(sql`SELECT 1`);
      return {
        status: "ok" as const,
        timestamp: new Date().toISOString(),
        database: "connected" as const,
      };
    }
  );

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
      name: "transcaty",
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

  const skipWebhookVerify = process.env.PAYOK_WEBHOOK_SKIP_VERIFY === "1" || process.env.PAYOK_WEBHOOK_SKIP_VERIFY === "true";
  const debugWebhookBody = process.env.PAYOK_WEBHOOK_DEBUG_BODY === "1" || process.env.PAYOK_WEBHOOK_DEBUG_BODY === "true";

  app.post(PAYIN_WEBHOOK_PATH, async (request, reply) => {
    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? "";
    const sign = (request.headers.sign ?? request.headers.Sign) as string | undefined;
    const config = getPayokConfig();
    const verifyDebug =
      !skipWebhookVerify && !!sign && debugWebhookBody
        ? verifyPayokCallbackWithFallbacksDebug(rawBody, payinPathCandidates, sign, config.platformPublicKey)
        : null;
    const verified =
      skipWebhookVerify ||
      (!!sign &&
        (verifyDebug?.verified ??
          verifyPayokCallbackWithFallbacks(rawBody, payinPathCandidates, sign, config.platformPublicKey)));
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
    if (skipWebhookVerify) app.log.warn("payin webhook: PAYOK_WEBHOOK_SKIP_VERIFY enabled – signature not verified");
    const body = typeof request.body === "object" ? request.body : {};
    try {
      const webhook = await handlePayinCallback(body as Parameters<typeof handlePayinCallback>[0]);
      if (webhook) {
        queueMerchantWebhook(webhook.merchantId, webhook.event).catch((e) => app.log.warn(e, "Merchant webhook queue failed"));
      }
    } catch (err) {
      app.log.error(err);
      return reply.status(500).send("INTERNAL");
    }
    return reply.type("text/plain").send("SUCCESS");
  });

  app.post(PAYOUT_WEBHOOK_PATH, async (request, reply) => {
    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? "";
    const sign = (request.headers.sign ?? request.headers.Sign) as string | undefined;
    const config = getPayokConfig();
    const verifyDebug =
      !skipWebhookVerify && !!sign && debugWebhookBody
        ? verifyPayokCallbackWithFallbacksDebug(rawBody, payoutPathCandidates, sign, config.platformPublicKey)
        : null;
    const verified =
      skipWebhookVerify ||
      (!!sign &&
        (verifyDebug?.verified ??
          verifyPayokCallbackWithFallbacks(rawBody, payoutPathCandidates, sign, config.platformPublicKey)));
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
    if (skipWebhookVerify) app.log.warn("payout webhook: PAYOK_WEBHOOK_SKIP_VERIFY enabled – signature not verified");
    const body = typeof request.body === "object" ? request.body : {};
    try {
      const webhook = await handlePayoutCallback(body as Parameters<typeof handlePayoutCallback>[0]);
      if (webhook) {
        queueMerchantWebhook(webhook.merchantId, webhook.event).catch((e) => app.log.warn(e, "Merchant webhook queue failed"));
      }
    } catch (err) {
      app.log.error(err);
      return reply.status(500).send("INTERNAL");
    }
    return reply.type("text/plain").send("SUCCESS");
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

  app.post(
    "/v1/payins",
    {
      schema: {
        body: z.object({
          amount: z.string(),
          paymentMethodCode: z.enum(["BKASH", "NAGAD", "UPAY"]),
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
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      if (!m.scopes.includes("payin:create") && !m.scopes.includes("*")) {
        return reply.status(403).send({ error: "Forbidden", message: "Missing scope: payin:create" });
      }
      if (!(await requireKycVerified(m.merchantId, reply))) return;
      const idemKey = request.headers["idempotency-key"] as string | undefined;
      if (idemKey?.trim()) {
        const [cached] = await db
          .select({ responseSnapshot: idempotencyKeys.responseSnapshot })
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.key, idemKey.trim()),
              eq(idempotencyKeys.merchantId, m.merchantId),
              gt(idempotencyKeys.expiresAt, new Date())
            )
          )
          .limit(1);
        if (cached) return JSON.parse(cached.responseSnapshot);
      }
      const body = request.body as { amount: string; paymentMethodCode: string; customer: { name: string; email: string; phone: string; deviceId: string }; goodsInfo: { name: string; id?: string; price?: string } };
      const amount = parseFloat(body.amount);
      if (amount < LIMITS.payin.min || amount > LIMITS.payin.max) {
        return reply.status(400).send({ error: `Amount must be between ${LIMITS.payin.min} and ${LIMITS.payin.max} BDT` });
      }
      try {
        const result = await createPayinOrder({
          merchantId: m.merchantId,
          amount: body.amount,
          paymentMethodCode: body.paymentMethodCode,
          baseUrl,
          customer: body.customer,
          goodsInfo: body.goodsInfo,
        });
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        const response = {
          ...result,
          status: "pending",
          amount: body.amount,
          expiresAt,
        };
        if (idemKey?.trim()) {
          try {
            await db.insert(idempotencyKeys).values({
              key: idemKey.trim(),
              merchantId: m.merchantId,
              responseSnapshot: JSON.stringify(response),
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            });
          } catch (insertErr: unknown) {
            const code = insertErr && typeof insertErr === "object" && "code" in insertErr ? (insertErr as { code: string }).code : "";
            if (code === "23505") {
              const [cached] = await db
                .select({ responseSnapshot: idempotencyKeys.responseSnapshot })
                .from(idempotencyKeys)
                .where(and(eq(idempotencyKeys.key, idemKey.trim()), eq(idempotencyKeys.merchantId, m.merchantId)))
                .limit(1);
              if (cached) return JSON.parse(cached.responseSnapshot);
            }
            throw insertErr;
          }
        }
        return response;
      } catch (err) {
        app.log.error(err);
        return reply.status(500).send({
          error: "Internal",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
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
            recipient: z.object({ masked: z.string() }),
            estimatedCompletion: z.string().nullable().optional(),
          }),
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      if (!m.scopes.includes("payout:create") && !m.scopes.includes("*")) {
        return reply.status(403).send({ error: "Forbidden", message: "Missing scope: payout:create" });
      }
      if (!(await requireKycVerified(m.merchantId, reply))) return;
      const idemKey = request.headers["idempotency-key"] as string | undefined;
      if (idemKey?.trim()) {
        const [cached] = await db
          .select({ responseSnapshot: idempotencyKeys.responseSnapshot })
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.key, idemKey.trim()),
              eq(idempotencyKeys.merchantId, m.merchantId),
              gt(idempotencyKeys.expiresAt, new Date())
            )
          )
          .limit(1);
        if (cached) return JSON.parse(cached.responseSnapshot);
      }
      const body = request.body as { amount: string; benificiaryAccountInfo: { number: string; orgId: string; orgCode: string; orgName: string; holderName: string }; cardHolderInfo: { firstName: string; lastName: string; email: string; phone: string } };
      const amount = parseFloat(body.amount);
      if (amount < LIMITS.payout.min || amount > LIMITS.payout.max) {
        return reply.status(400).send({ error: `Amount must be between ${LIMITS.payout.min} and ${LIMITS.payout.max} BDT` });
      }
      try {
        const result = await createPayoutOrder({
          merchantId: m.merchantId,
          amount: body.amount,
          baseUrl,
          benificiaryAccountInfo: body.benificiaryAccountInfo,
          cardHolderInfo: body.cardHolderInfo,
        });
        const num = body.benificiaryAccountInfo.number;
        const masked = num.length > 4 ? `****${num.slice(-4)}` : "****";
        const estimatedCompletion = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        const response = {
          ...result,
          status: result.status ?? "pending",
          amount: body.amount,
          recipient: { masked },
          estimatedCompletion,
        };
        if (idemKey?.trim()) {
          try {
            await db.insert(idempotencyKeys).values({
              key: idemKey.trim(),
              merchantId: m.merchantId,
              responseSnapshot: JSON.stringify(response),
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            });
          } catch (insertErr: unknown) {
            const code = insertErr && typeof insertErr === "object" && "code" in insertErr ? (insertErr as { code: string }).code : "";
            if (code === "23505") {
              const [cached] = await db
                .select({ responseSnapshot: idempotencyKeys.responseSnapshot })
                .from(idempotencyKeys)
                .where(and(eq(idempotencyKeys.key, idemKey.trim()), eq(idempotencyKeys.merchantId, m.merchantId)))
                .limit(1);
              if (cached) return JSON.parse(cached.responseSnapshot);
            }
            throw insertErr;
          }
        }
        return response;
      } catch (err) {
        app.log.error(err);
        return reply.status(500).send({
          error: "Internal",
          message: err instanceof Error ? err.message : String(err),
        });
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
            eq(wallets.type, "merchant"),
            eq(wallets.status, "active")
          )
        )
        .limit(1);
      if (!wallet) {
        return reply.status(200).send({
          balance: "0",
          availableBalance: "0",
          pendingBalance: "0",
          currency: "BDT",
          lastUpdated: null,
          limits: LIMITS,
        });
      }
      const bal = String(wallet.balance);
      return {
        balance: bal,
        availableBalance: bal,
        pendingBalance: "0",
        currency: wallet.currency,
        lastUpdated: wallet.updatedAt?.toISOString() ?? null,
        limits: LIMITS,
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
        .where(and(eq(transactions.id, id), eq(transactions.merchantId, m.merchantId), eq(transactions.type, "payin")))
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
            recipient: z.object({ masked: z.string() }),
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
        .where(and(eq(transactions.id, id), eq(transactions.merchantId, m.merchantId), eq(transactions.type, "payout")))
        .limit(1);
      if (!tx) return reply.status(404).send({ error: "Not found" });
      const meta = tx.metadata ? (JSON.parse(tx.metadata) as { benificiaryAccountInfo?: { number?: string } }) : {};
      const num = meta.benificiaryAccountInfo?.number ?? "";
      const masked = num.length > 4 ? `****${num.slice(-4)}` : "****";
      return {
        id: tx.id,
        transactionId: tx.id,
        status: tx.status,
        amount: String(tx.amount),
        platformOrderId: tx.externalId ?? null,
        recipient: { masked },
        createdAt: tx.createdAt.toISOString(),
        completedAt: tx.status === "success" ? tx.updatedAt.toISOString() : null,
      };
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
            items: z.array(
              z.object({
                id: z.string(),
                type: z.string(),
                status: z.string(),
                amount: z.string(),
                paidAmount: z.string().nullable(),
                platformOrderId: z.string().nullable(),
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
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      const { type, limit, offset } = request.query as { type?: "payin" | "payout"; limit: number; offset: number };

      const conditions = [eq(transactions.merchantId, m.merchantId)];
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
          externalId: transactions.externalId,
          createdAt: transactions.createdAt,
          updatedAt: transactions.updatedAt,
        })
        .from(transactions)
        .where(and(...conditions))
        .orderBy(desc(transactions.createdAt))
        .limit(limit)
        .offset(offset);

      const items = rows.map((tx) => ({
        id: tx.id,
        type: tx.type,
        status: tx.status,
        amount: String(tx.amount),
        paidAmount: tx.paidAmount ? String(tx.paidAmount) : null,
        platformOrderId: tx.externalId ?? null,
        createdAt: tx.createdAt.toISOString(),
        completedAt: tx.status === "success" ? tx.updatedAt.toISOString() : null,
      }));

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
