/**
 * Structured security signals for log aggregation (Datadog, CloudWatch, etc.).
 * Not a substitute for audit DB rows — lightweight edge/abuse telemetry.
 */

export type SecurityEventType =
  | "webhook.signature_rejected"
  | "auth.login_rate_limited"
  | "rate_limit.exceeded";

export function logSecurityEvent(
  type: SecurityEventType,
  meta: Record<string, unknown> = {}
): void {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      level: "warn",
      securityEvent: type,
      at: new Date().toISOString(),
      ...meta,
    })
  );
}
