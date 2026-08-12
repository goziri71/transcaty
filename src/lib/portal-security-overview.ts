/**
 * Aggregated security / developer settings for the merchant portal.
 */
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  merchantApiKeys,
  merchantAuditLog,
  merchantUsers,
  merchants,
} from "../db/schema/index.js";
import { getMerchantApiIpRules } from "./merchant-api-ip-rules.js";

const SECURITY_AUDIT_ACTIONS = [
  "portal.session.login",
  "portal.session.mfa_completed",
  "portal.session.logout",
  "portal.session.revoke_all",
  "portal.step_up.issued",
  "portal.api_key.created",
  "portal.api_key.revoked",
  "portal.api_key.auto_revoked_prior_live",
  "portal.api_ip_rules.updated",
  "portal.webhook.updated",
  "auth.password_reset_requested",
  "auth.password_reset_completed",
  "auth.failed",
] as const;

export async function buildPortalSecurityOverview(params: {
  merchantId: string;
  merchantUserId: string;
}): Promise<{
  mfa: {
    enabled: boolean;
    pendingSetup: boolean;
  };
  sessions: {
    sessionVersion: number;
    note: string;
  };
  apiKeys: {
    active: number;
    revoked: number;
    total: number;
    byEnvironment: { test: number; live: number };
  };
  webhook: {
    configured: boolean;
  };
  ipAllowlist: {
    test: { enabled: boolean; cidrCount: number };
    live: { enabled: boolean; cidrCount: number };
  };
  recentSecurityActions: Array<{
    id: string;
    action: string;
    resource: string | null;
    actorEmail: string | null;
    createdAt: string;
  }>;
  links: {
    apiKeys: string;
    ipRules: string;
    webhook: string;
    auditLog: string;
    stepUp: string;
    revokeSessions: string;
    mfa: string;
  };
}> {
  const [[user], [merchant], keyCounts, [testRules, liveRules], recent] = await Promise.all([
    db
      .select({
        mfaEnabled: merchantUsers.mfaEnabled,
        mfaPending: merchantUsers.mfaPending,
        sessionVersion: merchantUsers.sessionVersion,
      })
      .from(merchantUsers)
      .where(eq(merchantUsers.id, params.merchantUserId))
      .limit(1),
    db
      .select({ webhookUrl: merchants.webhookUrl })
      .from(merchants)
      .where(eq(merchants.id, params.merchantId))
      .limit(1),
    db
      .select({
        status: merchantApiKeys.status,
        environment: merchantApiKeys.environment,
        n: count(),
      })
      .from(merchantApiKeys)
      .where(eq(merchantApiKeys.merchantId, params.merchantId))
      .groupBy(merchantApiKeys.status, merchantApiKeys.environment),
    Promise.all([
      getMerchantApiIpRules(params.merchantId, "test"),
      getMerchantApiIpRules(params.merchantId, "live"),
    ]),
    db
      .select({
        id: merchantAuditLog.id,
        action: merchantAuditLog.action,
        resource: merchantAuditLog.resource,
        actorEmail: merchantAuditLog.actorEmail,
        createdAt: merchantAuditLog.createdAt,
      })
      .from(merchantAuditLog)
      .where(
        and(
          eq(merchantAuditLog.merchantId, params.merchantId),
          inArray(merchantAuditLog.action, [...SECURITY_AUDIT_ACTIONS])
        )
      )
      .orderBy(desc(merchantAuditLog.createdAt))
      .limit(20),
  ]);

  let active = 0;
  let revoked = 0;
  let testActive = 0;
  let liveActive = 0;
  for (const row of keyCounts) {
    const n = Number(row.n ?? 0);
    if (row.status === "active") {
      active += n;
      if (row.environment === "test") testActive += n;
      if (row.environment === "live") liveActive += n;
    } else if (row.status === "revoked") {
      revoked += n;
    }
  }

  return {
    mfa: {
      enabled: !!user?.mfaEnabled,
      pendingSetup: !!user?.mfaPending,
    },
    sessions: {
      sessionVersion: user?.sessionVersion ?? 0,
      note: "Sessions are JWT-based. Use revoke-sessions to invalidate all devices; individual session listing is not available.",
    },
    apiKeys: {
      active,
      revoked,
      total: active + revoked,
      byEnvironment: { test: testActive, live: liveActive },
    },
    webhook: {
      configured: !!(merchant?.webhookUrl && merchant.webhookUrl.trim()),
    },
    ipAllowlist: {
      test: { enabled: testRules.enabled, cidrCount: testRules.cidrs.length },
      live: { enabled: liveRules.enabled, cidrCount: liveRules.cidrs.length },
    },
    recentSecurityActions: recent.map((r) => ({
      id: r.id,
      action: r.action,
      resource: r.resource,
      actorEmail: r.actorEmail,
      createdAt: r.createdAt.toISOString(),
    })),
    links: {
      apiKeys: "/portal/me/api-keys",
      ipRules: "/portal/me/api-ip-rules",
      webhook: "/portal/me/webhook",
      auditLog: "/portal/me/audit-log",
      stepUp: "/portal/auth/step-up",
      revokeSessions: "/portal/auth/revoke-sessions",
      mfa: "/portal/me/mfa/status",
    },
  };
}

export { SECURITY_AUDIT_ACTIONS };
