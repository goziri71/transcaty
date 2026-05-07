/**
 * Tylt outbound HTTP helper — shared circuit breaker for CPG + CrossRamp
 * (same API host). Use this for all signed requests to api.tylt.money so
 * failures open only the Tylt rail.
 *
 * Wraps {@link outboundFetch} so all calls inherit per-call timeouts,
 * bounded retries with jitter, response size caps, and circuit-breaker
 * accounting. The legacy {@link tyltFetch} signature returns a `Response`
 * for backward compatibility with existing call sites that already parse
 * the body themselves.
 */
import {
  TYLT_CIRCUIT_KEY,
  getProviderCircuit,
} from "../../../src/lib/provider-circuit-breaker.js";
import { outboundFetch } from "../../../src/lib/outbound-http.js";

const TYLT_CIRCUIT = getProviderCircuit(TYLT_CIRCUIT_KEY);

interface TyltFetchOptions {
  /** Idempotency key forwarded as `Idempotency-Key` header for write
   * endpoints; safe to set on reads (the helper just forwards it). */
  idempotencyKey?: string;
  /** Endpoint identity for richer error messages. */
  label?: string;
  /** When true, retry on retryable transport errors and 5xx (default: true). */
  retry?: boolean;
}

/**
 * fetch() with Tylt circuit accounting and bounded retries.
 *
 * - Network errors → failure + retry if {@link TyltFetchOptions.retry}.
 * - HTTP >= 500 → failure + retry if {@link TyltFetchOptions.retry}.
 * - 4xx other than 429 → success (delivered to caller).
 *
 * Returns a synthesized `Response` so existing call sites that read
 * `res.text()` continue to work. The body has already been buffered and
 * size-capped by {@link outboundFetch}.
 */
export async function tyltFetch(
  input: string | URL,
  init: RequestInit = {},
  options: TyltFetchOptions = {}
): Promise<Response> {
  const result = await outboundFetch(input, init, {
    circuit: TYLT_CIRCUIT,
    label: options.label ?? "tylt",
    idempotencyKey: options.idempotencyKey,
    retries: options.retry === false ? 0 : 2,
  });
  // Synthesize a Response so existing call sites that call res.text() or
  // peek headers continue to work without refactoring.
  return new Response(result.text, {
    status: result.status,
    headers: result.headers,
  });
}
