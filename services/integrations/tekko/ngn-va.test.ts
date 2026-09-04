import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractNgnVaDetails, tekkoDetailIndicatesBvnRequired } from "./ngn-va.js";

describe("Tekko NGN VA parse", () => {
  it("extracts VA fields from data envelope", () => {
    const details = extractNgnVaDetails({
      data: {
        status: "active",
        accountNumber: "0123456789",
        bankName: "Wema Bank",
        accountName: "Ada Okafor",
        currency: "NGN",
      },
    });
    assert.equal(details.status, "active");
    assert.equal(details.accountNumber, "0123456789");
    assert.equal(details.bankName, "Wema Bank");
    assert.equal(details.accountName, "Ada Okafor");
    assert.equal(details.currency, "NGN");
  });

  it("extracts VA from wallet.virtualAccount shape", () => {
    const details = extractNgnVaDetails({
      data: {
        wallet: {
          virtualAccount: {
            status: "active",
            account_number: "9876543210",
            bank_name: "Access Bank",
            account_name: "Bola",
          },
        },
      },
    });
    assert.equal(details.accountNumber, "9876543210");
    assert.equal(details.bankName, "Access Bank");
    assert.equal(details.accountName, "Bola");
  });
});

describe("Tekko NGN BVN payout gate", () => {
  it("detects Tekko BVN-required withdraw copy", () => {
    assert.equal(
      tekkoDetailIndicatesBvnRequired(
        "Merchant BVN verification required before NGN swaps. Complete KYB → BVN in the dashboard."
      ),
      true
    );
    assert.equal(tekkoDetailIndicatesBvnRequired("Insufficient master wallet balance"), false);
  });

  it("detects swaps wording without verification required phrase", () => {
    assert.equal(
      tekkoDetailIndicatesBvnRequired("Merchant BVN verification required before NGN swaps"),
      true
    );
  });
});
