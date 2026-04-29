import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPayloadForTyltGet, createTyltSignature, verifyTyltSignature } from "./sign.js";

test("canonicalPayloadForTyltGet: empty params is {}", () => {
  assert.equal(canonicalPayloadForTyltGet({}), "{}");
});

test("canonicalPayloadForTyltGet is stable across key insertion order", () => {
  const a = { z: 1, a: 2, m: { y: 1, x: 2 } };
  const b = { m: { x: 2, y: 1 }, a: 2, z: 1 };
  assert.equal(canonicalPayloadForTyltGet(a), canonicalPayloadForTyltGet(b));
  assert.equal(
    canonicalPayloadForTyltGet({ merchantOrderId: "abc" }),
    '{"merchantOrderId":"abc"}'
  );
});

test("GET signing uses same canonical string as signature input", () => {
  const secret = "sec";
  const qp = { b: 2, a: 1 };
  const payload = canonicalPayloadForTyltGet(qp);
  assert.equal(payload, '{"a":1,"b":2}');
  const sig = createTyltSignature(secret, payload);
  assert.equal(sig, createTyltSignature(secret, canonicalPayloadForTyltGet({ b: 2, a: 1 })));
});

test("createTyltSignature is deterministic hex HMAC-SHA256", () => {
  const sig = createTyltSignature("secret", '{"a":1}');
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.equal(createTyltSignature("secret", '{"a":1}'), sig);
});

test("verifyTyltSignature accepts matching header", () => {
  const raw = '{"merchantOrderId":"x"}';
  const secret = "s3cr3t";
  const sig = createTyltSignature(secret, raw);
  assert.equal(verifyTyltSignature(secret, raw, sig), true);
  assert.equal(verifyTyltSignature(secret, raw, sig.toUpperCase()), true);
  assert.equal(verifyTyltSignature(secret, raw, "wrong"), false);
  assert.equal(verifyTyltSignature(secret, raw, undefined), false);
});
