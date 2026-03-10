import Fastify from "fastify";
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

export async function buildApp() {
  const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

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

  return app;
}
