import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  limitsForMerchantWalletCurrency,
  merchantWalletRegionForCurrency,
  pickPrimaryPortalWalletItem,
  presentPortalWalletBalanceItem,
} from "../../src/lib/portal-wallet-balance.js";

describe("portal-wallet-balance", () => {
  it("maps currency to region", () => {
    assert.equal(merchantWalletRegionForCurrency("BDT"), "bangladesh");
    assert.equal(merchantWalletRegionForCurrency("usdt"), "india");
    assert.equal(merchantWalletRegionForCurrency("USDC"), "europe");
  });

  it("uses Bangladesh limits for BDT", () => {
    const l = limitsForMerchantWalletCurrency("BDT");
    assert.equal(l.payin.min, 200);
    assert.equal(l.payout.max, 25_000);
  });

  it("uses India limits for USDT", () => {
    const l = limitsForMerchantWalletCurrency("USDT");
    assert.equal(l.payin.min, 1);
    assert.equal(l.payin.max, 500_000);
  });

  it("prefers BDT as primary", () => {
    const usdt = presentPortalWalletBalanceItem({
      id: "a",
      currency: "USDT",
      balance: "10",
      status: "active",
      label: null,
      updatedAt: new Date("2026-01-01"),
      createdAt: new Date("2026-01-01"),
    });
    const bdt = presentPortalWalletBalanceItem({
      id: "b",
      currency: "BDT",
      balance: "100",
      status: "active",
      label: null,
      updatedAt: new Date("2026-01-01"),
      createdAt: new Date("2026-01-01"),
    });
    const primary = pickPrimaryPortalWalletItem([usdt, bdt]);
    assert.equal(primary?.currency, "BDT");
  });

  it("presents full balance card fields", () => {
    const item = presentPortalWalletBalanceItem({
      id: "w1",
      currency: "USDT",
      balance: "2287.72",
      status: "active",
      label: null,
      updatedAt: new Date("2026-05-25T13:43:44.203Z"),
      createdAt: new Date("2026-01-01"),
    });
    assert.equal(item.balance, "2287.72");
    assert.equal(item.availableBalance, "2287.72");
    assert.equal(item.region, "india");
    assert.equal(item.displayLabel, "India (USDT)");
    assert.ok(item.limits.payin.max > 0);
  });
});
