import assert from "node:assert/strict";
import test from "node:test";
import { extractTyltWebhookMerchantOrderId } from "./webhooks.js";

test("extract merchant order id from CrossRamp-shaped payload", () => {
  const id = extractTyltWebhookMerchantOrderId({
    data: { transaction: { merchantOrderId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" } },
  });
  assert.equal(id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
});

test("extract merchant order id from CPG nested data", () => {
  const id = extractTyltWebhookMerchantOrderId({
    data: { merchantOrderId: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee" },
  });
  assert.equal(id, "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee");
});
