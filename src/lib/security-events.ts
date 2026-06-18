/**
 * Structured security signals for log aggregation (Datadog, CloudWatch, etc.).
 * Not a substitute for audit DB rows — lightweight edge/abuse telemetry.
 */

export type SecurityEventType =
  | "webhook.signature_rejected"
  | "auth.login_rate_limited"
  | "rate_limit.exceeded"
  | "merchant.ip_blocked"
  | "merchant.ip_blocked_log_only";

export function logSecurityEvent(
  event:
    | SecurityEventType
    | { type: SecurityEventType; merchantId?: string; meta?: Record<string, unknown> },
  meta: Record<string, unknown> = {}
): void {
  const type = typeof event === "string" ? event : event.type;
  const merged =
    typeof event === "string"
      ? meta
      : { ...(event.meta ?? {}), ...(event.merchantId ? { merchantId: event.merchantId } : {}) };
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      level: "warn",
      securityEvent: type,
      at: new Date().toISOString(),
      ...merged,
    })
  );
}
