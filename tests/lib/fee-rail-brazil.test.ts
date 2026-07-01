import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { providerToFeeRail } from "../../src/lib/billing/fee-rail.js";

describe("providerToFeeRail", () => {
  it("maps payok-br providers to brazil before generic payok", () => {
    assert.equal(providerToFeeRail("payok-br-payin", "BRL"), "brazil");
    assert.equal(providerToFeeRail("payok-br-payout", "BRL"), "brazil");
  });

  it("maps payok-bd providers to bangladesh", () => {
    assert.equal(providerToFeeRail("payok-bd-payin", "BDT"), "bangladesh");
  });

  it("maps BRL currency to brazil when provider missing", () => {
    assert.equal(providerToFeeRail(null, "BRL"), "brazil");
  });
});
