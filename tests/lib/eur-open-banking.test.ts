import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyEurPayinDecision,
  classifyEurPayoutDecision,
  parseEurCreditAmount,
  parseEurEventId,
  parseEurMerchantOrderId,
} from "../../services/integrations/tylt/eur-open-banking.js";

describe("EU Open Banking webhook parsing", () => {
  const payinCompleted = {
    data: {
      isBuying: 1,
      merchantOrderId: "tx-uuid",
      eventDetails: { eventId: 5, description: "Payment Completed" },
      accounts: {
        fiatAmount: 30,
        cryptoAmount: 35.5,
        fiatCurrency: "EUR",
        cryptoCurrency: "USDC",
      },
    },
  };

  it("parses merchantOrderId and eventId from pay-in webhook", () => {
    assert.equal(parseEurMerchantOrderId(payinCompleted), "tx-uuid");
    assert.equal(parseEurEventId(payinCompleted), 5);
  });

  it("classifies pay-in event 5 as success and 9 as failed", () => {
    assert.equal(classifyEurPayinDecision(5), "success");
    assert.equal(classifyEurPayinDecision(9), "failed");
    assert.equal(classifyEurPayinDecision(2), "non_terminal");
  });

  it("classifies payout event 11 as non_terminal", () => {
    assert.equal(classifyEurPayoutDecision(11), "non_terminal");
    assert.equal(classifyEurPayoutDecision(5), "success");
  });

  it("credits cryptoAmount from accounts", () => {
    assert.equal(parseEurCreditAmount(payinCompleted, "10.00"), "35.50");
  });
});
