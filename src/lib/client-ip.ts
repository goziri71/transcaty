import type { FastifyRequest } from "fastify";

/** First hop from X-Forwarded-For when present (Render/Cloudflare), else socket IP. */
export function getTrustedClientIp(request: FastifyRequest): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]!.trim();
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return String(forwarded[0]).split(",")[0]!.trim();
  }
  return request.ip;
}
