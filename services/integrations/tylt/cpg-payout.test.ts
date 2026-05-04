import assert from "node:assert/strict";
import test from "node:test";
import { extractCpgPayOutWebhookFields } from "./cpg-payout.js";

test("extract CPG payout webhook maps nested data envelope", () => {
  const parsed = {
    data: {
      merchantOrderId: "aaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      settledAmountDebited: "10.5",
      status: "completed",
      isFinal: true,
      isDebited: true,
    },
  };
  const f = extractCpgPayOutWebhookFields(parsed);
  assert.equal(f.merchantOrderId, "aaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(f.settledAmountDebited, "10.5");
  assert.equal(f.statusRaw, "completed");
  assert.equal(f.isFinal, true);
  assert.equal(f.isDebited, true);
  assert.equal(f.insufficientBalance, false);
});
