/**
 * Tekko Platform API credentials (live only — no sandbox).
 *
 * Env (prefer LIVE_ prefix; plain TEKKO_* accepted as alias):
 * - TEKKO_LIVE_KEY_ID / TEKKO_KEY_ID
 * - TEKKO_LIVE_PRIVATE_KEY (PEM) or TEKKO_LIVE_PRIVATE_KEY_ENC
 * - or TEKKO_LIVE_PRIVATE_KEY_PATH (file path)
 * - TEKKO_WEBHOOK_SECRET / TEKKO_WEBHOOK_SECRET_ENC (whsec_…)
 * - TEKKO_BASE_URL (default https://api.tekkoglobal.com/api/v1/platform)
 */
import { readFileSync } from "node:fs";
import { getSecret } from "../../../src/lib/encryption.js";

export const TEKKO_PLATFORM_PATH_PREFIX = "/api/v1/platform";
export const TEKKO_DEFAULT_BASE_URL = "https://api.tekkoglobal.com/api/v1/platform";

export type TekkoConfig = {
  keyId: string;
  privateKeyPem: string;
  baseUrl: string;
  webhookSecret: string | null;
};

function coalesce(...vals: (string | undefined | null)[]): string | undefined {
  for (const v of vals) {
    const t = v?.trim();
    if (t) return t;
  }
  return undefined;
}

function loadPrivateKeyPem(): string | undefined {
  const inline = coalesce(
    getSecret("TEKKO_LIVE_PRIVATE_KEY", "TEKKO_LIVE_PRIVATE_KEY_ENC"),
    getSecret("TEKKO_PRIVATE_KEY", "TEKKO_PRIVATE_KEY_ENC")
  );
  if (inline) {
    // Support env values that escaped newlines as \n
    return inline.includes("\\n") ? inline.replace(/\\n/g, "\n") : inline;
  }
  const path = coalesce(
    process.env.TEKKO_LIVE_PRIVATE_KEY_PATH,
    process.env.TEKKO_PRIVATE_KEY_PATH
  );
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Live credentials only. Returns null when not configured. */
export function getTekkoLiveConfig(): TekkoConfig | null {
  const keyId = coalesce(
    process.env.TEKKO_LIVE_KEY_ID,
    process.env.TEKKO_KEY_ID,
    getSecret("TEKKO_LIVE_KEY_ID", "TEKKO_LIVE_KEY_ID_ENC"),
    getSecret("TEKKO_KEY_ID", "TEKKO_KEY_ID_ENC")
  );
  const privateKeyPem = loadPrivateKeyPem();
  if (!keyId || !privateKeyPem) return null;

  const baseUrl = (
    coalesce(
      process.env.TEKKO_LIVE_BASE_URL,
      process.env.TEKKO_BASE_URL,
      getSecret("TEKKO_LIVE_BASE_URL", "TEKKO_LIVE_BASE_URL_ENC"),
      getSecret("TEKKO_BASE_URL", "TEKKO_BASE_URL_ENC")
    ) ?? TEKKO_DEFAULT_BASE_URL
  ).replace(/\/$/, "");

  const webhookSecret =
    coalesce(
      getSecret("TEKKO_WEBHOOK_SECRET", "TEKKO_WEBHOOK_SECRET_ENC"),
      getSecret("TEKKO_LIVE_WEBHOOK_SECRET", "TEKKO_LIVE_WEBHOOK_SECRET_ENC")
    ) ?? null;

  return { keyId, privateKeyPem, baseUrl, webhookSecret };
}

/**
 * Absolute path used for Ed25519 signing (must match the HTTP request path).
 * Example: `/api/v1/platform/customers`
 */
export function tekkoSignPath(relativePath: string): string {
  const rel = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
  if (rel.startsWith(TEKKO_PLATFORM_PATH_PREFIX)) return rel;
  return `${TEKKO_PLATFORM_PATH_PREFIX}${rel}`;
}
