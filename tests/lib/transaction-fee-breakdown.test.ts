import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatTransactionFeeBreakdown,
  resolveTransactionFeeBaseAmount,
  feeSummaryFromBreakdown,
  feeBreakdownToWebhookFields,
} from "../../src/lib/billing/transaction-fee-breakdown.js";

test("formatTransactionFeeBreakdown payin pending shows estimated net", () => {
  const breakdown = formatTransactionFeeBreakdown({
    type: "payin",
    status: "pending",
    amount: "1000.00",
    currency: "BDT",
    platformFee: "15.00",
    feeStatus: "estimated",
  });
  assert.equal(breakdown.fees.platformFee, "15.00");
  assert.equal(breakdown.fees.feeType, "payin");
  assert.equal(breakdown.fees.feeStatus, "estimated");
  assert.equal(breakdown.netAmount, "985.00");
  assert.equal(breakdown.totalWalletDebit, null);
});

test("formatTransactionFeeBreakdown payout uses EUR debit amount from metadata", () => {
  const breakdown = formatTransactionFeeBreakdown({
    type: "payout",
    status: "pending",
    amount: "100.00",
    currency: "USDC",
    platformFee: "2.00",
    feeStatus: "estimated",
    provider: "tylt-eur-payout",
    metadata: JSON.stringify({ debitAmount: "95.50", fiatAmount: "100.00" }),
  });
  assert.equal(breakdown.totalWalletDebit, "97.50");
});

test("resolveTransactionFeeBaseAmount prefers paidAmount for payin", () => {
  assert.equal(
    resolveTransactionFeeBaseAmount({
      type: "payin",
      amount: "1000.00",
      paidAmount: "998.00",
    }),
    "998.00"
  );
});

test("feeSummaryFromBreakdown omits currency when list already has it", () => {
  const summary = feeSummaryFromBreakdown(
    formatTransactionFeeBreakdown({
      type: "payout",
      status: "pending",
      amount: "500.00",
      currency: "BDT",
      platformFee: "10.00",
      feeStatus: "estimated",
    })
  );
  assert.equal(summary.fees?.platformFee, "10.00");
  assert.equal(summary.totalWalletDebit, "510.00");
  assert.equal("currency" in summary, false);
});

test("feeBreakdownToWebhookFields includes net and debit fields", () => {
  const fields = feeBreakdownToWebhookFields(
    formatTransactionFeeBreakdown({
      type: "payin",
      status: "success",
      amount: "100.00",
      paidAmount: "100.00",
      currency: "BDT",
      platformFee: "1.50",
      feeStatus: "applied",
    })
  );
  assert.equal(fields.currency, "BDT");
  assert.equal(fields.netAmount, "98.50");
  assert.equal(fields.totalWalletDebit, undefined);
});
