/**
 * Payok credentials – loaded from env (plain or encrypted).
 */
import { getSecret } from "../../../../src/lib/encryption.js";

export type PayokEnvironment = "test" | "live";

/** Which PayOK merchant account to use (separate MIDs per country). */
export type PayokMarket = "bangladesh" | "brazil";

export type PayokConfig = {
  merchantId: string;
  privateKey: string;
  baseUrl: string;
  platformPublicKey: string;
};

function safeGetSecret(plainKey: string, encKey: string): string | undefined {
  try {
    return getSecret(plainKey, encKey);
  } catch {
    return undefined;
  }
}

function envPrefix(environment: PayokEnvironment, market: PayokMarket = "bangladesh"): string {
  if (market === "brazil") {
    return environment === "test" ? "PAYOK_BR_TEST_" : "PAYOK_BR_LIVE_";
  }
  return environment === "test" ? "PAYOK_TEST_" : "PAYOK_LIVE_";
}

function legacyEnvPrefix(environment: PayokEnvironment): string {
  return envPrefix(environment, "bangladesh");
}

export function getDefaultPayokEnvironment(): PayokEnvironment {
  const raw = (process.env.PAYOK_DEFAULT_ENV ?? "").trim().toLowerCase();
  if (raw === "test" || raw === "live") return raw;
  // Backward compatible default.
  return "live";
}

/**
 * Private key: supports environment-specific keys first, then legacy keys.
 * Also accepts *_PRIVATE_KEY_ENC alias.
 */
function getPrivateKey(environment: PayokEnvironment, market: PayokMarket = "bangladesh"): string {
  const prefix = envPrefix(environment, market);
  const key =
    getSecret(`${prefix}MERCHANT_PRI_KEY`, `${prefix}MERCHANT_PRI_KEY_ENC`) ??
    getSecret(`${prefix}MERCHANT_PRI_KEY`, `${prefix}MERCHANT_PRIVATE_KEY_ENC`) ??
    (environment === "live"
      ? getSecret("PAYOK_MERCHANT_PRI_KEY", "PAYOK_MERCHANT_PRI_KEY_ENC") ??
        getSecret("PAYOK_MERCHANT_PRI_KEY", "PAYOK_MERCHANT_PRIVATE_KEY_ENC")
      : undefined) ??
    "";
  return key.trim();
}

/** If value is "merchantId\n-----BEGIN...", return { merchantId, pem }. */
function parseMerchantIdFromKey(value: string): { merchantId: string | null; pem: string } {
  const trimmed = value.trim();
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline > 0 && trimmed.includes("-----BEGIN")) {
    const firstLine = trimmed.slice(0, firstNewline).trim();
    const pem = trimmed.slice(firstNewline).trim();
    if (pem.startsWith("-----BEGIN") && firstLine && !firstLine.startsWith("-----")) {
      return { merchantId: firstLine, pem };
    }
  }
  return { merchantId: null, pem: trimmed };
}

/**
 * Load Payok config. Throws if any required value is missing.
 * Merchant ID: from PAYOK_MERCHANT_ID, or first line of decrypted private key.
 */
