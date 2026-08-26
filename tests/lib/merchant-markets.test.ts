import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MARKET_SETTLEMENT_CURRENCIES,
  marketForCurrency,
  isMerchantMarket,
  deriveMarketBoardFields,
  pickOwningMarketForSharedCurrency,
  type MerchantMarketRow,
} from "../../src/lib/merchant-markets.js";

describe("merchant-markets", () => {
  function marketRow(
    market: MerchantMarketRow["market"],
    entitlementStatus: MerchantMarketRow["entitlementStatus"],
    kybStatus: MerchantMarketRow["kybStatus"] = "verified"
  ): MerchantMarketRow {
    return {
      market,
      entitlementStatus,
      kybStatus,
      requestedAt: null,
      approvedAt: entitlementStatus === "approved" ? new Date() : null,
    };
  }

  it("maps currencies to markets", () => {
    assert.equal(marketForCurrency("BDT"), "bangladesh");
    assert.equal(marketForCurrency("USDT"), "india");
    assert.equal(marketForCurrency("USDC"), "europe");
    assert.equal(marketForCurrency("PYUSD-USDC"), "pyusd");
  });

  it("defines settlement currencies per market", () => {
    assert.deepEqual(MARKET_SETTLEMENT_CURRENCIES.bangladesh, ["BDT"]);
    assert.deepEqual(MARKET_SETTLEMENT_CURRENCIES.india, ["USDT"]);
    assert.deepEqual(MARKET_SETTLEMENT_CURRENCIES.europe, ["USDC"]);
    assert.deepEqual(MARKET_SETTLEMENT_CURRENCIES.pyusd, ["PYUSD-USDC"]);
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
        market: "europe",
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

  it("marks Bangladesh not ready while the PayOK rail is paused", () => {
    const prev = process.env.BANGLADESH_PAYMENTS_DISABLED;
    delete process.env.BANGLADESH_PAYMENTS_DISABLED;
    try {
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
      assert.equal(row.ready, false);
      assert.equal(row.blockers[0]?.code, "provider_unavailable");
    } finally {
      if (prev === undefined) delete process.env.BANGLADESH_PAYMENTS_DISABLED;
      else process.env.BANGLADESH_PAYMENTS_DISABLED = prev;
    }
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

  it("does not treat missing test PYUSD pocket as unprovisioned", () => {
    const row = deriveMarketBoardFields({
      market: {
        market: "pyusd",
        entitlementStatus: "approved",
        kybStatus: "verified",
        requestedAt: null,
        approvedAt: new Date(),
      },
      globalKycStatus: "verified",
      walletsProvisioned: false,
      environment: "test",
    });
    assert.equal(row.activationStatus, "active");
    assert.equal(row.ready, false);
    assert.equal(row.blockers.some((b) => b.code === "wallet_not_provisioned"), false);
    assert.equal(row.blockers.some((b) => b.code === "live_only"), true);
  });

  it("still flags missing live PYUSD pocket as unprovisioned", () => {
    const row = deriveMarketBoardFields({
      market: {
        market: "pyusd",
        entitlementStatus: "approved",
        kybStatus: "verified",
        requestedAt: null,
        approvedAt: new Date(),
      },
      globalKycStatus: "verified",
      walletsProvisioned: false,
      environment: "live",
    });
    assert.equal(row.blockers.some((b) => b.code === "wallet_not_provisioned"), true);
    assert.equal(row.blockers.some((b) => b.code === "live_only"), false);
  });

  it("attributes USDC to Europe even when PYUSD is the only approved market", () => {
    const owner = pickOwningMarketForSharedCurrency(
      [marketRow("europe", "disabled"), marketRow("pyusd", "approved")],
      "USDC"
    );
    assert.equal(owner?.market, "europe");
  });

  it("attributes PYUSD-USDC to PYUSD when both Europe and PYUSD are active", () => {
    const owner = pickOwningMarketForSharedCurrency(
      [marketRow("europe", "approved"), marketRow("pyusd", "approved")],
      "PYUSD-USDC"
    );
    assert.equal(owner?.market, "pyusd");
  });

  it("keeps Europe as USDC owner when both Europe and PYUSD are active", () => {
    const owner = pickOwningMarketForSharedCurrency(
      [marketRow("europe", "approved"), marketRow("pyusd", "approved")],
      "USDC"
    );
    assert.equal(owner?.market, "europe");
  });
});
