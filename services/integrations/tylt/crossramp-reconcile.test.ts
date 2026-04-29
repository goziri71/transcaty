import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCrossRampRemoteToSyntheticWebhook } from "./crossramp-reconcile.js";
import { parseCrossRampEventId, parseCrossRampMerchantOrderId } from "./crossramp-payin.js";

const MID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("normalize maps webhook-shaped payload through when merchantOrderId matches", () => {
  const payload = {
    data: {
      trade: { event: { id: 4 } },
      accounts: { transactionType: "pay-in" },
      transaction: { merchantOrderId: MID, status: "Completed", settledAmountCredited: "10.5" },
    },
  };
  const out = normalizeCrossRampRemoteToSyntheticWebhook(payload, MID);
  assert.deepEqual(out, payload);
  assert.equal(parseCrossRampEventId(out), 4);
  assert.equal(parseCrossRampMerchantOrderId(out), MID);
});

test("normalize infers terminal complete from flat status string", () => {
  const json = { data: { merchantOrderId: MID, status: "completed", settledAmountCredited: "20" } };
  const out = normalizeCrossRampRemoteToSyntheticWebhook(json, MID);
  assert.ok(out && typeof out === "object");
  assert.equal(parseCrossRampEventId(out), 6);
});