export function getPayokConfigForEnvironment(
  environment: PayokEnvironment,
  market: PayokMarket = "bangladesh"
): PayokConfig {
  const prefix = envPrefix(environment, market);
  const privateKeyRaw = getPrivateKey(environment, market);
  if (!privateKeyRaw) {
    const hasEnc =
      process.env[`${prefix}MERCHANT_PRI_KEY_ENC`] ||
      process.env[`${prefix}MERCHANT_PRIVATE_KEY_ENC`] ||
      (market === "bangladesh" &&
        environment === "live" &&
        (process.env.PAYOK_MERCHANT_PRI_KEY_ENC || process.env.PAYOK_MERCHANT_PRIVATE_KEY_ENC));
    const hint = hasEnc && !process.env.ENCRYPTION_MASTER_KEY
      ? "ENCRYPTION_MASTER_KEY required to decrypt."
      : `Set ${prefix}MERCHANT_PRI_KEY or ${prefix}MERCHANT_PRI_KEY_ENC in .env`;
    const marketLabel = market === "brazil" ? "Brazil" : "Bangladesh";
    throw new Error(`Payok private key required for ${environment} (${marketLabel}). ${hint}`);
  }

  const { merchantId: fromKey, pem } = parseMerchantIdFromKey(privateKeyRaw);
  const legacyPrefix = market === "bangladesh" ? legacyEnvPrefix(environment) : null;
  const merchantId =
    getSecret(`${prefix}MERCHANT_ID`, `${prefix}MERCHANT_ID_ENC`)?.trim() ??
    (legacyPrefix
      ? getSecret(`${legacyPrefix}MERCHANT_ID`, `${legacyPrefix}MERCHANT_ID_ENC`)?.trim()
      : undefined) ??
    (market === "bangladesh" && environment === "live"
      ? getSecret("PAYOK_MERCHANT_ID", "PAYOK_MERCHANT_ID_ENC")?.trim()
      : undefined) ??
    fromKey;

  if (!merchantId) {
    throw new Error(
      `Payok merchant ID required for ${environment} (${market}). Set ${prefix}MERCHANT_ID or use first line of private key as merchantId.`
    );
  }

  const baseUrl =
    getSecret(`${prefix}BASE_URL`, `${prefix}BASE_URL_ENC`)?.trim() ??
    (legacyPrefix
      ? getSecret(`${legacyPrefix}BASE_URL`, `${legacyPrefix}BASE_URL_ENC`)?.trim()
      : undefined) ??
    (market === "bangladesh" && environment === "live"
      ? getSecret("PAYOK_BASE_URL", "PAYOK_BASE_URL_ENC")?.trim()
      : undefined) ??
    "";
  if (!baseUrl.startsWith("http")) {
    throw new Error(
      `${prefix}BASE_URL must be a URL (e.g. https://api.payok.xxx). ` +
        `If using encrypted value, set ${prefix}BASE_URL_ENC.`
    );
  }

  const platformPublicKey =
    getSecret(`${prefix}PLATFORM_PUB_KEY`, `${prefix}PLATFORM_PUB_KEY_ENC`)?.trim() ??
    (legacyPrefix
      ? getSecret(`${legacyPrefix}PLATFORM_PUB_KEY`, `${legacyPrefix}PLATFORM_PUB_KEY_ENC`)?.trim()
      : undefined) ??
    (market === "bangladesh" && environment === "live"
      ? getSecret("PAYOK_PLATFORM_PUB_KEY", "PAYOK_PLATFORM_PUB_KEY_ENC")?.trim()
      : undefined) ??
    "";
  if (!platformPublicKey) {
    throw new Error(
      `Payok platform public key required for ${environment} (${market}). Set ${prefix}PLATFORM_PUB_KEY or ${prefix}PLATFORM_PUB_KEY_ENC.`
    );
  }

  return {
    merchantId,
    privateKey: pem,
    baseUrl,
    platformPublicKey,
  };
}

/** Backward-compatible default config loader (uses PAYOK_DEFAULT_ENV or live). */
export function getPayokConfig(): PayokConfig {
  return getPayokConfigForEnvironment(getDefaultPayokEnvironment());
}

/** Return available callback public keys (test/live/default), de-duplicated. */
export function getPayokCallbackPublicKeys(): string[] {
  const keys: string[] = [];
  const push = (value?: string) => {
    const v = value?.trim();
    if (v && !keys.includes(v)) keys.push(v);
  };

  push(safeGetSecret("PAYOK_TEST_PLATFORM_PUB_KEY", "PAYOK_TEST_PLATFORM_PUB_KEY_ENC"));
  push(safeGetSecret("PAYOK_LIVE_PLATFORM_PUB_KEY", "PAYOK_LIVE_PLATFORM_PUB_KEY_ENC"));
  push(safeGetSecret("PAYOK_BR_TEST_PLATFORM_PUB_KEY", "PAYOK_BR_TEST_PLATFORM_PUB_KEY_ENC"));
  push(safeGetSecret("PAYOK_BR_LIVE_PLATFORM_PUB_KEY", "PAYOK_BR_LIVE_PLATFORM_PUB_KEY_ENC"));
  push(safeGetSecret("PAYOK_PLATFORM_PUB_KEY", "PAYOK_PLATFORM_PUB_KEY_ENC"));

  if (!keys.length) {
    throw new Error(
      "No Payok callback public keys configured. Set PAYOK_TEST_PLATFORM_PUB_KEY(_ENC), PAYOK_LIVE_PLATFORM_PUB_KEY(_ENC), or PAYOK_PLATFORM_PUB_KEY(_ENC)."
    );
  }
  return keys;
}
