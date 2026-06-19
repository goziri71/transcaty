import assert from "node:assert/strict";
import { test } from "node:test";
import {
  payoutTotalWalletDebit,
  transactionFeeReferenceId,
} from "../../src/lib/billing/apply-transaction-fee.js";
import { computeFeeFromSchedule } from "../../src/lib/billing/fee-calculator.js";
import { legacyPricingToSchedule } from "../../src/lib/billing/fee-rail.js";

test("payoutTotalWalletDebit includes platform fee", () => {
  assert.equal(payoutTotalWalletDebit("500.00", "10.00"), "510.00");
  assert.equal(payoutTotalWalletDebit("500.00", null), "500.00");
});

test("transactionFeeReferenceId is stable for idempotency", () => {
  assert.equal(transactionFeeReferenceId("tx-1", "payout"), "fee:tx-1:payout");
});

test("legacy pricing payout fee computes from feePercentagePayout", () => {
  const schedule = legacyPricingToSchedule(
    {
      billingMode: "percentage_only",
      feePercentagePayin: "3",
      feePercentagePayout: "2",
      feeMinPayin: "0",
      feeMaxPayin: null,
      feeMinPayout: "0",
      feeMaxPayout: null,
    },
    "payout"
  );
  const fee = computeFeeFromSchedule(schedule, "500.00", "payout");
  assert.ok(fee);
  assert.equal(fee!.feeAmount, "10.00");
});
