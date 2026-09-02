import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  isSettlementComplete,
  isTerminalFailure,
} from "./pyusd-payin.js";
import { verifyTekkoWebhookSignature } from "./webhooks.js";

function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

describe("Tekko webhook signature", () => {
  it("accepts a valid HMAC within skew", () => {
    const secret = "whsec_test_secret";
    const timestamp = String(Date.now());
    const rawBody = '{"type":"customer.wallet.credited","data":{}}';
    const signature = signWebhook(secret, timestamp, rawBody);
    assert.equal(
      verifyTekkoWebhookSignature({ secret, timestamp, signature, rawBody }),
      true
    );
  });

  it("rejects wrong signature", () => {
    const secret = "whsec_test_secret";
    const timestamp = String(Date.now());
    const rawBody = "{}";
    assert.equal(
      verifyTekkoWebhookSignature({
        secret,
        timestamp,
        signature: "deadbeef",
        rawBody,
      }),
      false
    );
  });

  it("rejects stale timestamp", () => {
    const secret = "whsec_test_secret";
    const timestamp = String(Date.now() - 10 * 60 * 1000);
    const rawBody = "{}";
    const signature = signWebhook(secret, timestamp, rawBody);
    assert.equal(
      verifyTekkoWebhookSignature({ secret, timestamp, signature, rawBody }),
      false
    );
  });
});

describe("Tekko PYUSD settlement gating", () => {
  it("does not treat paid alone as settlement complete", () => {
    assert.equal(isSettlementComplete("paid", "awaiting_settlement"), false);
    assert.equal(isSettlementComplete("paid", null), false);
    assert.equal(isSettlementComplete("customer.wallet.credited", "pending"), false);
  });

  it("treats settlementStatus=settled as complete", () => {
    assert.equal(isSettlementComplete("paid", "settled"), true);
    assert.equal(isSettlementComplete("awaiting_payment", "settled"), true);
    assert.equal(isSettlementComplete(null, "settled"), true);
  });

  it("recognizes terminal failure statuses", () => {
    assert.equal(isTerminalFailure("expired"), true);
    assert.equal(isTerminalFailure("expired_underpaid"), true);
    assert.equal(isTerminalFailure("failed"), true);
    assert.equal(isTerminalFailure("paid"), false);
  });

  it("documents dual-path credit: webhook or poll only when settled", () => {
    // settleTekkoPyusdTransaction is idempotent via:
    // 1) UPDATE ... WHERE status = 'pending' (second call no-ops)
    // 2) existing ledger credit check by referenceId
    // Both customer.wallet.credited and master_wallet.credited must pass this gate.
    const unpaidCredited = isSettlementComplete("paid", "awaiting_settlement");
    const settledCredited = isSettlementComplete("paid", "settled");
    const masterSettled = isSettlementComplete("paid", "settled");
    assert.equal(unpaidCredited, false);
    assert.equal(settledCredited, true);
    assert.equal(masterSettled, true);
  });
});

describe("Tekko NGN settle gate (documented)", () => {
  it("credits NGN on credited only — not awaiting_payment", async () => {
    const { isNgnCollectionCredited, isNgnCollectionTerminalFailure } = await import("./ngn-collect.js");
    assert.equal(isNgnCollectionCredited("awaiting_payment"), false);
    assert.equal(isNgnCollectionCredited("credited"), true);
    assert.equal(isNgnCollectionTerminalFailure("expired"), true);
  });
});
