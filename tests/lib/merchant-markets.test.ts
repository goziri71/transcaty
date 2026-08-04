import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MARKET_SETTLEMENT_CURRENCIES,
  marketForCurrency,
  isMerchantMarket,
} from "../../src/lib/merchant-markets.js";

describe("merchant-markets", () => {
  it("maps currencies to markets", () => {
    assert.equal(marketForCurrency("BDT"), "bangladesh");
    assert.equal(marketForCurrency("USDT"), "india");
    assert.equal(marketForCurrency("USDC"), "europe");
  });

  it("defines settlement currencies per market", () => {
    assert.deepEqual(MARKET_SETTLEMENT_CURRENCIES.bangladesh, ["BDT"]);
    assert.deepEqual(MARKET_SETTLEMENT_CURRENCIES.india, ["USDT"]);
    assert.deepEqual(MARKET_SETTLEMENT_CURRENCIES.europe, ["USDC"]);
    assert.deepEqual(MARKET_SETTLEMENT_CURRENCIES.pyusd, ["USDC"]);
  });

  it("validates market ids", () => {
    assert.equal(isMerchantMarket("europe"), true);
    assert.equal(isMerchantMarket("pyusd"), true);
    assert.equal(isMerchantMarket("invalid"), false);
  });
});
