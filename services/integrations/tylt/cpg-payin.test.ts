import assert from "node:assert/strict";
import test from "node:test";
import { extractCpgPayInWebhookFields } from "./cpg-payin.js";

test("extract CPG pay-in webhook maps nested data envelope", () => {
  const parsed = {
    type: "pay-in",
    data: {
      merchantOrderId: "aaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      settledAmountCredited: "99.12",
      status: "Completed",
      isFinal: true,
      isCredited: true,
    },
  };
  const f = extractCpgPayInWebhookFields(parsed);
  assert.equal(f.merchantOrderId, "aaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(f.settledAmountCredited, "99.12");
  assert.equal(f.statusRaw, "Completed");
});
