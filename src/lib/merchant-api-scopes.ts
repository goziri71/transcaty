/**
 * Allowed merchant API key scopes (portal create + auth checks).
 * Stored as a comma-separated string on `merchant_api_keys.scopes`.
 */

export const MERCHANT_API_SCOPES = [
  "*",
  "payin:create",
  "payout:create",
  "balance:read",
  "wallets:create",
  "wallets:read",
  "transfer:create",
  "internal_transfer:create",
  /** Legacy alias still accepted by `/v1/internal-transfer`. */
  "tylt:internal_transfer",
] as const;

export type MerchantApiScope = (typeof MERCHANT_API_SCOPES)[number];

const ALLOWED = new Set<string>(MERCHANT_API_SCOPES);

/** Backward-compatible default when create body omits `scopes`. */
export const DEFAULT_MERCHANT_API_SCOPES =
  "payin:create,payout:create,balance:read,*";

export function isAllowedMerchantApiScope(scope: string): scope is MerchantApiScope {
  return ALLOWED.has(scope);
}

/**
 * Normalize a scopes array from the portal create request into the DB string.
 * Dedupes, rejects unknown scopes, requires at least one.
 */
export function normalizeMerchantApiScopes(
  scopes: string[] | undefined
): { ok: true; value: string } | { ok: false; message: string } {
  if (scopes == null) {
    return { ok: true, value: DEFAULT_MERCHANT_API_SCOPES };
  }
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return { ok: false, message: "At least one scope is required" };
  }

  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of scopes) {
    const s = typeof raw === "string" ? raw.trim() : "";
    if (!s) continue;
    if (!isAllowedMerchantApiScope(s)) {
      return { ok: false, message: `Unknown scope: ${s}` };
    }
    if (seen.has(s)) continue;
    seen.add(s);
    cleaned.push(s);
  }

  if (cleaned.length === 0) {
    return { ok: false, message: "At least one scope is required" };
  }

  // `*` alone is enough; keep others if the client sent a mix (auth treats `*` as all).
  return { ok: true, value: cleaned.join(",") };
}
