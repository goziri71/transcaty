/**
 * Unit tests for the platform-wide payout velocity circuit breaker
 * (assertPayoutVelocityAllowed). The underlying volume lookup is stubbed
 * via the test seam exported by src/lib/fraud-policy.ts so we don't need
 * a live DB.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  assertPayoutVelocityAllowed,
  __setPayoutVelocitySumForTesting,
  FraudPolicyRejectedError,
  PayoutVelocityReviewRequiredError,
} from "../../src/lib/fraud-policy.js";
import { __setJwtRevocationLookupForTesting } from "../../src/lib/jwt-revocation.js";

const ENV_KEYS = [
  "PAYOUT_VELOCITY_MODE",
  "PAYOUT_VELOCITY_CEILING_NGN_1H",
  "PAYOUT_VELOCITY_CEILING_NGN_24H",
  "PAYOUT_VELOCITY_CEILING_BDT_1H",
  "PAYOUT_VELOCITY_CEILING_BDT_24H",
];
const originalEnv: Record<string, string | undefined> = {};

describe("assertPayoutVelocityAllowed", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      originalEnv[k] = process.env[k];
      delete process.env[k];
    }
    // audit() best-effort-persists to the DB; keep lookups from touching
    // it too so this suite never depends on a live connection.
    __setJwtRevocationLookupForTesting(async () => false);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] == null) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
    __setPayoutVelocitySumForTesting(null);
    __setJwtRevocationLookupForTesting(null);
  });

  it("never throws when no ceiling is configured (fully inert by default)", async () => {
    __setPayoutVelocitySumForTesting(async () => 999_999_999);
    await assertPayoutVelocityAllowed({ environment: "live", currency: "NGN", amount: "1000" });
  });

  it("monitor mode (default) never throws even when a configured ceiling is exceeded", async () => {
    process.env.PAYOUT_VELOCITY_CEILING_NGN_1H = "1000";
    __setPayoutVelocitySumForTesting(async () => 900);
    await assertPayoutVelocityAllowed({ environment: "live", currency: "NGN", amount: "500" });
  });

  it("block mode throws FraudPolicyRejectedError at/over the ceiling", async () => {
    process.env.PAYOUT_VELOCITY_MODE = "block";
    process.env.PAYOUT_VELOCITY_CEILING_NGN_1H = "1000";
    __setPayoutVelocitySumForTesting(async () => 900);
    await assert.rejects(
      () => assertPayoutVelocityAllowed({ environment: "live", currency: "NGN", amount: "500" }),
      FraudPolicyRejectedError
    );
  });

  it("block mode does not throw strictly under the ceiling", async () => {
    process.env.PAYOUT_VELOCITY_MODE = "block";
    process.env.PAYOUT_VELOCITY_CEILING_NGN_1H = "1000";
    __setPayoutVelocitySumForTesting(async () => 400);
    await assertPayoutVelocityAllowed({ environment: "live", currency: "NGN", amount: "500" });
  });

  it("boundary: exactly at the ceiling does not throw (only strictly over does)", async () => {
    process.env.PAYOUT_VELOCITY_MODE = "block";
    process.env.PAYOUT_VELOCITY_CEILING_NGN_1H = "1000";
    __setPayoutVelocitySumForTesting(async () => 500);
    await assertPayoutVelocityAllowed({ environment: "live", currency: "NGN", amount: "500" });
  });

  it("review mode throws PayoutVelocityReviewRequiredError with the correct window", async () => {
    process.env.PAYOUT_VELOCITY_MODE = "review";
    process.env.PAYOUT_VELOCITY_CEILING_NGN_1H = "1000";
    __setPayoutVelocitySumForTesting(async () => 900);
    await assert.rejects(
      async () => {
        try {
          await assertPayoutVelocityAllowed({ environment: "live", currency: "NGN", amount: "500" });
        } catch (err) {
          assert.ok(err instanceof PayoutVelocityReviewRequiredError);
          assert.equal(err.window, "1h");
          assert.equal(err.ceiling, 1000);
          throw err;
        }
      },
      PayoutVelocityReviewRequiredError
    );
  });

  it("checks the 1h window before the 24h window", async () => {
    process.env.PAYOUT_VELOCITY_MODE = "review";
    process.env.PAYOUT_VELOCITY_CEILING_NGN_1H = "1000";
    process.env.PAYOUT_VELOCITY_CEILING_NGN_24H = "5000";
    __setPayoutVelocitySumForTesting(async ({ since }) => {
      // 1h window sum only slightly over its ceiling; 24h window sum well
      // under its (much larger) ceiling — the 1h breach must fire first.
      const isOneHourWindow = Date.now() - since.getTime() <= 60 * 60 * 1000 + 1000;
      return isOneHourWindow ? 900 : 100;
    });
    try {
      await assertPayoutVelocityAllowed({ environment: "live", currency: "NGN", amount: "200" });
      assert.fail("expected a PayoutVelocityReviewRequiredError");
    } catch (err) {
      assert.ok(err instanceof PayoutVelocityReviewRequiredError);
      assert.equal(err.window, "1h");
    }
  });

  it("currency scoping: a ceiling on one currency does not affect another", async () => {
    process.env.PAYOUT_VELOCITY_MODE = "block";
    process.env.PAYOUT_VELOCITY_CEILING_NGN_1H = "1000";
    // No BDT ceiling configured — BDT payouts must sail through regardless
    // of volume, even though the stub returns a huge number for any call.
    __setPayoutVelocitySumForTesting(async () => 10_000_000);
    await assertPayoutVelocityAllowed({ environment: "live", currency: "BDT", amount: "500" });
  });

  it("environment scoping is passed through to the volume lookup", async () => {
    process.env.PAYOUT_VELOCITY_MODE = "block";
    process.env.PAYOUT_VELOCITY_CEILING_NGN_1H = "1000";
    const seenEnvironments: string[] = [];
    __setPayoutVelocitySumForTesting(async ({ environment }) => {
      seenEnvironments.push(environment);
      return 0;
    });
    await assertPayoutVelocityAllowed({ environment: "test", currency: "NGN", amount: "1" });
    assert.ok(seenEnvironments.every((e) => e === "test"));
  });
});
