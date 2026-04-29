/**
 * In-process circuit breaker for outbound payment processor HTTP calls.
 * When open, callers should fail fast with ProviderCircuitOpenError (mapped to a generic merchant response).
 *
 * Keys are independent (e.g. `payok` vs `tylt`) so one rail opening does not block another.
 *
 * Env:
 * - PROVIDER_CIRCUIT_ENABLED — default "true"; set "false" to disable (not recommended for prod).
 * - PROVIDER_CIRCUIT_FAILURE_THRESHOLD — consecutive failures before opening (default 5).
 * - PROVIDER_CIRCUIT_COOLDOWN_MS — how long the circuit stays open (default 60000).
 * Optional overrides per rail (fallback to globals above):
 * - PROVIDER_CIRCUIT_PAYOK_FAILURE_THRESHOLD, PROVIDER_CIRCUIT_PAYOK_COOLDOWN_MS
 * - PROVIDER_CIRCUIT_TYLT_FAILURE_THRESHOLD, PROVIDER_CIRCUIT_TYLT_COOLDOWN_MS
 */

export const PAYOK_CIRCUIT_KEY = "payok";
/** Tylt CPG + CrossRamp share one breaker (same vendor HTTP edge). */
export const TYLT_CIRCUIT_KEY = "tylt";

export class ProviderCircuitOpenError extends Error {
  readonly providerKey: string;

  constructor(providerKey: string) {
    super("Provider circuit open");
    this.name = "ProviderCircuitOpenError";
    this.providerKey = providerKey;
  }
}

function circuitEnabled(): boolean {
  const v = process.env.PROVIDER_CIRCUIT_ENABLED?.trim().toLowerCase();
  if (v === "false" || v === "0") return false;
  return true;
}

function failureThresholdFor(providerKey: string): number {
  const specific =
    providerKey === PAYOK_CIRCUIT_KEY
      ? process.env.PROVIDER_CIRCUIT_PAYOK_FAILURE_THRESHOLD
      : providerKey === TYLT_CIRCUIT_KEY
        ? process.env.PROVIDER_CIRCUIT_TYLT_FAILURE_THRESHOLD
        : undefined;
  const n = Number(specific ?? process.env.PROVIDER_CIRCUIT_FAILURE_THRESHOLD);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

function cooldownMsFor(providerKey: string): number {
  const specific =
    providerKey === PAYOK_CIRCUIT_KEY
      ? process.env.PROVIDER_CIRCUIT_PAYOK_COOLDOWN_MS
      : providerKey === TYLT_CIRCUIT_KEY
        ? process.env.PROVIDER_CIRCUIT_TYLT_COOLDOWN_MS
        : undefined;
  const n = Number(specific ?? process.env.PROVIDER_CIRCUIT_COOLDOWN_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60_000;
}

type State = {
  consecutiveFailures: number;
  openUntil: number;
};

const states = new Map<string, State>();

function getState(key: string): State {
  let s = states.get(key);
  if (!s) {
    s = { consecutiveFailures: 0, openUntil: 0 };
    states.set(key, s);
  }
  return s;
}

export function assertCircuitClosed(providerKey: string): void {
  if (!circuitEnabled()) return;
  const s = getState(providerKey);
  const now = Date.now();
  if (now < s.openUntil) {
    throw new ProviderCircuitOpenError(providerKey);
  }
}

/** Call after a successful outbound request (transport succeeded and status < 500). */
export function recordProviderSuccess(providerKey: string): void {
  if (!circuitEnabled()) return;
  const s = getState(providerKey);
  s.consecutiveFailures = 0;
}

/**
 * Call after transport failure or HTTP >= 500 from the processor.
 * Does not open on application-level 4xx from processor.
 */
export function recordProviderFailure(providerKey: string): void {
  if (!circuitEnabled()) return;
  const s = getState(providerKey);
  s.consecutiveFailures += 1;
  if (s.consecutiveFailures >= failureThresholdFor(providerKey)) {
    s.openUntil = Date.now() + cooldownMsFor(providerKey);
    s.consecutiveFailures = 0;
  }
}

export function assertTyltCircuitClosed(): void {
  assertCircuitClosed(TYLT_CIRCUIT_KEY);
}

export function recordTyltCircuitSuccess(): void {
  recordProviderSuccess(TYLT_CIRCUIT_KEY);
}

export function recordTyltCircuitFailure(): void {
  recordProviderFailure(TYLT_CIRCUIT_KEY);
}

export function resetPayokCircuitForTests(): void {
  states.delete(PAYOK_CIRCUIT_KEY);
}

export function resetTyltCircuitForTests(): void {
  states.delete(TYLT_CIRCUIT_KEY);
}
