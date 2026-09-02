import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractNgnPaymentInstructions,
  isNgnCollectionCredited,
  isNgnCollectionTerminalFailure,
} from "./ngn-collect.js";

describe("Tekko NGN collection status mapping", () => {
  it("credits only on credited", () => {
    assert.equal(isNgnCollectionCredited("credited"), true);
    assert.equal(isNgnCollectionCredited("CREDITED"), true);
    assert.equal(isNgnCollectionCredited("awaiting_payment"), false);
    assert.equal(isNgnCollectionCredited("failed"), false);
    assert.equal(isNgnCollectionCredited(null), false);
  });

  it("treats failed and expired as terminal failure", () => {
    assert.equal(isNgnCollectionTerminalFailure("failed"), true);
    assert.equal(isNgnCollectionTerminalFailure("expired"), true);
    assert.equal(isNgnCollectionTerminalFailure("awaiting_payment"), false);
    assert.equal(isNgnCollectionTerminalFailure("credited"), false);
  });

  it("extracts bank instructions from provider.data", () => {
    const instructions = extractNgnPaymentInstructions({
      data: {
        accountNumber: "0123456789",
        bankName: "Wema Bank",
        accountName: "Ada Okafor",
        expiryDate: "2026-09-02T18:00:00.000Z",
      },
    });
    assert.equal(instructions.accountNumber, "0123456789");
    assert.equal(instructions.bankName, "Wema Bank");
    assert.equal(instructions.accountName, "Ada Okafor");
    assert.equal(instructions.expiryDate, "2026-09-02T18:00:00.000Z");
  });

  it("extracts bank instructions from flat provider object", () => {
    const instructions = extractNgnPaymentInstructions({
      account_number: "9876543210",
      bank_name: "Access Bank",
      account_name: "Bola",
      expiry_date: "2026-09-02T20:00:00.000Z",
    });
    assert.equal(instructions.accountNumber, "9876543210");
    assert.equal(instructions.bankName, "Access Bank");
  });
});
