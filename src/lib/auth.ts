import type { FastifyRequest, FastifyReply } from "fastify";
import { getSecret } from "./encryption.js";

/**
 * API key auth: checks X-API-Key or Authorization: Bearer <key>.
 * Use API_KEY or API_KEY_ENC in .env.
 */
export async function apiKeyAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const expected = getSecret("API_KEY", "API_KEY_ENC");
  if (!expected) {
    request.log.warn("API_KEY not configured - auth disabled");
    return;
  }

  const headerKey = request.headers["x-api-key"];
  const authHeader = request.headers.authorization;
  const bearerKey = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : undefined;

  const provided = headerKey ?? bearerKey;
  if (!provided || provided !== expected) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Invalid or missing API key",
    });
  }
}
