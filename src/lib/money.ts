/**
 * Money helper. All amounts move through this module as decimal strings ("123.45")
 * with at most two decimal places. Arithmetic is performed on BigInt cents so it
 * never loses precision for values that fit in `decimal(18,2)`.
 *
 * Why: the wallets/ledger schema stores `decimal(18,2)`, but call sites historically
 * read those values via `Number(...)` and then re-stringified them, which exposes
 * the ledger to IEEE-754 rounding. Using BigInt cents removes that risk and makes
 * the math associative and exact.
 *
 * Inputs are accepted as plain decimal strings: optional leading "-", at least one
 * digit, optional "." with up to two fractional digits. NaN, Infinity, scientific
 * notation, more than two decimals, or empty strings throw.
 */

const AMOUNT_REGEX = /^-?\d+(?:\.\d{1,2})?$/;

/**
 * Coerce upstream/provider amounts to a ledger-safe `decimal(18,2)` string.
 * Rounds half away from zero at cent precision when more than two decimals are present.
 */
export function normalizeMoneyAmountToTwoDecimals(amount: string): string {
  const trimmed = amount.trim();
  if (!trimmed) {
    throw new Error("Invalid money amount: empty string");
  }
  if (AMOUNT_REGEX.test(trimmed)) {
    return fromCents(toCents(trimmed));
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid money amount: ${amount}`);
  }
  const cents = BigInt(Math.round(n * 100));
  return fromCents(cents);
}

export function toCents(amount: string): bigint {
  if (typeof amount !== "string") {
    throw new TypeError(`Invalid money amount: expected string, got ${typeof amount}`);
  }
  const trimmed = amount.trim();
  if (!trimmed) {
    throw new Error("Invalid money amount: empty string");
  }
  if (!AMOUNT_REGEX.test(trimmed)) {
    throw new Error(`Invalid money amount: ${amount}`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const dot = unsigned.indexOf(".");
  let whole: string;
  let fraction: string;
  if (dot === -1) {
    whole = unsigned;
    fraction = "00";
  } else {
    whole = unsigned.slice(0, dot);
    const frac = unsigned.slice(dot + 1);
    fraction = (frac + "00").slice(0, 2);
  }
  const cents = BigInt(whole) * 100n + BigInt(fraction);
  return negative ? -cents : cents;
}

export function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const fraction = abs % 100n;
  const fractionStr = fraction.toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fractionStr}`;
}

export function addAmount(a: string, b: string): string {
  return fromCents(toCents(a) + toCents(b));
}

export function subAmount(a: string, b: string): string {
  return fromCents(toCents(a) - toCents(b));
}

export function cmpAmount(a: string, b: string): -1 | 0 | 1 {
  const ac = toCents(a);
  const bc = toCents(b);
  if (ac < bc) return -1;
  if (ac > bc) return 1;
  return 0;
}

/** Throws if the amount is missing, malformed, zero, or negative. */
export function assertPositive(amount: string): void {
  const cents = toCents(amount);
  if (cents <= 0n) {
    throw new Error(`Amount must be positive: ${amount}`);
  }
}

/** Throws if the amount is malformed or strictly negative (zero is allowed). */
export function assertNonNegative(amount: string): void {
  const cents = toCents(amount);
  if (cents < 0n) {
    throw new Error(`Amount must be non-negative: ${amount}`);
  }
}

/** True if a >= b. Convenience wrapper around cmpAmount for balance checks. */
export function gteAmount(a: string, b: string): boolean {
  return cmpAmount(a, b) >= 0;
}
