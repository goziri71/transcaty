/**
 * Provider circuit breaker for outbound payment processor HTTP calls.
 *
 * Design:
 * - Source of truth for "open until <ts>" lives in Redis when configured,
 *   so a circuit opened on one app instance is honored by all peers.
 * - An in-process cache mirrors Redis so the hot path can short-circuit
 *   without awaiting a network round-trip on every request, and so the
 *   legacy synchronous API keeps working when Redis is unreachable.
 * - The async API ({@link assertProviderCircuitClosed},
 *   {@link recordProviderCircuitSuccess}, {@link recordProviderCircuitFailure})
 *   is the canonical one going forward; it consults Redis as needed and
 *   degrades gracefully when Redis is offline.
 * - The legacy synchronous names ({@link assertCircuitClosed},
 *   {@link recordProviderSuccess}, {@link recordProviderFailure}) are
 *   preserved for callers that cannot easily await; they read the local
 *   cache only.
 *
 * Keys are independent (e.g. `payok` vs `tylt`) so one rail opening does
 * not block another.
 *
 * Env:
 * - PROVIDER_CIRCUIT_ENABLED — default "true"; set "false" to disable.
 * - PROVIDER_CIRCUIT_FAILURE_THRESHOLD — consecutive failures before opening (default 5).
 * - PROVIDER_CIRCUIT_COOLDOWN_MS — how long the circuit stays open (default 60000).
 * - PROVIDER_CIRCUIT_REDIS — default "true"; set "false" to skip Redis even if configured.
 * Optional overrides per rail (fallback to globals above):
 * - PROVIDER_CIRCUIT_PAYOK_FAILURE_THRESHOLD, PROVIDER_CIRCUIT_PAYOK_COOLDOWN_MS
 * - PROVIDER_CIRCUIT_TYLT_FAILURE_THRESHOLD, PROVIDER_CIRCUIT_TYLT_COOLDOWN_MS
 */

import type { Redis } from "ioredis";
import { getRedis } from "./redis.js";
import type { ProviderCircuit } from "./outbound-http.js";

export const PAYOK_CIRCUIT_KEY = "payok";
/** Brazil PayOK uses the same vendor but a separate breaker, so a Brazil-specific
 * outage cannot trip Bangladesh's circuit (and vice versa). */
export const PAYOK_BR_CIRCUIT_KEY = "payok-br";
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

function redisBackingEnabled(): boolean {
  const v = process.env.PROVIDER_CIRCUIT_REDIS?.trim().toLowerCase();
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
  /** Epoch ms when the circuit reopens. 0 means closed. */
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

function redisKeys(providerKey: string): { open: string; fails: string } {
  return {
    open: `cb:${providerKey}:openUntil`,
    fails: `cb:${providerKey}:fails`,
  };
}

function getRedisIfBacking(): Redis | null {
  if (!redisBackingEnabled()) return null;
  return getRedis();
}

// -- Async (canonical) API ---------------------------------------------------

export async function assertProviderCircuitClosed(providerKey: string): Promise<void> {
  if (!circuitEnabled()) return;
  const local = getState(providerKey);
  const now = Date.now();
  if (now < local.openUntil) {
    throw new ProviderCircuitOpenError(providerKey);
  }
  const r = getRedisIfBacking();
  if (!r) return;
  try {
    const raw = await r.get(redisKeys(providerKey).open);
    if (!raw) return;
    const ts = Number(raw);
    if (Number.isFinite(ts) && now < ts) {
      // Mirror the remote open window locally so subsequent sync checks
      // (and the next ~ttl ms of async checks) short-circuit without I/O.
      local.openUntil = ts;
      throw new ProviderCircuitOpenError(providerKey);
    }
  } catch (err) {
    if (err instanceof ProviderCircuitOpenError) throw err;
    /* Redis hiccup – fall back to local state. */
  }
}

export async function recordProviderCircuitSuccess(providerKey: string): Promise<void> {
  if (!circuitEnabled()) return;
  const local = getState(providerKey);
  local.consecutiveFailures = 0;
  const r = getRedisIfBacking();
  if (!r) return;
  try {
    await r.del(redisKeys(providerKey).fails);
  } catch {
    /* ignore */
  }
}

export async function recordProviderCircuitFailure(providerKey: string): Promise<void> {
  if (!circuitEnabled()) return;
  const threshold = failureThresholdFor(providerKey);
  const cooldown = cooldownMsFor(providerKey);
  const local = getState(providerKey);
  local.consecutiveFailures += 1;

  const r = getRedisIfBacking();
  let total = local.consecutiveFailures;
  if (r) {
    try {
      const incremented = await r.incr(redisKeys(providerKey).fails);
      // Keep the failure counter from leaking forever if the circuit
      // never opens (e.g. threshold not reached for a long time).
      try {
        await r.pexpire(redisKeys(providerKey).fails, Math.max(cooldown * 2, 30_000));
      } catch {
        /* ignore */
      }
      if (Number.isFinite(incremented) && incremented > 0) total = Number(incremented);
    } catch {
      /* fall through using local count */
    }
  }

  if (total >= threshold) {
    const openUntil = Date.now() + cooldown;
    local.openUntil = openUntil;
    local.consecutiveFailures = 0;
    if (r) {
      try {
        await r.set(redisKeys(providerKey).open, String(openUntil), "PX", cooldown);
        await r.del(redisKeys(providerKey).fails);
      } catch {
        /* circuit will still trip locally */
      }
    }
  }
}

/** Returns a {@link ProviderCircuit} suitable for outbound-http.ts. */
export function getProviderCircuit(providerKey: string): ProviderCircuit {
  return {
    assertClosed: () => assertProviderCircuitClosed(providerKey),
    recordSuccess: () => recordProviderCircuitSuccess(providerKey),
    recordFailure: () => recordProviderCircuitFailure(providerKey),
  };
}

// -- Legacy synchronous API (process-local fallback) -------------------------

/** @deprecated Prefer {@link assertProviderCircuitClosed}. Process-local only. */
export function assertCircuitClosed(providerKey: string): void {
  if (!circuitEnabled()) return;
  const s = getState(providerKey);
  if (Date.now() < s.openUntil) {
    throw new ProviderCircuitOpenError(providerKey);
  }
}

/** @deprecated Prefer {@link recordProviderCircuitSuccess}. Process-local only. */
export function recordProviderSuccess(providerKey: string): void {
  if (!circuitEnabled()) return;
  getState(providerKey).consecutiveFailures = 0;
}

/** @deprecated Prefer {@link recordProviderCircuitFailure}. Process-local only. */
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

/** Test-only helper to wipe all in-memory state. */
export function resetAllCircuitsForTests(): void {
  states.clear();
}
