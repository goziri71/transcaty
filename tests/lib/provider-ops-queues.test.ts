import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcileActionForProvider } from "../../src/lib/provider-ops-queues.js";

describe("provider-ops-queues", () => {
  it("maps PayOK pay-in to settle POST", () => {
    const r = reconcileActionForProvider({
      provider: "payok-bd-payin",
      type: "payin",
      transactionId: "11111111-1111-1111-1111-111111111111",
    });
    assert.equal(r.reconcileAction?.method, "POST");
    assert.equal(r.reconcileAction?.path, "/provider/payok/payin/reconcile");
  });

  it("maps Tekko PYUSD to settle POST", () => {
    const r = reconcileActionForProvider({
      provider: "tekko-pyusd-payin",
      type: "payin",
      transactionId: "11111111-1111-1111-1111-111111111111",
    });
    assert.equal(r.reconcileAction?.path, "/provider/tekko/pyusd/reconcile");
  });

  it("leaves unknown rails without auto-settle", () => {
    const r = reconcileActionForProvider({
      provider: "tylt-eur-payout",
      type: "payout",
      transactionId: "11111111-1111-1111-1111-111111111111",
    });
    assert.equal(r.reconcileAction, null);
    assert.equal(r.inspectAction?.method, "GET");
  });
});
