import assert from "node:assert/strict";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { describe, it } from "node:test";
import {
  EMPTY_BODY_SHA256,
  buildTekkoCanonicalString,
  sha256Hex,
  signTekkoCanonicalString,
  signTekkoPlatformRequest,
} from "./sign.js";

describe("Tekko Ed25519 signing", () => {
  it("sha256Hex empty body matches known digest", () => {
    assert.equal(sha256Hex(""), EMPTY_BODY_SHA256);
  });

  it("buildTekkoCanonicalString is five newline-separated fields", () => {
    const c = buildTekkoCanonicalString({
      timestamp: "1700000000000",
      method: "post",
      path: "/api/v1/platform/customers",
      rawBody: '{"a":1}',
      idempotencyKey: "idem-1",
    });
    const lines = c.split("\n");
    assert.equal(lines.length, 5);
    assert.equal(lines[0], "1700000000000");
    assert.equal(lines[1], "POST");
    assert.equal(lines[2], "/api/v1/platform/customers");
    assert.equal(lines[3], sha256Hex('{"a":1}'));
    assert.equal(lines[4], "idem-1");
  });

  it("GET signing uses empty idempotency key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const signed = signTekkoPlatformRequest({
      method: "GET",
      path: "/api/v1/platform/customers/1",
      privateKeyPem: pem,
      keyId: "kid-1",
      timestampMs: 1_700_000_000_000,
      idempotencyKey: "should-be-ignored",
    });
    assert.equal(signed.canonical.split("\n")[4], "");
    assert.match(signed.signature, /^[A-Za-z0-9_-]+$/);
  });

  it("signTekkoCanonicalString verifies with matching public key", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const canonical = buildTekkoCanonicalString({
      timestamp: "42",
      method: "POST",
      path: "/api/v1/platform/x",
      rawBody: "{}",
      idempotencyKey: "k",
    });
    const signature = signTekkoCanonicalString(canonical, pem);
    const ok = cryptoVerify(
      null,
      Buffer.from(canonical, "utf8"),
      publicKey,
      Buffer.from(signature, "base64url")
    );
    assert.equal(ok, true);
  });
});
