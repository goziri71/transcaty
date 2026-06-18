import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { merchantApiIpRules } from "../db/schema/index.js";
import { isIpv4Allowed, normalizeCidrList } from "./ip-cidr.js";
import { logSecurityEvent } from "./security-events.js";

type CachedRule = {
  enabled: boolean;
  enforceMode: string;
  cidrs: string[];
  expiresAt: number;
};

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CachedRule>();

function cacheKey(merchantId: string, environment: string): string {
  return `${merchantId}:${environment}`;
}

export async function loadMerchantIpRule(
  merchantId: string,
  environment: "test" | "live"
): Promise<CachedRule | null> {
  const key = cacheKey(merchantId, environment);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return hit;
  }

  const [row] = await db
    .select()
    .from(merchantApiIpRules)
    .where(and(eq(merchantApiIpRules.merchantId, merchantId), eq(merchantApiIpRules.environment, environment)))
    .limit(1);

  if (!row) {
    cache.set(key, {
      enabled: false,
      enforceMode: "strict",
      cidrs: [],
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return cache.get(key) ?? null;
  }

  const rule: CachedRule = {
    enabled: row.enabled,
    enforceMode: row.enforceMode,
    cidrs: normalizeCidrList(row.cidrs),
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
  cache.set(key, rule);
  return rule;
}

export function invalidateMerchantIpRuleCache(merchantId: string, environment: string): void {
  cache.delete(cacheKey(merchantId, environment));
}

export async function assertMerchantIpAllowed(params: {
  merchantId: string;
  environment: "test" | "live";
  clientIp: string;
}): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const rule = await loadMerchantIpRule(params.merchantId, params.environment);
  if (!rule?.enabled) {
    return { allowed: true };
  }

  const allowed = isIpv4Allowed(params.clientIp, rule.cidrs);
  if (allowed) {
    return { allowed: true };
  }

  if (rule.enforceMode === "log_only") {
    logSecurityEvent({
      type: "merchant.ip_blocked_log_only",
      merchantId: params.merchantId,
      meta: { clientIp: params.clientIp, environment: params.environment },
    });
    return { allowed: true };
  }

  logSecurityEvent({
    type: "merchant.ip_blocked",
    merchantId: params.merchantId,
    meta: { clientIp: params.clientIp, environment: params.environment },
  });
  return { allowed: false, reason: "ip_not_allowed" };
}
