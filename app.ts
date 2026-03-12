import Fastify, { type FastifyRequest } from "fastify";
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
import { sql, eq, and } from "drizzle-orm";
import { db } from "./src/db/index.js";
import { wallets, transactions } from "./src/db/schema/index.js";
import { apiKeyAuth } from "./src/lib/auth.js";
import { merchantAuth } from "./src/lib/merchant-auth.js";
import { verifyPayokCallback } from "./src/lib/payok-signature.js";
import { getPayokConfig } from "./src/lib/payok-config.js";
import { createPayinOrder, handlePayinCallback } from "./services/domestic/payok-payin.js";
import { createPayoutOrder, handlePayoutCallback } from "./services/domestic/payok-payout.js";

export async function buildApp() {
  const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    const raw = typeof body === "string" ? body : body?.toString("utf8") ?? "";
    (req as FastifyRequest & { rawBody?: string }).rawBody = raw;
    try {
      done(null, raw ? JSON.parse(raw) : {});
    } catch (e) {
      done(e as Error, undefined);
    }
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
    if (path.startsWith("/v1/")) return merchantAuth(request, reply);
    return apiKeyAuth(request, reply);
  });

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

  const PAYIN_WEBHOOK_PATH = "/webhooks/payok/payin";
  const PAYOUT_WEBHOOK_PATH = "/webhooks/payok/payout";

  app.post(PAYIN_WEBHOOK_PATH, async (request, reply) => {
    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? "";
    const sign = request.headers.sign as string | undefined;
    const config = getPayokConfig();
    if (!sign || !verifyPayokCallback(rawBody, PAYIN_WEBHOOK_PATH, sign, config.platformPublicKey)) {
      return reply.status(401).send("Invalid signature");
    }
    const body = typeof request.body === "object" ? request.body : {};
    try {
      await handlePayinCallback(body as Parameters<typeof handlePayinCallback>[0]);
    } catch (err) {
      app.log.error(err);
      return reply.status(500).send("INTERNAL");
    }
    return reply.type("text/plain").send("SUCCESS");
  });

  app.post(PAYOUT_WEBHOOK_PATH, async (request, reply) => {
    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? "";
    const sign = request.headers.sign as string | undefined;
    const config = getPayokConfig();
    if (!sign || !verifyPayokCallback(rawBody, PAYOUT_WEBHOOK_PATH, sign, config.platformPublicKey)) {
      return reply.status(401).send("Invalid signature");
    }
    const body = typeof request.body === "object" ? request.body : {};
    try {
      await handlePayoutCallback(body as Parameters<typeof handlePayoutCallback>[0]);
    } catch (err) {
      app.log.error(err);
      return reply.status(500).send("INTERNAL");
    }
    return reply.type("text/plain").send("SUCCESS");
  });

  const baseUrl = process.env.APP_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

  const errorResponse = z.object({ error: z.string(), message: z.string().optional() });

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
            paymentInfo: z.unknown().optional(),
            platformOrderId: z.string().optional(),
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
      const body = request.body as { amount: string; paymentMethodCode: string; customer: { name: string; email: string; phone: string; deviceId: string }; goodsInfo: { name: string; id?: string; price?: string } };
      const amount = parseFloat(body.amount);
      if (amount < 200 || amount > 25000) {
        return reply.status(400).send({ error: "Amount must be between 200 and 25000 BDT" });
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
        return result;
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
            status: z.string().optional(),
            platformOrderId: z.string().optional(),
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
      const body = request.body as { amount: string; benificiaryAccountInfo: { number: string; orgId: string; orgCode: string; orgName: string; holderName: string }; cardHolderInfo: { firstName: string; lastName: string; email: string; phone: string } };
      const amount = parseFloat(body.amount);
      if (amount < 100 || amount > 25000) {
        return reply.status(400).send({ error: "Amount must be between 100 and 25000 BDT" });
      }
      try {
        const result = await createPayoutOrder({
          merchantId: m.merchantId,
          amount: body.amount,
          baseUrl,
          benificiaryAccountInfo: body.benificiaryAccountInfo,
          cardHolderInfo: body.cardHolderInfo,
        });
        return result;
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
            currency: z.string(),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const m = request.merchant;
      if (!m) return reply.status(401).send({ error: "Unauthorized" });
      const [wallet] = await db
        .select({ balance: wallets.balance, currency: wallets.currency })
        .from(wallets)
        .where(
          and(
            eq(wallets.merchantId, m.merchantId),
            eq(wallets.type, "merchant"),
            eq(wallets.status, "active")
          )
        )
        .limit(1);
      if (!wallet) return reply.status(200).send({ balance: "0", currency: "BDT" });
      return { balance: String(wallet.balance), currency: wallet.currency };
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
            status: z.string(),
            amount: z.string(),
            paidAmount: z.string().nullable(),
            externalId: z.string().nullable(),
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
        .select({ id: transactions.id, status: transactions.status, amount: transactions.amount, paidAmount: transactions.paidAmount, externalId: transactions.externalId })
        .from(transactions)
        .where(and(eq(transactions.id, id), eq(transactions.merchantId, m.merchantId), eq(transactions.type, "payin")))
        .limit(1);
      if (!tx) return reply.status(404).send({ error: "Not found" });
      return { ...tx, paidAmount: tx.paidAmount ?? null, externalId: tx.externalId ?? null };
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
            status: z.string(),
            amount: z.string(),
            externalId: z.string().nullable(),
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
        .select({ id: transactions.id, status: transactions.status, amount: transactions.amount, externalId: transactions.externalId })
        .from(transactions)
        .where(and(eq(transactions.id, id), eq(transactions.merchantId, m.merchantId), eq(transactions.type, "payout")))
        .limit(1);
      if (!tx) return reply.status(404).send({ error: "Not found" });
      return { ...tx, externalId: tx.externalId ?? null };
    }
  );

  return app;
}
