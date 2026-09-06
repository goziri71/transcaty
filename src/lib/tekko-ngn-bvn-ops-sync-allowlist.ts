/**
 * One-off ops: sync Tekko BVN → Transacty for merchants approved out-of-band only.
 * All other merchants must use POST /portal/me/ngn/virtual-account (normal procedure).
 *
 * Set TEKKO_NGN_BVN_OPS_SYNC_MERCHANT_ALLOWLIST to a comma-separated list of merchant UUIDs.
 * When unset or empty, ops sync is disabled.
 */
export function parseNgnBvnOpsSyncAllowlist(): Set<string> | null {
  const raw = process.env.TEKKO_NGN_BVN_OPS_SYNC_MERCHANT_ALLOWLIST?.trim();
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[0-9a-f-]{36}$/.test(s));
  if (ids.length === 0) return null;
  return new Set(ids);
}

export function assertMerchantAllowedForNgnBvnOpsSync(
  merchantId: string
): { ok: true } | { ok: false; message: string } {
  const list = parseNgnBvnOpsSyncAllowlist();
  if (!list) {
    return {
      ok: false,
      message:
        "NGN BVN ops sync is disabled. Other merchants must complete BVN via the portal virtual-account flow.",
    };
  }
  if (!list.has(merchantId.trim().toLowerCase())) {
    return {
      ok: false,
      message:
        "This merchant is not on the NGN BVN ops-sync allowlist. Use the normal portal BVN procedure.",
    };
  }
  return { ok: true };
}
