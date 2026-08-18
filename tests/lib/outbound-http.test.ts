/**
 * Unit tests for src/lib/outbound-http.ts. We monkey-patch globalThis.fetch
 * with a stub so we can drive timeouts, transient errors, retry status
 * codes, and oversized responses deterministically.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

// Force small backoff windows before importing the module so retries are fast.
process.env.OUTBOUND_HTTP_BACKOFF_MS = "1";
process.env.OUTBOUND_HTTP_BACKOFF_CAP_MS = "5";
process.env.OUTBOUND_HTTP_TIMEOUT_MS = "200";
process.env.OUTBOUND_HTTP_MAX_RESPONSE_BYTES = "64";

const { outboundFetch } = await import("../../src/lib/outbound-http.js");

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit }>;

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(handler: (call: number, url: string, init: RequestInit) => Promise<Response> | Response) {
  let count = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    count++;
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(count, url, init);
  }) as typeof fetch;
}

describe("outboundFetch", () => {
  test("returns successfully on first attempt", async () => {
    mockFetch(() => new Response('{"ok":true}', { status: 200 }));
    const r = await outboundFetch("https://example.test/x", { method: "GET" });
    assert.equal(r.status, 200);
    assert.equal(r.text, '{"ok":true}');
    assert.equal(r.attempts, 1);
    assert.equal(calls.length, 1);
  });

  test("retries on retryable HTTP status and returns final response", async () => {
    mockFetch((n) => {
      if (n === 1) return new Response("oops", { status: 503 });
      return new Response("ok", { status: 200 });
    });
    const r = await outboundFetch("https://example.test/x", { method: "GET" }, { retries: 2 });
    assert.equal(r.status, 200);
    assert.equal(r.attempts, 2);
    assert.equal(calls.length, 2);
  });

  test("does NOT retry on non-retryable 4xx", async () => {
    mockFetch(() => new Response("nope", { status: 400 }));
    const r = await outboundFetch("https://example.test/x", { method: "GET" }, { retries: 3 });
    assert.equal(r.status, 400);
    assert.equal(r.attempts, 1);
    assert.equal(calls.length, 1);
  });

  test("retries on transient transport errors", async () => {
    mockFetch((n) => {
      if (n === 1) {
        const e = new Error("connect ECONNRESET");
        (e as { code?: string }).code = "ECONNRESET";
        throw e;
      }
      return new Response("ok", { status: 200 });
    });
    const r = await outboundFetch("https://example.test/x", { method: "GET" }, { retries: 2 });
    assert.equal(r.status, 200);
    assert.equal(r.attempts, 2);
  });

  test("surfaces error after retries are exhausted", async () => {
    mockFetch(() => {
      const e = new Error("connect ECONNRESET");
      (e as { code?: string }).code = "ECONNRESET";
      throw e;
    });
    await assert.rejects(
      () => outboundFetch("https://example.test/x", { method: "GET" }, { retries: 1 }),
      /attempt/
    );
    assert.equal(calls.length, 2);
  });

  test("rejects oversized response bodies", async () => {
    const huge = "x".repeat(8192);
    mockFetch(() => new Response(huge, { status: 200 }));
    await assert.rejects(
      () =>
        outboundFetch(
          "https://example.test/x",
          { method: "GET" },
          { retries: 0, maxResponseBytes: 1024 }
        ),
      /exceeded/
    );
  });

  test("AbortSignal.timeout fires when fetch hangs", async () => {
    // Use a regular ref'd setTimeout to keep the test event loop alive
    // long enough for AbortSignal.timeout (which is unref'd in Node) to
    // observably fire.
    mockFetch(async (_n, _url, init) => {
      const signal = init.signal;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1000);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      });
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      return new Response("late", { status: 200 });
    });
    await assert.rejects(
      () =>
        outboundFetch(
          "https://example.test/x",
          { method: "GET" },
          { retries: 0, timeoutMs: 30 }
        ),
      /attempt/i
    );
  });

  test("adds Idempotency-Key header when supplied", async () => {
    mockFetch(() => new Response("ok", { status: 200 }));
    await outboundFetch(
      "https://example.test/x",
      { method: "POST", body: "{}" },
      { idempotencyKey: "order-42" }
    );
    assert.equal(calls.length, 1);
    const headers = new Headers(calls[0]!.init.headers ?? undefined);
    assert.equal(headers.get("Idempotency-Key"), "order-42");
  });

  test("does not overwrite a caller-supplied Idempotency-Key", async () => {
    mockFetch(() => new Response("ok", { status: 200 }));
    await outboundFetch(
      "https://example.test/x",
      {
        method: "POST",
        headers: { "Idempotency-Key": "caller-supplied" },
      },
      { idempotencyKey: "order-42" }
    );
    const headers = new Headers(calls[0]!.init.headers ?? undefined);
    assert.equal(headers.get("Idempotency-Key"), "caller-supplied");
  });

  test("invokes circuit breaker hooks", async () => {
    let asserts = 0;
    let succ = 0;
    let fail = 0;
    mockFetch((n) => {
      if (n === 1) return new Response("oops", { status: 502 });
      return new Response("ok", { status: 200 });
    });
    const r = await outboundFetch(
      "https://example.test/x",
      { method: "GET" },
      {
        retries: 2,
        circuit: {
          assertClosed: async () => {
            asserts++;
          },
          recordSuccess: async () => {
            succ++;
          },
          recordFailure: async () => {
            fail++;
          },
        },
      }
    );
    assert.equal(r.status, 200);
    assert.equal(asserts, 1, "assertClosed runs once before retry loop");
    assert.equal(fail, 1, "first 502 records a failure");
    assert.equal(succ, 1, "final 200 records a success");
  });

  test("circuit breaker open throws before fetch", async () => {
    mockFetch(() => new Response("ok", { status: 200 }));
    await assert.rejects(
      () =>
        outboundFetch(
          "https://example.test/x",
          { method: "GET" },
          {
            retries: 2,
            circuit: {
              assertClosed: async () => {
                throw new Error("circuit open");
              },
              recordSuccess: async () => {},
              recordFailure: async () => {},
            },
          }
        ),
      /circuit open/
    );
    assert.equal(calls.length, 0, "fetch is never called when circuit is open");
  });

  test("passes dispatcher through to fetch init", async () => {
    const dispatcher = { kind: "proxy-agent-stub" };
    mockFetch(() => new Response("ok", { status: 200 }));
    await outboundFetch("https://example.test/x", { method: "GET" }, {
      dispatcher: dispatcher as never,
    });
    assert.equal((calls[0]?.init as { dispatcher?: unknown }).dispatcher, dispatcher);
  });
});
