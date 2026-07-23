import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_MERCHANT_API_SCOPES,
  normalizeMerchantApiScopes,
} from "../../src/lib/merchant-api-scopes.js";
import {
  PASSWORD_MIN_LENGTH,
  validatePasswordStrength,
} from "../../src/lib/password-policy.js";

describe("normalizeMerchantApiScopes", () => {
  it("defaults when scopes omitted", () => {
    const r = normalizeMerchantApiScopes(undefined);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, DEFAULT_MERCHANT_API_SCOPES);
  });

  it("rejects empty array", () => {
    const r = normalizeMerchantApiScopes([]);
    assert.equal(r.ok, false);
  });

  it("rejects unknown scope", () => {
    const r = normalizeMerchantApiScopes(["payin:create", "admin:all"]);
    assert.equal(r.ok, false);
  });

  it("dedupes and joins allowed scopes", () => {
    const r = normalizeMerchantApiScopes(["payin:create", "payin:create", "balance:read"]);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value, "payin:create,balance:read");
  });
});

describe("validatePasswordStrength", () => {
  it(`rejects shorter than ${PASSWORD_MIN_LENGTH}`, () => {
    const r = validatePasswordStrength("Abcd123");
    assert.equal(r.ok, false);
  });

  it("rejects letters-only", () => {
    const r = validatePasswordStrength("Abcdefghij");
    assert.equal(r.ok, false);
  });

  it("rejects common password", () => {
    const r = validatePasswordStrength("password123");
    assert.equal(r.ok, false);
  });

  it("accepts a reasonable password", () => {
    const r = validatePasswordStrength("CorrectHorse9");
    assert.equal(r.ok, true);
  });
});
