import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { merchantApiIpRules } from "../db/schema/index.js";
import { invalidateMerchantIpRuleCache } from "./merchant-ip-whitelist.js";
import { normalizeCidrList, validateCidrList } from "./ip-cidr.js";

export type MerchantApiIpEnvironment = "test" | "live";

export type MerchantApiIpRulesView = {
  merchantId: string;
  environment: MerchantApiIpEnvironment;
  enabled: boolean;
  enforceMode: string;
  cidrs: string[];
  notes: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
};

export type MerchantApiIpRulesUpsert = {
  environment: MerchantApiIpEnvironment;
  enabled: boolean;
  enforceMode: "strict" | "log_only";
  cidrs: string[];
  notes?: string | null;
};

export function validateMerchantApiIpRulesInput(
  input: MerchantApiIpRulesUpsert
): { valid: true } | { valid: false; message: string } {
  if (input.enabled && input.cidrs.length === 0) {
    return { valid: false, message: "At least one CIDR or IPv4 is required when the allowlist is enabled" };
  }
  if (input.enabled) {
    const validation = validateCidrList(input.cidrs);
    if (!validation.valid) {
      return { valid: false, message: validation.errors.join("; ") };
    }
  } else if (input.cidrs.length > 0) {
    const validation = validateCidrList(input.cidrs);
    if (!validation.valid) {
      return { valid: false, message: validation.errors.join("; ") };
    }
  }
  return { valid: true };
}

export async function getMerchantApiIpRules(
  merchantId: string,
  environment: MerchantApiIpEnvironment
): Promise<MerchantApiIpRulesView> {
  const [row] = await db
    .select()
    .from(merchantApiIpRules)
    .where(and(eq(merchantApiIpRules.merchantId, merchantId), eq(merchantApiIpRules.environment, environment)))
    .limit(1);

  if (!row) {
    return {
      merchantId,
      environment,
      enabled: false,
      enforceMode: "strict",
      cidrs: [],
      notes: null,
      updatedBy: null,
      updatedAt: null,
    };
  }

  return {
    merchantId,
    environment: row.environment as MerchantApiIpEnvironment,
    enabled: row.enabled,
    enforceMode: row.enforceMode,
    cidrs: normalizeCidrList(row.cidrs),
    notes: row.notes,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function upsertMerchantApiIpRules(params: {
  merchantId: string;
  updatedBy: string;
  rules: MerchantApiIpRulesUpsert;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const validation = validateMerchantApiIpRulesInput(params.rules);
  if (!validation.valid) {
    return { ok: false, message: validation.message };
  }

  await db
    .insert(merchantApiIpRules)
    .values({
      merchantId: params.merchantId,
      environment: params.rules.environment,
      enabled: params.rules.enabled,
      enforceMode: params.rules.enforceMode,
      cidrs: params.rules.cidrs,
      notes: params.rules.notes ?? null,
      updatedBy: params.updatedBy,
    })
    .onConflictDoUpdate({
      target: [merchantApiIpRules.merchantId, merchantApiIpRules.environment],
      set: {
        enabled: params.rules.enabled,
        enforceMode: params.rules.enforceMode,
        cidrs: params.rules.cidrs,
        notes: params.rules.notes ?? null,
        updatedBy: params.updatedBy,
        updatedAt: new Date(),
      },
    });

  invalidateMerchantIpRuleCache(params.merchantId, params.rules.environment);
  return { ok: true };
}
