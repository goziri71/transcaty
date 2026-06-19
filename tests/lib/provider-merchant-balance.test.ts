import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pickPrimaryMerchantWallet,
  primaryMerchantBalanceByMerchantId,
} from "../../src/lib/provider-merchant-balance.js";

test("pickPrimaryMerchantWallet prefers live BDT over test BDT", () => {
  const picked = pickPrimaryMerchantWallet([
    { environment: "test", currency: "BDT", balance: "500.00" },
    { environment: "live", currency: "BDT", balance: "100.00" },
  ]);
  assert.equal(picked?.balance, "100.00");
  assert.equal(picked?.environment, "live");
});

test("pickPrimaryMerchantWallet falls back to test wallet when no live wallet", () => {
  const picked = pickPrimaryMerchantWallet([
    { environment: "test", currency: "BDT", balance: "250.00" },
  ]);
  assert.equal(picked?.balance, "250.00");
  assert.equal(picked?.environment, "test");
});

test("primaryMerchantBalanceByMerchantId respects environment filter", () => {
  const map = primaryMerchantBalanceByMerchantId(
    [
      { merchantId: "m1", environment: "test", currency: "BDT", balance: "10.00" },
      { merchantId: "m1", environment: "live", currency: "BDT", balance: "99.00" },
    ],
    ["m1"],
    "test"
  );
  assert.equal(map.get("m1")?.balance, "10.00");
  assert.equal(map.get("m1")?.environment, "test");
});
