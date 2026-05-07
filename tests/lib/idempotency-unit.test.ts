/**
 * Pure-function tests for src/lib/idempotency.ts. No DB required.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalStringify, computeBodyHash } from "../../src/lib/idempotency.js";

test("canonicalStringify produces stable output regardless of key order", () => {
  const a = canonicalStringify({ b: 2, a: 1, c: { z: 9, y: 8 } });
  const b = canonicalStringify({ a: 1, c: { y: 8, z: 9 }, b: 2 });
  assert.equal(a, b);
});

test("canonicalStringify preserves array order", () => {
  const a = canonicalStringify({ items: [3, 1, 2] });
  const b = canonicalStringify({ items: [3, 1, 2] });
  assert.equal(a, b);
  // Arrays with different order must serialize differently.
  const c = canonicalStringify({ items: [1, 2, 3] });
  assert.notEqual(a, c);
});

test("computeBodyHash is deterministic and 64 hex chars", () => {
  const h1 = computeBodyHash({ amount: "10.00", currency: "BDT" });
  const h2 = computeBodyHash({ currency: "BDT", amount: "10.00" });
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test("computeBodyHash distinguishes different bodies", () => {
  const a = computeBodyHash({ amount: "10.00" });
  const b = computeBodyHash({ amount: "10.01" });
  assert.notEqual(a, b);
});
