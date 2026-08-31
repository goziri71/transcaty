import type { FastifyRequest } from "fastify";
import { CLOUDFLARE_IPV4_CIDRS } from "./cloudflare-ips.js";
import { isIpv4Allowed } from "./ip-cidr.js";

/**
 * Client IP as resolved by Fastify's `trustProxy` config (see app.ts), which
 * walks X-Forwarded-For from the trusted-proxy end inward using `proxy-addr`.
 * Do NOT parse X-Forwarded-For manually here — the leftmost entry is fully
 * attacker-controlled and must never be trusted for allowlist/security decisions.
 *
 * This service sits behind Cloudflare. Cloudflare doesn't always relay a
 * usable X-Forwarded-For chain to the origin (e.g. no prior hop set one), so
 * `request.ip` can fall back to Cloudflare's own edge IP instead of the real
 * caller -- this is what produced the merchant.ip_blocked false positives on
 * PYUSD and India H2H pay-ins. Cloudflare always sets `CF-Connecting-IP` to
 * the true connecting client on every proxied request, so prefer it -- but
 * only once we've confirmed the direct TCP peer is a genuine Cloudflare edge
 * IP, so a request that somehow reaches the origin without going through
 * Cloudflare can't spoof this header.
 */
export function getTrustedClientIp(request: FastifyRequest): string {
  const socketAddr = request.socket?.remoteAddress;
  const cfConnectingIp = request.headers["cf-connecting-ip"];

  if (
    socketAddr &&
    isIpv4Allowed(socketAddr, CLOUDFLARE_IPV4_CIDRS) &&
    typeof cfConnectingIp === "string" &&
    cfConnectingIp.trim().length > 0
  ) {
    return cfConnectingIp.trim();
  }

  return request.ip;
}
