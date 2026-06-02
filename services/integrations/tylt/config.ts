/**
 * Tylt API credentials per merchant key environment (test | live).
 * TL Pay issues separate API key + secret per product/service.
 *
 * Profiles (recommended):
 * - `eur_payin` / `eur_payout` — EU Open Banking (Prime Fiat)
 * - `india_payin` / `india_payout` — India UPI H2H, CrossRamp, CPG
 *
 * Fallback per profile: `TYLT_{TEST|LIVE}_{EUR|INDIA}_{PAYIN|PAYOUT}_*`, then shared
 * `TYLT_{TEST|LIVE}_{PAYIN|PAYOUT}_*`, then legacy `TYLT_{TEST|LIVE}_*`, then `TYLT_*`.
 */
import { getSecret } from "../../../src/lib/encryption.js";

export type TyltMerchantEnvironment = "test" | "live";

/** @deprecated Prefer {@link TyltCredentialProfile} for lane-specific keys. */
export type TyltCredentialRole = "payin" | "payout";

/** TL Pay credential lane — maps to dedicated env var prefixes. */
export type TyltCredentialProfile = "eur_payin" | "eur_payout" | "india_payin" | "india_payout";

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

const PROFILE_ENV_MID: Record<TyltCredentialProfile, string> = {
  eur_payin: "EUR_PAYIN_",
  eur_payout: "EUR_PAYOUT_",
  india_payin: "INDIA_PAYIN_",
  india_payout: "INDIA_PAYOUT_",
};

function coalesce(...vals: (string | undefined)[]): string | undefined {
  for (const v of vals) {
    const t = v?.trim();
    if (t) return t;
  }
  return undefined;
}

function pickEnvBlock(prefix: "TYLT_TEST_" | "TYLT_LIVE_", envMid: string): PartialCfg {
  return {
    apiKey: getSecret(`${prefix}${envMid}API_KEY`, `${prefix}${envMid}API_KEY_ENC`)?.trim(),
    apiSecret: getSecret(`${prefix}${envMid}API_SECRET`, `${prefix}${envMid}API_SECRET_ENC`)?.trim(),
    baseUrl: getSecret(`${prefix}${envMid}BASE_URL`, `${prefix}${envMid}BASE_URL_ENC`)?.trim(),
  };
}

function pickLegacyPerEnv(prefix: "TYLT_TEST_" | "TYLT_LIVE_"): PartialCfg {
  return pickEnvBlock(prefix, "");
}

function pickRolePerEnv(prefix: "TYLT_TEST_" | "TYLT_LIVE_", role: TyltCredentialRole): PartialCfg {
  return pickEnvBlock(prefix, role === "payin" ? "PAYIN_" : "PAYOUT_");
}

function pickShared(): PartialCfg {
  return {
    apiKey: getSecret("TYLT_API_KEY", "TYLT_API_KEY_ENC")?.trim(),
    apiSecret: getSecret("TYLT_API_SECRET", "TYLT_API_SECRET_ENC")?.trim(),
    baseUrl: getSecret("TYLT_BASE_URL", "TYLT_BASE_URL_ENC")?.trim(),
  };
}

function roleForProfile(profile: TyltCredentialProfile): TyltCredentialRole {
  return profile === "eur_payout" || profile === "india_payout" ? "payout" : "payin";
}

function resolveConfig(layers: PartialCfg[]): TyltConfig | null {
  const apiKey = coalesce(...layers.map((l) => l.apiKey));
  const apiSecret = coalesce(...layers.map((l) => l.apiSecret));
  const baseUrlRaw = coalesce(...layers.map((l) => l.baseUrl)) ?? "https://api.tylt.money";
  if (!apiKey || !apiSecret) return null;
  return {
    apiKey,
    apiSecret,
    baseUrl: baseUrlRaw.replace(/\/$/, ""),
  };
}

/**
 * Resolve credentials for a product lane (EU vs India, pay-in vs pay-out).
 */
export function getTyltCredentialsForProfile(
  environment: TyltMerchantEnvironment,
  profile: TyltCredentialProfile
): TyltConfig | null {
  const prefix = environment === "live" ? "TYLT_LIVE_" : "TYLT_TEST_";
  const role = roleForProfile(profile);
  return resolveConfig([
    pickEnvBlock(prefix, PROFILE_ENV_MID[profile]),
    pickRolePerEnv(prefix, role),
    pickLegacyPerEnv(prefix),
    pickShared(),
  ]);
}

/**
 * Generic pay-in / pay-out role (no EUR_/INDIA_ prefix). Prefer {@link getTyltCredentialsForProfile}.
 */
export function getTyltCredentials(
  environment: TyltMerchantEnvironment,
  role: TyltCredentialRole
): TyltConfig | null {
  const prefix = environment === "live" ? "TYLT_LIVE_" : "TYLT_TEST_";
  return resolveConfig([pickRolePerEnv(prefix, role), pickLegacyPerEnv(prefix), pickShared()]);
}

/** @deprecated Use {@link getTyltCredentialsForProfile}(environment, "india_payin"). */
export function getTyltConfig(environment: TyltMerchantEnvironment): TyltConfig | null {
  return getTyltCredentialsForProfile(environment, "india_payin");
}

export function assertTyltConfiguredForProfile(
  environment: TyltMerchantEnvironment,
  profile: TyltCredentialProfile
): TyltConfig {
  const c = getTyltCredentialsForProfile(environment, profile);
  if (!c) {
    const mid = PROFILE_ENV_MID[profile];
    throw new Error(
      `Tylt credentials are not configured for profile ${profile} (set TYLT_*_${mid}API_KEY and TYLT_*_${mid}API_SECRET, or fallbacks)`
    );
  }
  return c;
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

/** Webhook verification order when lane is unknown (unified callback URL). */
export const TYLT_PAYIN_PROFILE_VERIFY_ORDER: TyltCredentialProfile[] = [
  "eur_payin",
  "india_payin",
];

export const TYLT_PAYOUT_PROFILE_VERIFY_ORDER: TyltCredentialProfile[] = [
  "eur_payout",
  "india_payout",
];
