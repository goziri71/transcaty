/**
 * Outbound HTTP helper — shared timeouts, bounded retries, response-size
 * caps, and optional circuit-breaker accounting. Built on Node's global
 * fetch (which uses undici under the hood and already keeps an HTTP/1.1
 * keep-alive pool per host).
 *
 * Why this module exists:
 * 1. Without per-call AbortSignal.timeout, a hung provider can occupy a
 *    pg-pool slot for minutes via the surrounding transaction.
 * 2. Without retries with jitter, every transient blip propagates to the
 *    merchant as a 500 even though the request would succeed on a second
 *    attempt.
 * 3. Without a response size cap, a malicious or misbehaving upstream can
 *    exhaust memory by responding with multi-GB bodies.
 * 4. Without provider-circuit accounting, every route reinvents failure
 *    counting and skipping.
 *
 * Money-safety note: callers must NOT hold a database transaction open
 * across an outboundFetch. Always commit the local debit first, call this
 * helper, then post the success/refund in a second transaction.
 */
import type { Dispatcher } from "undici";

const DEFAULT_TIMEOUT_MS = parseEnvInt("OUTBOUND_HTTP_TIMEOUT_MS", 25_000, 1_000);
const DEFAULT_RETRIES = parseEnvInt("OUTBOUND_HTTP_RETRIES", 2, 0);
const DEFAULT_BACKOFF_MS = parseEnvInt("OUTBOUND_HTTP_BACKOFF_MS", 200, 0);
const DEFAULT_BACKOFF_CAP_MS = parseEnvInt("OUTBOUND_HTTP_BACKOFF_CAP_MS", 2_500, 100);
const DEFAULT_MAX_RESPONSE_BYTES = parseEnvInt(
  "OUTBOUND_HTTP_MAX_RESPONSE_BYTES",
  256 * 1024,
  1024
);

function parseEnvInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.floor(n);
}

/** Per-provider hooks for circuit breaker accounting. Keep them async so a
 * future Redis-backed implementation can be plugged in without changing
 * call sites. */
export interface ProviderCircuit {
  assertClosed(): Promise<void>;
  recordSuccess(): Promise<void>;
  recordFailure(): Promise<void>;
}

export interface OutboundFetchOptions {
  /** Per-call deadline. Defaults to OUTBOUND_HTTP_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Number of retry attempts AFTER the initial try. Defaults to 2. */
  retries?: number;
  /** HTTP status codes to retry. Defaults to [502, 503, 504, 429]. */
  retryOnStatus?: number[];
  /** When provided, sets an `Idempotency-Key` header (does not overwrite
   * an explicit header in init). */
  idempotencyKey?: string;
  /** Optional circuit breaker hooks — assertClosed throws when open,
   * recordSuccess/recordFailure update counters. */
  circuit?: ProviderCircuit;
  /** Cap on bytes consumed from the response body. Defaults to
   * OUTBOUND_HTTP_MAX_RESPONSE_BYTES. Bodies larger than this are
   * rejected with an Error. */
  maxResponseBytes?: number;
  /** Provider-friendly label included in error messages and metrics. */
  label?: string;
  /**
   * Optional undici dispatcher (e.g. ProxyAgent). Applied only to this call —
   * never set as a process-wide proxy. PayOK/Tylt/webhooks omit this.
   */
  dispatcher?: Dispatcher;
}

export interface OutboundFetchResult {
  status: number;
  text: string;
  headers: Headers;
  attempts: number;
}

const RETRYABLE_STATUS_DEFAULT = [502, 503, 504, 429];
const RETRYABLE_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function isRetryableError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (typeof err !== "object" || err == null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && RETRYABLE_ERROR_CODES.has(code)) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && cause !== err) return isRetryableError(cause);
  return false;
}

function backoffMs(attempt: number): number {
  // attempt is 1-based for the *next* attempt about to run
  const expo = DEFAULT_BACKOFF_MS * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(expo, DEFAULT_BACKOFF_CAP_MS);
  // Decorrelated jitter: random in [base, capped+base].
  const jitter = Math.floor(Math.random() * Math.max(1, capped));
  return Math.min(DEFAULT_BACKOFF_CAP_MS, DEFAULT_BACKOFF_MS + jitter);
}

