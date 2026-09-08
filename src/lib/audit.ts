/**
 * Audit trail for important actions.
 * Logs structured JSON to stdout for aggregation (e.g. Datadog, CloudWatch).
 * When merchantId is set, also persists to merchant_audit_log for portal visibility.
 */
import { db } from "../db/index.js";
import { merchantAuditLog } from "../db/schema/index.js";

export type AuditAction =
  | "payment.created"
  | "payment.completed"
  | "payment.failed"
  | "payment.disputed"
  | "payout.created"
  | "payout.completed"
  | "payout.failed"
  | "payout.provider_fee.debited"
  | "payout.provider_fee.debit_failed"
  | "auth.failed"
  | "auth.password_reset_requested"
  | "auth.password_reset_completed"
  | "config.changed"
  | "provider.merchant.status_changed"
  | "provider.merchant.kyc_changed"
  | "provider.merchant.pricing_changed"
  | "provider.merchant.market_updated"
  | "merchant.market.requested"
  | "provider.customer.status_changed"
  | "provider.wallet.adjusted"
  | "provider.transaction.status_changed"
  | "provider.transaction.reconciled"
  | "provider.tylt.crossramp.reconcile"
  | "provider.payok.payin.reconcile"
  | "provider.tekko.pyusd.reconcile"
  | "provider.tekko.ngn.reconcile"
  | "provider.tekko.ngn.va_credit"
  | "provider.tekko.ngn.bvn.sync"
  | "provider.merchant.rates_changed"
  | "provider.merchant.fee_schedule_changed"
  | "provider.merchant.ip_whitelist_changed"
  | "provider.tylt.internal_transfer.completed"
  | "provider.tylt.internal_transfer.failed"
  | "billing.fee_applied"
  | "billing.fee_skipped"
  | "portal.session.login"
  | "portal.session.mfa_completed"
  | "portal.session.logout"
  | "provider.session.logout"
  | "provider.step_up.issued"
  | "portal.signup"
  | "portal.payin.failed"
  | "portal.ngn.va.provisioned"
  | "portal.ngn.va.failed"
  | "tekko.ngn.bvn.failed"
  | "tekko.ngn.bvn.verified"
  | "tekko.ngn.bvn.status"
  | "tekko.ngn.bvn.ops_sync"
  | "tekko.ngn.bvn.payout_blocked"
  | "merchant.market_compliance.bvn.submitted"
  | "tekko.ngn.va.provisioned"
  | "tekko.ngn.va.credit_out_of_limits"
  | "portal.payout.failed"
  | "portal.transfer.created"
  | "portal.refund.created"
  | "portal.customer.wallet_created"
  | "portal.customer.wallet_status_changed"
  | "portal.api_key.created"
  | "portal.api_key.revoked"
  | "portal.api_key.auto_revoked_prior_live"
  | "portal.api_ip_rules.updated"
  | "portal.webhook.updated"
  | "portal.step_up.issued"
  | "portal.session.revoke_all"
  | "portal.eur_payout.created"
  | "portal.eur_payout.approved"
  | "portal.eur_payout.failed"
  | "portal.cpg_payout.created"
  | "portal.cpg_payout.failed"
  | "merchant.payout_pin.set"
  | "merchant.payout_pin.changed"
  | "merchant.payout_pin.reset"
  | "merchant.payout_pin.reset_requested"
  | "merchant.payout_pin.failed"
  | "portal.h2h_payin.created"
  | "portal.h2h_payin.confirmed";

export interface AuditEntry {
  action: AuditAction;
  actor?: string;
  resource?: string;
  meta?: Record<string, unknown>;
  timestamp: string;
  /** When set, event is stored for merchant portal audit log. */
  merchantId?: string;
  merchantUserId?: string;
  actorEmail?: string;
}

function persistMerchantAudit(entry: Omit<AuditEntry, "timestamp">): void {
  if (!entry.merchantId) return;
  void db
    .insert(merchantAuditLog)
    .values({
      merchantId: entry.merchantId,
      merchantUserId: entry.merchantUserId,
      actorEmail: entry.actorEmail,
      action: entry.action,
      resource: entry.resource,
      meta: entry.meta ?? null,
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ audit_persist_failed: msg }));
    });
}

export function audit(entry: Omit<AuditEntry, "timestamp">): void {
  const full: AuditEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify({ audit: full }));
  persistMerchantAudit(entry);
}
