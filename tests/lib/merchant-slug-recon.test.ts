import assert from "node:assert/strict";
import { test } from "node:test";
import { slugifyMerchantName } from "../../src/lib/merchant-slug.js";
import { reconciliationReportToCsv } from "../../src/lib/reconciliation-report.js";

test("slugifyMerchantName produces readable slug", () => {
  assert.equal(slugifyMerchantName("Acme Payments Ltd."), "acme-payments-ltd");
  assert.equal(slugifyMerchantName("  Hello   World  "), "hello-world");
});

test("reconciliationReportToCsv includes header and row", () => {
  const csv = reconciliationReportToCsv({
    merchantId: "m1",
    environment: "test",
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-31T23:59:59.999Z",
    summary: {
      totalTransactions: 1,
      payinCount: 1,
      payoutCount: 0,
      successCount: 1,
      failedCount: 0,
      pendingCount: 0,
      payinVolume: "100.00",
      payoutVolume: "0.00",
    },
    rows: [
      {
        transactionId: "tx-1",
        type: "payin",
        status: "success",
        amount: "100.00",
        paidAmount: "100.00",
        currency: "BDT",
        rail: "bangladesh",
        railLabel: "Bangladesh pay-in",
        platformOrderId: "po-1",
        createdAt: "2026-01-15T10:00:00.000Z",
        completedAt: "2026-01-15T10:05:00.000Z",
      },
    ],
  });
  assert.ok(csv.includes("transaction_id"));
  assert.ok(csv.includes("tx-1"));
});
