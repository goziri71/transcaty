import type { FastifyRequest } from "fastify";
import { audit, type AuditAction } from "./audit.js";

/** Persist provider merchant-scoped actions to merchant_audit_log + stdout. */
export function providerMerchantAudit(
  request: FastifyRequest,
  entry: {
    action: AuditAction;
    merchantId: string;
    resource?: string;
    meta?: Record<string, unknown>;
  }
): void {
  const p = request.provider;
  const actor = p?.email
    ? `provider:${p.role}:${p.email}`
    : p?.providerUserId
      ? `provider:${p.role}:${p.providerUserId}`
      : `provider:${p?.role ?? "unknown"}`;

  audit({
    action: entry.action,
    actor,
    actorEmail: p?.email,
    merchantId: entry.merchantId,
    resource: entry.resource ?? entry.merchantId,
    meta: entry.meta,
  });
}