function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(DEFAULT_BACKOFF_CAP_MS, Math.floor(seconds * 1000));
  }
  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta > 0) return Math.min(DEFAULT_BACKOFF_CAP_MS, delta);
  }
  return null;
}

async function readBodyWithCap(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new Error(
          `Outbound response exceeded ${maxBytes} bytes (got at least ${total})`
        );
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Issue an HTTP request with bounded retries, per-call timeout, response
 * size cap, and optional circuit-breaker accounting.
 *
 * Retry policy:
 * - Network errors with codes in {@link RETRYABLE_ERROR_CODES} → retry.
 * - HTTP statuses in {@link OutboundFetchOptions.retryOnStatus} → retry.
 * - All other 4xx → no retry, returned to caller.
 *
 * The body is read once per attempt (we cannot reuse `Response`), so
 * retries always issue a fresh request from `init`.
 */
export async function outboundFetch(
  url: string | URL,
  init: RequestInit = {},
  options: OutboundFetchOptions = {}
): Promise<OutboundFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const retryOnStatus = options.retryOnStatus ?? RETRYABLE_STATUS_DEFAULT;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const label = options.label ?? "outbound";

  if (options.circuit) {
    await options.circuit.assertClosed();
  }

  // Build headers once; AbortSignal must be fresh per attempt because
  // AbortSignal.timeout is single-use after firing.
  const baseHeaders = new Headers(init.headers ?? undefined);
  if (
    options.idempotencyKey &&
    !baseHeaders.has("Idempotency-Key") &&
    !baseHeaders.has("idempotency-key")
  ) {
    baseHeaders.set("Idempotency-Key", options.idempotencyKey);
  }

  const totalAttempts = retries + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      const fetchInit: RequestInit = {
        ...init,
        headers: baseHeaders,
        signal,
      };
      if (options.dispatcher) {
        fetchInit.dispatcher = options.dispatcher;
      }
      res = await fetch(url, fetchInit);
    } catch (err) {
      lastError = err;
      if (options.circuit) {
        try {
          await options.circuit.recordFailure();
        } catch {
          /* circuit hook errors must not mask the underlying failure */
        }
      }
      if (attempt < totalAttempts && isRetryableError(err)) {
        await sleep(backoffMs(attempt));
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const cause =
        err instanceof Error && err.cause
          ? err.cause instanceof Error
            ? err.cause.message
            : String(err.cause)
          : "";
      const detail = cause ? `${msg}. ${cause}` : msg;
      throw new Error(`${label} request failed after ${attempt} attempt(s): ${detail}`);
    }

    let text: string;
    try {
      text = await readBodyWithCap(res, maxResponseBytes);
    } catch (err) {
      // Body read failures are treated as retryable (network/cap issues).
      lastError = err;
      if (options.circuit) {
        try {
          await options.circuit.recordFailure();
        } catch {
          /* swallow */
        }
      }
      if (attempt < totalAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw err;
    }

    const retryable = retryOnStatus.includes(res.status);
    if (res.status >= 500 || retryable) {
      if (options.circuit) {
        try {
          await options.circuit.recordFailure();
        } catch {
          /* swallow */
        }
      }
      if (attempt < totalAttempts && retryable) {
        const ra = parseRetryAfter(res.headers.get("retry-after"));
        await sleep(ra ?? backoffMs(attempt));
        continue;
      }
    } else if (options.circuit) {
      try {
        await options.circuit.recordSuccess();
      } catch {
        /* swallow */
      }
    }

    return { status: res.status, text, headers: res.headers, attempts: attempt };
  }

  // Loop fell through without returning; surface the last error.
  if (lastError instanceof Error) throw lastError;
  throw new Error(`${label} request exhausted retries`);
}

/** Convenience: parse an outbound response as JSON, falling back to a raw
 * envelope so logs always have something structured. */
export function parseJsonResult<T = unknown>(result: OutboundFetchResult): T {
  if (!result.text) return {} as T;
  try {
    return JSON.parse(result.text) as T;
  } catch {
    return { raw: result.text } as T;
  }
}

/** Currently a no-op; retained as a hook for future custom-dispatcher
 * teardown so server.ts shutdown can call it unconditionally. */
export async function closeOutboundHttp(): Promise<void> {
  // Node's global fetch dispatcher is process-wide; explicit close would
  // affect any other consumer. Leave this as a placeholder.
}
