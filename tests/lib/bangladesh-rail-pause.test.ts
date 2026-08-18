import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  assertBangladeshPaymentsEnabled,
  BangladeshRailPausedError,
  isBangladeshPaymentsPaused,
} from "../../src/lib/bangladesh-rail-pause.js";

const saved = process.env.BANGLADESH_PAYMENTS_DISABLED;

afterEach(() => {
  if (saved === undefined) delete process.env.BANGLADESH_PAYMENTS_DISABLED;
  else process.env.BANGLADESH_PAYMENTS_DISABLED = saved;
});

describe("bangladesh rail pause", () => {
  test("paused by default when env is unset", () => {
    delete process.env.BANGLADESH_PAYMENTS_DISABLED;
    assert.equal(isBangladeshPaymentsPaused(), true);
    assert.throws(() => assertBangladeshPaymentsEnabled(), BangladeshRailPausedError);
  });

  test("paused when explicitly true", () => {
    process.env.BANGLADESH_PAYMENTS_DISABLED = "true";
    assert.equal(isBangladeshPaymentsPaused(), true);
  });

  test("restored when set to false", () => {
    process.env.BANGLADESH_PAYMENTS_DISABLED = "false";
    assert.equal(isBangladeshPaymentsPaused(), false);
    assert.doesNotThrow(() => assertBangladeshPaymentsEnabled());
  });
});
