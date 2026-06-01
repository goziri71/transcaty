import assert from "node:assert/strict";
import test from "node:test";
import { classifyCrossRampDecision, DISPUTE_EVENT_IDS, FAILURE_EVENT_IDS } from "./crossramp-payin.js";

test("event 5 is non-terminal dispute, not failure", () => {
  assert.ok(DISPUTE_EVENT_IDS.has(5));
  assert.equal(classifyCrossRampDecision(5), "non_terminal");
  assert.ok(!FAILURE_EVENT_IDS.has(5));
});

test("event 9 remains terminal failure", () => {
  assert.equal(classifyCrossRampDecision(9), "failed");
});

test("events 4 and 6 are success", () => {
  assert.equal(classifyCrossRampDecision(4, "Completed"), "success");
  assert.equal(classifyCrossRampDecision(6, "Completed"), "success");
});
