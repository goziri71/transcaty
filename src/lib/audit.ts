/**
 * Audit trail for important actions.
 * Logs structured JSON to stdout for aggregation (e.g. Datadog, CloudWatch).
 */
export type AuditAction =
  | "payment.created"
  | "payment.completed"
  | "payment.failed"
  | "payout.created"
  | "payout.completed"
  | "payout.failed"
  | "auth.failed"
  | "config.changed"
  | "provider.merchant.status_changed"
  | "provider.merchant.kyc_changed"
  | "provider.customer.status_changed"
  | "provider.wallet.adjusted"
  | "provider.transaction.status_changed"
  | "provider.transaction.reconciled";

export interface AuditEntry {
  action: AuditAction;
  actor?: string;
  resource?: string;
  meta?: Record<string, unknown>;
  timestamp: string;
}

export function audit(entry: Omit<AuditEntry, "timestamp">): void {
  const full: AuditEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify({ audit: full }));
}
