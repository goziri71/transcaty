import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isNgnWithdrawalSuccess,
  isNgnWithdrawalFailure,
} from "./ngn-payout.js";

describe("Tekko NGN payout status mapping", () => {
  it("treats completed variants as success", () => {
    assert.equal(isNgnWithdrawalSuccess("completed"), true);
    assert.equal(isNgnWithdrawalSuccess("success"), true);
    assert.equal(isNgnWithdrawalSuccess("successful"), true);
    assert.equal(isNgnWithdrawalSuccess("processing"), false);
  });

  it("treats failed variants as terminal failure", () => {
    assert.equal(isNgnWithdrawalFailure("failed"), true);
    assert.equal(isNgnWithdrawalFailure("reversed"), true);
    assert.equal(isNgnWithdrawalFailure("declined"), true);
    assert.equal(isNgnWithdrawalFailure("processing"), false);
  });
});
