/**
 * Tylt API credentials per merchant key environment (test | live).
 * Plain or *_ENC via getSecret (same pattern as Payok).
 */
import { getSecret } from "../../../src/lib/encryption.js";

export type TyltMerchantEnvironment = "test" | "live";

export type TyltConfig = {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
};

function pick(prefix: "TYLT_TEST_" | "TYLT_LIVE_"): {
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
} {
  return {
    apiKey: getSecret(`${prefix}API_KEY`, `${prefix}API_KEY_ENC`)?.trim(),
    apiSecret: getSecret(`${prefix}API_SECRET`, `${prefix}API_SECRET_ENC`)?.trim(),
    baseUrl: getSecret(`${prefix}BASE_URL`, `${prefix}BASE_URL_ENC`)?.trim(),
  };
}

/**
 * Resolved config for outbound calls and webhook verification.
 * Per-env vars override shared TYLT_* when set.
 */
export function getTyltConfig(environment: TyltMerchantEnvironment): TyltConfig | null {
  const specific = environment === "live" ? pick("TYLT_LIVE_") : pick("TYLT_TEST_");
  const shared = {
    apiKey: getSecret("TYLT_API_KEY", "TYLT_API_KEY_ENC")?.trim(),
    apiSecret: getSecret("TYLT_API_SECRET", "TYLT_API_SECRET_ENC")?.trim(),
    baseUrl: getSecret("TYLT_BASE_URL", "TYLT_BASE_URL_ENC")?.trim() ?? "https://api.tylt.money",
  };

  const apiKey = specific.apiKey ?? shared.apiKey;
  const apiSecret = specific.apiSecret ?? shared.apiSecret;
  const baseUrl = specific.baseUrl ?? shared.baseUrl;

  if (!apiKey || !apiSecret || !baseUrl) return null;

  return {
    apiKey,
    apiSecret,
    baseUrl: baseUrl.replace(/\/$/, ""),
  };
}

export function assertTyltConfigured(environment: TyltMerchantEnvironment): TyltConfig {
  const c = getTyltConfig(environment);
  if (!c) {
    throw new Error("Tylt is not configured");
  }
  return c;
}
