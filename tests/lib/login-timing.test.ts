/**
 * Unit tests for login timing helpers (P4 Auth Hardening).
 *
 * `verifyPasswordOrDummy` must:
 *   1. Return false for null/empty hash AND still spend non-trivial time.
 *   2. Return false for malformed hashes without throwing.
 *   3. Return true for matching password+hash, false otherwise.
 */
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import bcrypt from "bcrypt";
import {
  UNIFIED_LOGIN_FAILURE,
  verifyPasswordOrDummy,
} from "../../src/lib/login-timing.js";

const TEST_PASSWORD = "correct-horse-battery-staple";

describe("login-timing", () => {
  it("UNIFIED_LOGIN_FAILURE is the same across paths", () => {
    assert.equal(typeof UNIFIED_LOGIN_FAILURE, "string");
    assert.equal(UNIFIED_LOGIN_FAILURE, "Invalid email or password");
  });

  it("returns false for missing hash and runs the dummy compare", async () => {
    const start = Date.now();
    const ok = await verifyPasswordOrDummy(TEST_PASSWORD, null);
    const elapsed = Date.now() - start;
    assert.equal(ok, false);
    // bcrypt(10) is ~30ms+ on most laptops; we just want to confirm we
    // ran a real compare rather than returning false immediately.
    assert.ok(
      elapsed > 5,
      `expected dummy compare to take measurable time, got ${elapsed}ms`
    );
  });

  it("returns true when password matches a real hash", async () => {
    const hash = await bcrypt.hash(TEST_PASSWORD, 10);
    assert.equal(await verifyPasswordOrDummy(TEST_PASSWORD, hash), true);
  });

  it("returns false when password does not match", async () => {
    const hash = await bcrypt.hash(TEST_PASSWORD, 10);
    assert.equal(await verifyPasswordOrDummy("wrong-password", hash), false);
  });

  it("returns false (no throw) for malformed hashes", async () => {
    assert.equal(await verifyPasswordOrDummy(TEST_PASSWORD, "not-a-hash"), false);
  });

  it("returns false for empty string hash and still runs", async () => {
    const ok = await verifyPasswordOrDummy(TEST_PASSWORD, "");
    assert.equal(ok, false);
  });
});
