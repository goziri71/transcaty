import assert from "node:assert/strict";
import { test } from "node:test";
import { FEE_PERCENTAGE_MAX, parseFeePercentageInput } from "../../src/lib/billing/fee-percentage.js";

test("parseFeePercentageInput accepts whole percent values", () => {
  assert.deepEqual(parseFeePercentageInput("10"), { ok: true, value: "10.0000" });
  assert.deepEqual(parseFeePercentageInput("1.5"), { ok: true, value: "1.5000" });
});

test("parseFeePercentageInput rejects values above DB max", () => {
  const r = parseFeePercentageInput(String(FEE_PERCENTAGE_MAX + 0.0001));
  assert.equal(r.ok, false);
});

test("parseFeePercentageInput rejects negative values", () => {
  const r = parseFeePercentageInput("-1");
  assert.equal(r.ok, false);
});
