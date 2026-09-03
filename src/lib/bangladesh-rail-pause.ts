/**
 * Temporary kill switch for Bangladesh PayOK collect/payout while the
 * provider is down. Does not affect Brazil PayOK, Tylt, Tekko, wallets,
 * internal BDT transfers, or inbound PayOK webhooks.
 *
 * Default: paused. Set BANGLADESH_PAYMENTS_DISABLED=false to restore Bangladesh only.
 * Does not affect Brazil PayOK (PIX) — keep PAYOK_* credentials set for Brazil.
 */
export class BangladeshRailPausedError extends Error {
  constructor() {
    super("Bangladesh payments are temporarily unavailable");
    this.name = "BangladeshRailPausedError";
  }
}

export function isBangladeshPaymentsPaused(): boolean {
  const raw = process.env.BANGLADESH_PAYMENTS_DISABLED?.trim().toLowerCase();
  if (raw === "false" || raw === "0") return false;
  return true;
}

export function assertBangladeshPaymentsEnabled(): void {
  if (isBangladeshPaymentsPaused()) {
    throw new BangladeshRailPausedError();
  }
}
