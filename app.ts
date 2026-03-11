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
import { sql } from "drizzle-orm";
import { db } from "./src/db/index.js";
import { apiKeyAuth } from "./src/lib/auth.js";
import { merchantAuth } from "./src/lib/merchant-auth.js";

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

  return app;
}
