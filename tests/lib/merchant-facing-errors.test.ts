import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PayoutCreationError } from "../../services/domestic/bangladesh/payout.js";
import {
  merchantPaymentFlowErrorResponse,
  UpstreamProviderClientError,
} from "../../src/lib/merchant-facing-errors.js";

describe("merchantPaymentFlowErrorResponse", () => {
  it("maps EU insufficient USDC PayoutCreationError to insufficient_balance", () => {
    const err = new PayoutCreationError(
      "Insufficient USDC balance",
      "d1613b2a-54ee-43ba-9f43-c4c744cd6cab",
      null,
      "insufficient_balance"
    );
    const mapped = merchantPaymentFlowErrorResponse(err);
    assert.equal(mapped.status, 400);
    assert.equal(mapped.body.code, "insufficient_balance");
    assert.equal(mapped.body.transactionId, err.transactionId);
    assert.match(mapped.body.message ?? "", /USDC/);
  });

  it("maps missing USDC wallet PayoutCreationError to wallet_not_found", () => {
    const err = new PayoutCreationError(
      "Merchant USDC wallet not found",
      "tx-1",
      null,
      "wallet_not_found"
    );
    const mapped = merchantPaymentFlowErrorResponse(err);
    assert.equal(mapped.body.code, "wallet_not_found");
  });

  it("passes through UpstreamProviderClientError as HTTP 400 with partner message", () => {
    const err = new UpstreamProviderClientError(
      "internal log",
      "Invalid amount! INR amount can only be between 500.00 and 50000.00.",
      400
    );
    const mapped = merchantPaymentFlowErrorResponse(err);
    assert.equal(mapped.status, 400);
    assert.equal(mapped.body.code, "payment_provider_rejected");
    assert.equal(
      mapped.body.message,
      "Invalid amount! INR amount can only be between 500.00 and 50000.00."
    );
    assert.equal(mapped.logDetail, "internal log");
  });

  it("includes transactionId on UpstreamProviderClientError when provided", () => {
    const err = new UpstreamProviderClientError("log", "Invalid IBAN", 400, "tx-uuid", null);
    const mapped = merchantPaymentFlowErrorResponse(err);
    assert.equal(mapped.body.transactionId, "tx-uuid");
    assert.equal(mapped.body.code, "payment_provider_rejected");
  });

  it("maps PayOK Brazil country mismatch UpstreamProviderClientError", () => {
    const err = new UpstreamProviderClientError(
      'Payok create order failed: {"code":"FAIL","message":"merchant and country code mismatch!"}',
      "PayOK rejected Brazil (countryCode BR): your merchant ID is not enabled for Brazil/PIX.",
      400,
      "tx-br-1",
      null
    );
    const mapped = merchantPaymentFlowErrorResponse(err);
    assert.equal(mapped.status, 400);
    assert.equal(mapped.body.code, "payment_provider_rejected");
    assert.equal(mapped.body.transactionId, "tx-br-1");
    assert.match(mapped.body.message ?? "", /Brazil\/PIX/i);
  });

  it("maps missing Tekko static proxy to payment_unavailable", () => {
    const err = new Error("Tekko static egress proxy is not configured");
    err.name = "TekkoStaticProxyNotConfiguredError";
    const mapped = merchantPaymentFlowErrorResponse(err);
    assert.equal(mapped.status, 503);
    assert.equal(mapped.body.code, "payment_unavailable");
    assert.equal(mapped.logDetail, "TekkoStaticProxyNotConfiguredError");
  });
});
