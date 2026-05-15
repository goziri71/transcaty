/**
 * Tylt API credentials per merchant key environment (test | live).
 * Tylt issues separate API key + secret per enabled service; we model
 * the common split as **payin** vs **payout** (plus shared fallbacks).
 * Plain or *_ENC via getSecret (same pattern as other provider configs).
 */
import { getSecret } from "../../../src/lib/encryption.js";

export type TyltMerchantEnvironment = "test" | "live";

/** Which Tylt credential pair to use for outbound calls and webhooks. */
export type TyltCredentialRole = "payin" | "payout";

export type TyltConfig = {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
};

type PartialCfg = {
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
};

function coalesce(...vals: (string | undefined)[]): string | undefined {
  for (const v of vals) {
    const t = v?.trim();
    if (t) return t;
  }
  return undefined;
}

function pickLegacyPerEnv(prefix: "TYLT_TEST_" | "TYLT_LIVE_"): PartialCfg {
  return {
    apiKey: getSecret(`${prefix}API_KEY`, `${prefix}API_KEY_ENC`)?.trim(),
    apiSecret: getSecret(`${prefix}API_SECRET`, `${prefix}API_SECRET_ENC`)?.trim(),
    baseUrl: getSecret(`${prefix}BASE_URL`, `${prefix}BASE_URL_ENC`)?.trim(),
  };
}

function pickRolePerEnv(prefix: "TYLT_TEST_" | "TYLT_LIVE_", role: TyltCredentialRole): PartialCfg {
  const mid = role === "payin" ? "PAYIN_" : "PAYOUT_";
  return {
    apiKey: getSecret(`${prefix}${mid}API_KEY`, `${prefix}${mid}API_KEY_ENC`)?.trim(),
    apiSecret: getSecret(`${prefix}${mid}API_SECRET`, `${prefix}${mid}API_SECRET_ENC`)?.trim(),
    baseUrl: getSecret(`${prefix}${mid}BASE_URL`, `${prefix}${mid}BASE_URL_ENC`)?.trim(),
  };
}

function pickShared(): PartialCfg {
  return {
    apiKey: getSecret("TYLT_API_KEY", "TYLT_API_KEY_ENC")?.trim(),
    apiSecret: getSecret("TYLT_API_SECRET", "TYLT_API_SECRET_ENC")?.trim(),
    baseUrl: getSecret("TYLT_BASE_URL", "TYLT_BASE_URL_ENC")?.trim(),
  };
}

/**
 * Resolved credentials for outbound Tylt HTTP and webhook HMAC verification.
 *
 * Precedence per field: `TYLT_{TEST|LIVE}_{PAYIN|PAYOUT}_*`, then legacy
 * `TYLT_{TEST|LIVE}_*`, then shared `TYLT_*`. Base URL defaults to
 * https://api.tylt.money when still empty.
 */
export function getTyltCredentials(
  environment: TyltMerchantEnvironment,
  role: TyltCredentialRole
): TyltConfig | null {
  const prefix = environment === "live" ? "TYLT_LIVE_" : "TYLT_TEST_";
  const roleSpecific = pickRolePerEnv(prefix, role);
  const legacy = pickLegacyPerEnv(prefix);
  const shared = pickShared();

  const apiKey = coalesce(roleSpecific.apiKey, legacy.apiKey, shared.apiKey);
  const apiSecret = coalesce(roleSpecific.apiSecret, legacy.apiSecret, shared.apiSecret);
  const baseUrlRaw =
    coalesce(roleSpecific.baseUrl, legacy.baseUrl, shared.baseUrl) ?? "https://api.tylt.money";

  if (!apiKey || !apiSecret) return null;

  return {
    apiKey,
    apiSecret,
    baseUrl: baseUrlRaw.replace(/\/$/, ""),
  };
}

/**
 * @deprecated Use {@link getTyltCredentials}(environment, "payin"). Kept for
 * callers that assumed a single Tylt key; pay-in credentials are the closest match.
 */
export function getTyltConfig(environment: TyltMerchantEnvironment): TyltConfig | null {
  return getTyltCredentials(environment, "payin");
}

export function assertTyltConfigured(
  environment: TyltMerchantEnvironment,
  role: TyltCredentialRole = "payin"
): TyltConfig {
  const c = getTyltCredentials(environment, role);
  if (!c) {
    throw new Error(
      role === "payout"
        ? "Tylt payout credentials are not configured (set TYLT_*_PAYOUT_* or legacy TYLT_* per env)"
        : "Tylt pay-in credentials are not configured (set TYLT_*_PAYIN_* or legacy TYLT_* per env)"
    );
  }
  return c;
}
