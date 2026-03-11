/**
 * Payok credentials – loaded from env (plain or encrypted).
 */
import { getSecret } from "./encryption.js";

export type PayokConfig = {
  merchantId: string;
  privateKey: string;
  baseUrl: string;
  platformPublicKey: string;
};

function getRequired(key: string, encKey: string): string {
  const value = getSecret(key, encKey);
  if (!value || !value.trim()) {
    const hasEnc = !!process.env[encKey];
    const hasMaster = !!process.env.ENCRYPTION_MASTER_KEY;
    let hint = "Add to .env or use npm run encrypt for encrypted values.";
    if (hasEnc && !hasMaster) {
      hint = "ENCRYPTION_MASTER_KEY is required to decrypt " + encKey + ".";
    } else if (hasEnc && hasMaster) {
      hint = "Decryption failed – check ENCRYPTION_MASTER_KEY matches the key used to encrypt.";
    }
    throw new Error(`Payok ${key} or ${encKey} must be set. ${hint}`);
  }
  return value.trim();
}

/** Private key: also accept PAYOK_MERCHANT_PRIVATE_KEY_ENC (alias). */
function getPrivateKey(): string {
  return (
    getSecret("PAYOK_MERCHANT_PRI_KEY", "PAYOK_MERCHANT_PRI_KEY_ENC") ??
    getSecret("PAYOK_MERCHANT_PRI_KEY", "PAYOK_MERCHANT_PRIVATE_KEY_ENC") ??
    ""
  ).trim();
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
export function getPayokConfig(): PayokConfig {
  const privateKeyRaw = getPrivateKey();
  if (!privateKeyRaw) {
    const hasEnc =
      process.env.PAYOK_MERCHANT_PRI_KEY_ENC || process.env.PAYOK_MERCHANT_PRIVATE_KEY_ENC;
    const hint = hasEnc && !process.env.ENCRYPTION_MASTER_KEY
      ? "ENCRYPTION_MASTER_KEY required to decrypt."
      : "Set PAYOK_MERCHANT_PRI_KEY or PAYOK_MERCHANT_PRI_KEY_ENC in .env";
    throw new Error(`Payok private key required. ${hint}`);
  }

  const { merchantId: fromKey, pem } = parseMerchantIdFromKey(privateKeyRaw);
  const merchantId =
    getSecret("PAYOK_MERCHANT_ID", "PAYOK_MERCHANT_ID_ENC")?.trim() ?? fromKey;

  if (!merchantId) {
    throw new Error(
      "Payok merchant ID required. Set PAYOK_MERCHANT_ID or use first line of private key as merchantId."
    );
  }

  let baseUrl = getRequired("PAYOK_BASE_URL", "PAYOK_BASE_URL_ENC");
  if (!baseUrl.startsWith("http")) {
    throw new Error(
      "PAYOK_BASE_URL must be a URL (e.g. https://api.payok.xxx). " +
        "You may have put the encrypted value in PAYOK_BASE_URL – use PAYOK_BASE_URL_ENC for encrypted, or put the actual URL in PAYOK_BASE_URL."
    );
  }

  return {
    merchantId,
    privateKey: pem,
    baseUrl,
    platformPublicKey: getRequired("PAYOK_PLATFORM_PUB_KEY", "PAYOK_PLATFORM_PUB_KEY_ENC"),
  };
}
