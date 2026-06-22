import assert from "node:assert/strict";
import { test } from "node:test";
import { validateMerchantApiIpRulesInput } from "../../src/lib/merchant-api-ip-rules.js";
import { evaluateMerchantIpAllowlist } from "../../src/lib/merchant-ip-whitelist.js";

test("validateMerchantApiIpRulesInput rejects enabled with empty cidrs", () => {
  const r = validateMerchantApiIpRulesInput({
    environment: "test",
    enabled: true,
    enforceMode: "strict",
    cidrs: [],
  });
  assert.equal(r.valid, false);
  if (!r.valid) {
    assert.match(r.message, /At least one CIDR/);
  }
});

test("validateMerchantApiIpRulesInput rejects invalid cidrs when disabled", () => {
  const r = validateMerchantApiIpRulesInput({
    environment: "live",
    enabled: false,
    enforceMode: "strict",
    cidrs: ["not-an-ip"],
  });
  assert.equal(r.valid, false);
});

test("evaluateMerchantIpAllowlist allows when disabled", () => {
  assert.deepEqual(
    evaluateMerchantIpAllowlist({ enabled: false, enforceMode: "strict", cidrs: [] }, "1.2.3.4"),
    { allowed: true }
  );
});

test("evaluateMerchantIpAllowlist blocks unknown IP in strict mode", () => {
  assert.deepEqual(
    evaluateMerchantIpAllowlist(
      { enabled: true, enforceMode: "strict", cidrs: ["203.0.113.0/24"] },
      "198.51.100.1"
    ),
    { allowed: false, reason: "ip_not_allowed" }
  );
});

test("evaluateMerchantIpAllowlist allows matching IP in strict mode", () => {
  assert.deepEqual(
    evaluateMerchantIpAllowlist(
      { enabled: true, enforceMode: "strict", cidrs: ["203.0.113.0/24"] },
      "203.0.113.10"
    ),
    { allowed: true }
  );
});

test("evaluateMerchantIpAllowlist allows unknown IP in log_only mode", () => {
  assert.deepEqual(
    evaluateMerchantIpAllowlist(
      { enabled: true, enforceMode: "log_only", cidrs: ["203.0.113.0/24"] },
      "198.51.100.1"
    ),
    { allowed: true }
  );
});
