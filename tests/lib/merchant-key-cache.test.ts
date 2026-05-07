/**
 * Unit tests for the merchant API key in-process TTL cache.
 *
 * These tests exercise the cache layer directly (no DB) so they are
 * hermetic and run in milliseconds. They also pin small TTLs via env
 * vars so we can assert expiry behavior without sleeping for seconds.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

process.env.MERCHANT_KEY_CACHE_POSITIVE_TTL_MS = "50";
process.env.MERCHANT_KEY_CACHE_NEGATIVE_TTL_MS = "20";
process.env.MERCHANT_KEY_CACHE_MAX = "16";
process.env.MERCHANT_KEY_CACHE_ENABLED = "true";

const {
  clearMerchantKeyCache,
  getMerchantKeyCache,
  invalidateMerchantApiKeyCache,
  setMerchantKeyCacheHit,
  setMerchantKeyCacheMiss,
  merchantKeyCacheStats,
} = await import("../../src/lib/merchant-key-cache.js");

beforeEach(() => {
  clearMerchantKeyCache();
});

afterEach(() => {
  clearMerchantKeyCache();
});

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

describe("merchant-key-cache", () => {
  test("returns undefined for an unknown key", () => {
    assert.equal(getMerchantKeyCache("nope"), undefined);
  });

  test("stores and returns a positive entry", () => {
    setMerchantKeyCacheHit("h1", {
      keyId: "key-1",
      merchantId: "m-1",
      scopes: ["payin:create"],
      environment: "live",
      secret: "sssh",
    });
    const e = getMerchantKeyCache("h1");
    assert.ok(e);
    assert.equal(e.kind, "hit");
    if (e.kind === "hit") {
      assert.equal(e.value.keyId, "key-1");
      assert.equal(e.value.secret, "sssh");
    }
  });

  test("stores and returns a negative entry", () => {
    setMerchantKeyCacheMiss("h2");
    const e = getMerchantKeyCache("h2");
    assert.ok(e);
    assert.equal(e.kind, "miss");
  });

  test("positive entries expire after the positive TTL", async () => {
    setMerchantKeyCacheHit("h3", {
      keyId: "k",
      merchantId: "m",
      scopes: [],
      environment: "test",
      secret: "x",
    });
    assert.ok(getMerchantKeyCache("h3"));
    await sleep(80);
    assert.equal(getMerchantKeyCache("h3"), undefined);
  });

  test("negative entries expire on a shorter window than positive", async () => {
    setMerchantKeyCacheMiss("h4");
    assert.ok(getMerchantKeyCache("h4"));
    await sleep(35);
    assert.equal(getMerchantKeyCache("h4"), undefined);
  });

  test("invalidate removes both positive and negative entries", () => {
    setMerchantKeyCacheHit("a", {
      keyId: "k",
      merchantId: "m",
      scopes: [],
      environment: "test",
      secret: "x",
    });
    setMerchantKeyCacheMiss("b");

    invalidateMerchantApiKeyCache("a");
    invalidateMerchantApiKeyCache("b");

    assert.equal(getMerchantKeyCache("a"), undefined);
    assert.equal(getMerchantKeyCache("b"), undefined);
  });

  test("invalidate of an unknown hash is a no-op", () => {
    assert.doesNotThrow(() => invalidateMerchantApiKeyCache("never-cached"));
  });

  test("LRU-by-insertion eviction respects MERCHANT_KEY_CACHE_MAX", () => {
    // Cap is 16. Insert 20 entries; the oldest 4 should be gone.
    for (let i = 0; i < 20; i++) {
      setMerchantKeyCacheHit(`k-${i}`, {
        keyId: String(i),
        merchantId: "m",
        scopes: [],
        environment: "test",
        secret: "x",
      });
    }
    assert.equal(merchantKeyCacheStats().size, 16);
    for (let i = 0; i < 4; i++) {
      assert.equal(getMerchantKeyCache(`k-${i}`), undefined, `oldest ${i} should be evicted`);
    }
    for (let i = 4; i < 20; i++) {
      assert.ok(getMerchantKeyCache(`k-${i}`), `recent ${i} should still be cached`);
    }
  });

  test("stats counters track hits and misses", () => {
    setMerchantKeyCacheHit("s", {
      keyId: "k",
      merchantId: "m",
      scopes: [],
      environment: "test",
      secret: "x",
    });
    setMerchantKeyCacheMiss("t");

    const before = merchantKeyCacheStats();
    getMerchantKeyCache("s");
    getMerchantKeyCache("s");
    getMerchantKeyCache("t");

    const after = merchantKeyCacheStats();
    assert.equal(after.hits - before.hits, 2);
    assert.equal(after.negative - before.negative, 1);
  });
});
