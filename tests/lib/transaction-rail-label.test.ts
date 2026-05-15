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
});
