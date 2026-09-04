import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import {
  encryptBvn,
  decryptBvn,
  normalizeBvnVerificationStatus,
} from "../../src/lib/merchant-market-compliance.js";

describe("merchant market compliance", () => {
  const prior = process.env.ENCRYPTION_MASTER_KEY;

  before(() => {
    process.env.ENCRYPTION_MASTER_KEY = "a".repeat(64);
  });

  after(() => {
    if (prior === undefined) delete process.env.ENCRYPTION_MASTER_KEY;
    else process.env.ENCRYPTION_MASTER_KEY = prior;
  });

  it("encrypts and decrypts BVN round-trip", () => {
    const enc = encryptBvn("22123456789");
    assert.notEqual(enc, "22123456789");
    assert.equal(decryptBvn(enc), "22123456789");
  });

  it("strips whitespace before encrypting BVN", () => {
    const enc = encryptBvn("221 2345 6789");
    assert.equal(decryptBvn(enc), "22123456789");
  });

  it("normalizes BVN verification status", () => {
    assert.equal(normalizeBvnVerificationStatus("verified"), "verified");
    assert.equal(normalizeBvnVerificationStatus(""), "not_submitted");
    assert.equal(normalizeBvnVerificationStatus(undefined), "not_submitted");
    assert.equal(normalizeBvnVerificationStatus("UNKNOWN"), "not_submitted");
  });
});
