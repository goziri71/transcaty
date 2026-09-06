import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  assertMerchantAllowedForNgnBvnOpsSync,
  parseNgnBvnOpsSyncAllowlist,
} from "../../src/lib/tekko-ngn-bvn-ops-sync-allowlist.js";

const DANIEL = "85305e39-5cd5-4e81-b5ea-58ba10c0f110";

describe("tekko-ngn-bvn-ops-sync-allowlist", () => {
  const prev = process.env.TEKKO_NGN_BVN_OPS_SYNC_MERCHANT_ALLOWLIST;

  beforeEach(() => {
    delete process.env.TEKKO_NGN_BVN_OPS_SYNC_MERCHANT_ALLOWLIST;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.TEKKO_NGN_BVN_OPS_SYNC_MERCHANT_ALLOWLIST;
    else process.env.TEKKO_NGN_BVN_OPS_SYNC_MERCHANT_ALLOWLIST = prev;
  });

  it("disabled when env unset", () => {
    assert.equal(parseNgnBvnOpsSyncAllowlist(), null);
    const r = assertMerchantAllowedForNgnBvnOpsSync(DANIEL);
    assert.equal(r.ok, false);
  });

  it("allows only listed merchant ids", () => {
    process.env.TEKKO_NGN_BVN_OPS_SYNC_MERCHANT_ALLOWLIST = DANIEL;
    assert.ok(assertMerchantAllowedForNgnBvnOpsSync(DANIEL).ok);
    const other = "11111111-1111-1111-1111-111111111111";
    assert.equal(assertMerchantAllowedForNgnBvnOpsSync(other).ok, false);
  });
});
