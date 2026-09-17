/**
 * Unit tests for the pure parts of src/lib/payout-approvals.ts (the
 * per-currency dual-control threshold lookup). The DB-dependent behavior
 * (queueing, self-approval guard, expiry, atomic double-approve race,
 * reject-then-approve) is covered by
 * tests/integration/payout-approvals-integration.test.ts, which needs a
 * live Postgres and is skipped otherwise — this file must not touch the
 * DB, per this repo's tests/lib/*.test.ts convention.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { getPortalPayoutApprovalThreshold } from "../../src/lib/payout-approvals.js";

const ENV_KEYS = [
  "PORTAL_PAYOUT_APPROVAL_THRESHOLD_NGN",
  "PORTAL_PAYOUT_APPROVAL_THRESHOLD_EUR",
  "PORTAL_PAYOUT_APPROVAL_THRESHOLD_DEFAULT",
];
const originalEnv: Record<string, string | undefined> = {};

describe("getPortalPayoutApprovalThreshold", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      originalEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] == null) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("is disabled (0) when nothing is configured", () => {
    assert.equal(getPortalPayoutApprovalThreshold("NGN"), 0);
  });

  it("uses the per-currency env var when set", () => {
    process.env.PORTAL_PAYOUT_APPROVAL_THRESHOLD_NGN = "500000";
    assert.equal(getPortalPayoutApprovalThreshold("NGN"), 500_000);
  });

  it("is case-insensitive on the currency code", () => {
    process.env.PORTAL_PAYOUT_APPROVAL_THRESHOLD_NGN = "500000";
    assert.equal(getPortalPayoutApprovalThreshold("ngn"), 500_000);
  });

  it("falls back to the default threshold when the currency has none configured", () => {
    process.env.PORTAL_PAYOUT_APPROVAL_THRESHOLD_DEFAULT = "10000";
    assert.equal(getPortalPayoutApprovalThreshold("BRL"), 10_000);
  });

  it("a configured per-currency threshold takes priority over the default", () => {
    process.env.PORTAL_PAYOUT_APPROVAL_THRESHOLD_EUR = "20000";
    process.env.PORTAL_PAYOUT_APPROVAL_THRESHOLD_DEFAULT = "10000";
    assert.equal(getPortalPayoutApprovalThreshold("EUR"), 20_000);
  });

  it("currency scoping: one currency's threshold does not leak into another", () => {
    process.env.PORTAL_PAYOUT_APPROVAL_THRESHOLD_NGN = "500000";
    assert.equal(getPortalPayoutApprovalThreshold("EUR"), 0);
  });
});
