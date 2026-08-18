import assert from "node:assert/strict";
import { test } from "node:test";
import { applySpreadToCryptoAmount, applySpreadToRate } from "../../src/lib/fx/spread.js";
import { isIpv4Allowed, validateCidrList } from "../../src/lib/ip-cidr.js";
import { computeFeeFromSchedule } from "../../src/lib/billing/fee-calculator.js";

test("applySpreadToCryptoAmount adds bps to debit", () => {
  const r = applySpreadToCryptoAmount("100.00", 50);
  assert.equal(r.baseAmount, "100.00");
  assert.equal(r.spreadAmount, "0.50");
  assert.equal(r.totalDebit, "100.50");
});

test("applySpreadToRate widens rate for merchant", () => {
  assert.equal(applySpreadToRate(100, 100), 101);
});

test("isIpv4Allowed matches CIDR", () => {
  assert.equal(isIpv4Allowed("203.0.113.10", ["203.0.113.0/24"]), true);
  assert.equal(isIpv4Allowed("198.51.100.1", ["203.0.113.0/24"]), false);
});

test("isIpv4Allowed matches exact IPs above 128.0.0.0 (signed 32-bit bitwise)", () => {
  assert.equal(isIpv4Allowed("223.239.59.244", ["223.239.59.244"]), true);
  assert.equal(isIpv4Allowed("223.239.59.244", ["223.239.59.244/32"]), true);
  assert.equal(isIpv4Allowed("::ffff:223.239.59.244", ["223.239.59.244"]), true);
  assert.equal(isIpv4Allowed("27.60.174.40", ["27.60.174.40"]), true);
  assert.equal(isIpv4Allowed("223.239.59.245", ["223.239.59.244"]), false);
});

test("validateCidrList rejects bad entries", () => {
  const r = validateCidrList(["10.0.0.0/8", "not-an-ip"]);
  assert.equal(r.valid, false);
  assert.ok(r.errors.length > 0);
});

test("computeFeeFromSchedule applies flat + percentage with min", () => {
  const fee = computeFeeFromSchedule(
    {
      id: "s1",
      billingMode: "percentage_only",
      feePercentage: "2",
      feeFlat: "1",
      feeMin: "5",
      feeMax: null,
    },
    "100.00",
    "payin"
  );
  assert.ok(fee);
  assert.equal(fee!.feeAmount, "5.00");
});
