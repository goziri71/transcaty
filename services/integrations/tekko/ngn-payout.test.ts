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
  tekkoWithdrawCreateAccepted,
  extractTekkoNgnWithdraw,
  extractTekkoNgnWithdrawFees,
  tekkoNgnProviderFeeLedgerRef,
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

describe("Tekko NGN withdraw create response parsing", () => {
  it("extracts reference from data.id when status/reference missing", () => {
    const w = extractTekkoNgnWithdraw({
      message: "Customer NGN payout initiated",
      data: { id: "plt_ngn_payout_6ca9b8e3-1d0e-42ec-9122-50eec1f3cd2d" },
    });
    assert.equal(w?.reference, "plt_ngn_payout_6ca9b8e3-1d0e-42ec-9122-50eec1f3cd2d");
  });

  it("treats 2xx initiated message as accepted without reference", () => {
    assert.equal(
      tekkoWithdrawCreateAccepted(200, { message: "Customer NGN payout initiated" }, null),
      true
    );
    assert.equal(
      tekkoWithdrawCreateAccepted(400, { message: "Customer NGN payout initiated" }, null),
      false
    );
    assert.equal(tekkoWithdrawCreateAccepted(200, { message: "Boom" }, null), false);
    assert.equal(tekkoWithdrawCreateAccepted(201, {}, "plt_ref"), true);
  });
});

describe("Tekko NGN withdraw fee extraction", () => {
  it("builds stable provider fee ledger reference", () => {
    assert.equal(tekkoNgnProviderFeeLedgerRef("tx-1"), "tekko_fee:tx-1");
  });

  it("reads explicit tekkoFee from payload", () => {
    const fees = extractTekkoNgnWithdrawFees({ data: { tekkoFee: "0.50", amount: "500" } }, "500");
    assert.equal(fees.tekkoFee, "0.50");
  });

  it("prefers totalDebited − amount over a smaller tekkoFee field", () => {
    const fees = extractTekkoNgnWithdrawFees(
      {
        data: {
          tekkoFee: "0.50",
          providerFee: "10.00",
          totalDebited: "510.50",
          amount: "500",
        },
      },
      "500.00"
    );
    assert.equal(fees.tekkoFee, "10.50");
    assert.equal(fees.totalDebited, "510.50");
    assert.equal(fees.providerFee, "10.00");
  });

  it("sums distinct tekkoFee + providerFee when totalDebited missing", () => {
    const fees = extractTekkoNgnWithdrawFees(
      { data: { tekkoFee: "0.50", providerFee: "10.00" } },
      "500.00"
    );
    assert.equal(fees.tekkoFee, "10.50");
  });

  it("derives fee from totalDebited − beneficiary amount", () => {
    const fees = extractTekkoNgnWithdrawFees(
      { data: { totalDebited: "500.50", amount: "500" } },
      "500.00"
    );
    assert.equal(fees.tekkoFee, "0.50");
    assert.equal(fees.totalDebited, "500.50");
  });

  it("falls back to providerFee when tekkoFee missing", () => {
    const fees = extractTekkoNgnWithdrawFees({ data: { providerFee: "1.25" } }, "100");
    assert.equal(fees.tekkoFee, "1.25");
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
