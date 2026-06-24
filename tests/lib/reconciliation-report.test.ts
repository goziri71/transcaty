import assert from "node:assert/strict";
import { test } from "node:test";
import { sumSuccessfulVolumeByCurrency } from "../../src/lib/reconciliation-report.js";
import type { ReconciliationRow } from "../../src/lib/reconciliation-report.js";

function row(partial: Partial<ReconciliationRow> & Pick<ReconciliationRow, "type" | "status" | "amount" | "currency">): ReconciliationRow {
  return {
    transactionId: "tx-1",
    paidAmount: null,
    rail: "bangladesh",
    railLabel: "Bangladesh pay-in",
    platformOrderId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    ...partial,
  };
}

test("sumSuccessfulVolumeByCurrency groups successful rows by currency", () => {
  const rows: ReconciliationRow[] = [
    row({ type: "payin", status: "success", amount: "100.00", currency: "BDT" }),
    row({ type: "payin", status: "success", amount: "50.00", currency: "USDC" }),
    row({ type: "payin", status: "success", amount: "25.00", currency: "BDT" }),
  ];
  assert.deepEqual(sumSuccessfulVolumeByCurrency(rows, "payin"), [
    { currency: "BDT", amount: "125.00" },
    { currency: "USDC", amount: "50.00" },
  ]);
});

test("sumSuccessfulVolumeByCurrency excludes failed and pending transactions", () => {
  const rows: ReconciliationRow[] = [
    row({ type: "payin", status: "success", amount: "100.00", currency: "USDC" }),
    row({ type: "payin", status: "failed", amount: "900.00", currency: "USDC" }),
    row({ type: "payin", status: "pending", amount: "200.00", currency: "EUR" }),
    row({ type: "payout", status: "failed", amount: "150.00", currency: "USDC" }),
    row({ type: "payout", status: "success", amount: "40.00", currency: "USDC" }),
  ];
  assert.deepEqual(sumSuccessfulVolumeByCurrency(rows, "payin"), [
    { currency: "USDC", amount: "100.00" },
  ]);
  assert.deepEqual(sumSuccessfulVolumeByCurrency(rows, "payout"), [
    { currency: "USDC", amount: "40.00" },
  ]);
});

test("sumSuccessfulVolumeByCurrency uses paidAmount for successful payins when set", () => {
  const rows: ReconciliationRow[] = [
    row({
      type: "payin",
      status: "success",
      amount: "100.00",
      paidAmount: "99.50",
      currency: "BDT",
    }),
  ];
  assert.deepEqual(sumSuccessfulVolumeByCurrency(rows, "payin"), [
    { currency: "BDT", amount: "99.50" },
  ]);
});
