import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  merchantPaymentFlowErrorResponse,
  UpstreamProviderClientError,
} from "../../src/lib/merchant-facing-errors.js";

describe("merchantPaymentFlowErrorResponse", () => {
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
});
