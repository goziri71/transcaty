import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isNgnWithdrawalSuccess,
  isNgnWithdrawalFailure,
  tekkoCustomerNgnWithdrawPath,
  tekkoCustomerNgnWithdrawPollPaths,
  tekkoNgnWithdrawErrorKind,
  tekkoDetailIndicatesVaRequired,
  tekkoDetailIndicatesInsufficientCustomerNgn,
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

describe("Tekko NGN customer withdraw paths", () => {
  it("builds customer withdraw path (not master-wallet)", () => {
    assert.equal(tekkoCustomerNgnWithdrawPath(29), "/customers/29/ng/withdraw");
    assert.equal(tekkoCustomerNgnWithdrawPath(29).includes("master-wallet"), false);
  });

  it("builds customer status poll paths", () => {
    const paths = tekkoCustomerNgnWithdrawPollPaths(29, "ref-abc");
    assert.deepEqual(paths, [
      "/customers/29/ng/withdraw/ref-abc/status",
      "/customers/29/ng/withdrawals/ref-abc",
    ]);
  });
});

describe("Tekko NGN withdraw error kind", () => {
  it("classifies partner KYB / merchant BVN as partner_kyb", () => {
    assert.equal(
      tekkoNgnWithdrawErrorKind(
        "Merchant BVN verification required before NGN swaps. Complete KYB → BVN in the dashboard.",
        "MERCHANT_BVN_REQUIRED"
      ),
      "partner_kyb"
    );
  });

  it("classifies customer BVN separately", () => {
    assert.equal(
      tekkoNgnWithdrawErrorKind("BVN verification required before NGN payouts", "BVN_VERIFICATION_REQUIRED"),
      "customer_bvn"
    );
  });

  it("classifies VA required", () => {
    assert.equal(tekkoDetailIndicatesVaRequired("x", "END_USER_BRAILS_VA_REQUIRED"), true);
    assert.equal(
      tekkoNgnWithdrawErrorKind("End user virtual account required", "END_USER_BRAILS_VA_REQUIRED"),
      "va_required"
    );
  });

  it("classifies insufficient customer NGN", () => {
    assert.equal(tekkoDetailIndicatesInsufficientCustomerNgn("x", "INSUFFICIENT_NGN_BALANCE"), true);
    assert.equal(
      tekkoNgnWithdrawErrorKind("Insufficient NGN balance on customer wallet", "INSUFFICIENT_NGN_BALANCE"),
      "insufficient"
    );
  });
});
