/**
 * Tylt outbound HTTP helper — shared circuit breaker for CPG + CrossRamp (same API host).
 * Use this for all signed requests to api.tylt.money so failures open only the Tylt rail.
 */
import {
  assertTyltCircuitClosed,
  recordTyltCircuitFailure,
  recordTyltCircuitSuccess,
} from "../../../src/lib/provider-circuit-breaker.js";

/**
 * fetch() with Tylt circuit accounting:
 * - Network errors → failure
 * - HTTP >= 500 → failure
 * - Otherwise → success (including 4xx)
 */
export async function tyltFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  assertTyltCircuitClosed();
  try {
    const res = await fetch(input, init);
    if (res.status >= 500) {
      recordTyltCircuitFailure();
    } else {
      recordTyltCircuitSuccess();
    }
    return res;
  } catch (err) {
    recordTyltCircuitFailure();
    throw err;
  }
}
