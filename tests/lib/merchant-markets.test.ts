import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MARKET_SETTLEMENT_CURRENCIES,
  marketForCurrency,
  isMerchantMarket,
  deriveMarketBoardFields,
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

  it("derives unlock reason when market not requested", () => {
    const row = deriveMarketBoardFields({
      market: {
        market: "europe",
        entitlementStatus: "disabled",
        kybStatus: "not_started",
        requestedAt: null,
        approvedAt: null,
      },
      globalKycStatus: "verified",
      walletsProvisioned: false,
    });
    assert.equal(row.canRequest, true);
    assert.equal(row.ready, false);
    assert.equal(row.blockers[0]?.code, "not_requested");
    assert.match(row.unlockReason ?? "", /Request access/);
  });

  it("marks market ready when approved, KYC ok, wallet provisioned", () => {
    const row = deriveMarketBoardFields({
      market: {
        market: "bangladesh",
        entitlementStatus: "approved",
        kybStatus: "verified",
        requestedAt: null,
        approvedAt: new Date(),
      },
      globalKycStatus: "verified",
      walletsProvisioned: true,
    });
    assert.equal(row.ready, true);
    assert.equal(row.unlockReason, null);
    assert.equal(row.canRequest, false);
    assert.equal(row.activationStatus, "active");
  });

  it("blocks suspended markets", () => {
    const row = deriveMarketBoardFields({
      market: {
        market: "india",
        entitlementStatus: "suspended",
        kybStatus: "verified",
        requestedAt: null,
        approvedAt: new Date(),
      },
      globalKycStatus: "verified",
      walletsProvisioned: true,
    });
    assert.equal(row.ready, false);
    assert.equal(row.blockers[0]?.code, "suspended");
  });
});
