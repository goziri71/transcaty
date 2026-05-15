import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractPaymentInstructionsFromTyltData,
  extractTyltPayinDataEnvelope,
} from "../../services/integrations/tylt/crossramp-payin.js";

describe("tylt pay-in envelope", () => {
  it("extracts data block from webhook shape", () => {
    const data = extractTyltPayinDataEnvelope({
      data: {
        instanceId: "abc",
        trade: { event: { id: 2 } },
        paymentMethod: { details: { upiId: "pay@bank", qr: "upi://pay" } },
      },
    });
    assert.ok(data);
    assert.equal(data.instanceId, "abc");
    const instr = extractPaymentInstructionsFromTyltData(data);
    assert.equal(instr?.upiId, "pay@bank");
  });
});
