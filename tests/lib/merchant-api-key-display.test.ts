import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { maskMerchantApiKey, merchantApiKeyHint } from "../../src/lib/merchant-api-key-display.js";

describe("merchant-api-key-display", () => {
  it("stores last 8 chars as hint", () => {
    const key = "transacty_" + "a".repeat(40) + "deadbeef";
    assert.equal(merchantApiKeyHint(key), "deadbeef");
  });

  it("masks with hint suffix", () => {
    assert.equal(maskMerchantApiKey("deadbeef"), "••••••••deadbeef");
  });

  it("legacy rows without hint show generic mask", () => {
    assert.equal(maskMerchantApiKey(null), "transacty_••••••••");
    assert.equal(maskMerchantApiKey(""), "transacty_••••••••");
  });
});
