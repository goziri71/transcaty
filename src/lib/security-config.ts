/**
 * Security-related limits and sanitizers (rate limits, search input).
 * Override via env in production (Render).
 */

function envInt(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

/** Per-IP limit for provider callback POST /webhooks/* */
export function getWebhookRateLimitConfig(): { max: number; timeWindow: string } {
  return {
    max: envInt("WEBHOOK_RATE_LIMIT_MAX", 120),
    timeWindow: process.env.WEBHOOK_RATE_LIMIT_WINDOW?.trim() || "1 minute",
  };
}

/** Per-IP limit for portal/provider login, signup, MFA verify, forgot-password */
export function getAuthLoginRateLimitConfig(): { max: number; timeWindow: string } {
  return {
    max: envInt("AUTH_LOGIN_RATE_LIMIT_MAX", 10),
    timeWindow: process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW?.trim() || "15 minutes",
  };
}

const AUTH_RATE_LIMIT_PATHS = new Set([
  "/portal/auth/login",
  "/portal/auth/signup",
  "/portal/auth/mfa/verify",
  "/portal/auth/forgot-password",
  "/portal/auth/reset-password",
  "/provider/auth/login",
  "/provider/auth/mfa/verify",
  "/provider/auth/forgot-password",
  "/provider/auth/reset-password",
]);

export function isWebhookRoutePath(path: string): boolean {
  return path.startsWith("/webhooks/");
}

export function isAuthRateLimitPath(path: string): boolean {
  return AUTH_RATE_LIMIT_PATHS.has(path);
}

/** Strip ILIKE wildcards so user search cannot broaden matches via % or _. */
export function sanitizeIlikeSearchQuery(q: string, maxLen = 100): string {
  return q
    .trim()
    .slice(0, maxLen)
    .replace(/[%_]/g, "");
}
