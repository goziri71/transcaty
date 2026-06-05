import assert from "node:assert/strict";
import test from "node:test";
import {
  isTyltManualSettlementSuccessWebhook,
  parseCrossRampEventId,
  parseManualSettlement,
  parseUpiPayinSettlementCurrency,
} from "./crossramp-payin.js";

const MANUAL_SUCCESS_PAYLOAD = {
  data: {
    trade: { event: { id: 4, description: "Seller Acknowledges Payment Receipt. Trade Completed." } },
    transaction: { merchantOrderId: "529339ed-775c-442e-bc7b-bd65866dde3a" },
    accounts: { transactionType: "pay-in", merchantAccountCredited: 4.81958762886598 },
    manualSettlement: 1,
  },
};

test("parseManualSettlement detects TL Pay manualSettlement flag", () => {
  assert.equal(parseManualSettlement(MANUAL_SUCCESS_PAYLOAD), true);
  assert.equal(parseManualSettlement({ data: { manualSettlement: 0 } }), false);
  assert.equal(parseManualSettlement({ data: { trade: { event: { id: 4 } } } }), false);
});

test("isTyltManualSettlementSuccessWebhook requires success event + manual flag", () => {
  assert.equal(isTyltManualSettlementSuccessWebhook(MANUAL_SUCCESS_PAYLOAD), true);
  assert.equal(
    isTyltManualSettlementSuccessWebhook({
      data: { trade: { event: { id: 2 } }, manualSettlement: 1 },
    }),
    false
  );
  assert.equal(
    isTyltManualSettlementSuccessWebhook({
      data: { trade: { event: { id: 4 } }, manualSettlement: 0 },
    }),
    false
  );
  assert.equal(parseCrossRampEventId(MANUAL_SUCCESS_PAYLOAD), 4);
});

test("parseUpiPayinSettlementCurrency defaults to USDT for India UPI webhooks", () => {
  assert.equal(
    parseUpiPayinSettlementCurrency({
      data: {
        trade: { cryptoCurrency: { symbol: "USDT" } },
        accounts: { cryptoCurrencySymbol: "USDT", merchantAccountCredited: 4.82 },
      },
    }),
    "USDT"
  );
  assert.equal(parseUpiPayinSettlementCurrency({ data: { trade: { event: { id: 4 } } } }), "USDT");
});
