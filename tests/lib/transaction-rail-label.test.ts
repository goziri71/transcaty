import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { presentTransactionRail } from "../../src/lib/transaction-rail-label.js";

describe("presentTransactionRail", () => {
  it("labels Bangladesh pay-in without vendor name", () => {
    const p = presentTransactionRail({ provider: "payok-bd-payin", currency: "BDT" });
    assert.equal(p.rail, "bangladesh");
    assert.equal(p.railLabel, "Bangladesh pay-in");
    assert.equal("provider" in p, false);
    assert.equal("product" in p, false);
  });

  it("labels Brazil pay-in and payout", () => {
    const payin = presentTransactionRail({ provider: "payok-br-payin", currency: "BRL" });
    assert.equal(payin.rail, "brazil");
    assert.equal(payin.railLabel, "Brazil pay-in");

    const payout = presentTransactionRail({ provider: "payok-br-payout", currency: "BRL" });
    assert.equal(payout.rail, "brazil");
    assert.equal(payout.railLabel, "Brazil payout");
  });

  it("infers Brazil from BRL currency", () => {
    const p = presentTransactionRail({ provider: null, currency: "BRL" });
    assert.equal(p.rail, "brazil");
    assert.equal(p.railLabel, "Brazil");
  });

  it("labels India UPI H2H without vendor name", () => {
    const p = presentTransactionRail({
      provider: "tylt-h2h-upi",
      currency: "INR",
      metadata: JSON.stringify({ rail: "tylt", tyltProduct: "h2h_upi" }),
    });
    assert.equal(p.rail, "india");
    assert.equal(p.railLabel, "India UPI (H2H)");
  });

  it("infers India from INR when provider missing on failed create", () => {
    const p = presentTransactionRail({ provider: null, currency: "INR" });
    assert.equal(p.rail, "india");
    assert.equal(p.railLabel, "India UPI");
  });

  it("does not label unknown tylt providers as India", () => {
    const p = presentTransactionRail({ provider: "tylt-eur-payin", currency: "EUR" });
    assert.equal(p.rail, "europe");
    assert.equal(p.railLabel, "Europe pay-in");
  });

  it("does not infer India from generic tylt metadata without a known product", () => {
    const p = presentTransactionRail({
      provider: null,
      currency: "EUR",
      metadata: JSON.stringify({ rail: "tylt", tyltProduct: "eur_payin" }),
    });
    assert.equal(p.rail, "europe");
  });

  it("labels unrecognized tylt provider as cross-border unknown", () => {
    const p = presentTransactionRail({ provider: "tylt-future-lane", currency: "GBP" });
    assert.equal(p.rail, "unknown");
    assert.equal(p.railLabel, "Cross-border");
  });

  it("labels Tekko PYUSD pay-in", () => {
    const p = presentTransactionRail({ provider: "tekko-pyusd-payin", currency: "PYUSD" });
    assert.equal(p.rail, "pyusd");
    assert.equal(p.railLabel, "PYUSD pay-in");
  });

  it("infers PYUSD from tekko metadata when provider missing", () => {
    const p = presentTransactionRail({
      provider: null,
      currency: "USDC",
      metadata: JSON.stringify({ rail: "tekko", tekkoProduct: "pyusd_payin" }),
    });
    assert.equal(p.rail, "pyusd");
    assert.equal(p.railLabel, "PYUSD pay-in");
  });
});
