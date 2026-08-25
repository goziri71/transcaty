import type { FastifyRequest } from "fastify";

/**
 * Client IP as resolved by Fastify's `trustProxy` config (see app.ts), which
 * walks X-Forwarded-For from the trusted-proxy end inward using `proxy-addr`.
 * Do NOT parse X-Forwarded-For manually here — the leftmost entry is fully
 * attacker-controlled and must never be trusted for allowlist/security decisions.
 */
export function getTrustedClientIp(request: FastifyRequest): string {
  return request.ip;
}
