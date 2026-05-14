import assert from "node:assert/strict";
import test from "node:test";
import { getTyltCredentials } from "./config.js";

function clearTyltEnv() {
  for (const k of Object.keys(process.env)) {
    if (
      k.startsWith("TYLT_") &&
      !k.includes("DISCOVERY") &&
      !k.includes("ACCOUNT_BALANCE") &&
      !k.includes("INTERNAL_TRANSFER") &&
      !k.includes("ALLOW_KYC")
    ) {
      delete process.env[k];
    }
  }
}

test("payin prefers TYLT_TEST_PAYIN_* over TYLT_TEST_*", () => {
  clearTyltEnv();
  process.env.TYLT_TEST_PAYIN_API_KEY = "payin-k";
  process.env.TYLT_TEST_PAYIN_API_SECRET = "payin-s";
  process.env.TYLT_TEST_API_KEY = "legacy-k";
  process.env.TYLT_TEST_API_SECRET = "legacy-s";
  try {
    const c = getTyltCredentials("test", "payin");
    assert.equal(c?.apiKey, "payin-k");
    assert.equal(c?.apiSecret, "payin-s");
  } finally {
    clearTyltEnv();
  }
});

test("payout uses TYLT_TEST_PAYOUT_* when set", () => {
  clearTyltEnv();
  process.env.TYLT_TEST_PAYOUT_API_KEY = "po-k";
  process.env.TYLT_TEST_PAYOUT_API_SECRET = "po-s";
  try {
    const c = getTyltCredentials("test", "payout");
    assert.equal(c?.apiKey, "po-k");
  } finally {
    clearTyltEnv();
  }
});

test("payout falls back to TYLT_TEST_* when PAYOUT unset", () => {
  clearTyltEnv();
  process.env.TYLT_TEST_API_KEY = "leg-k";
  process.env.TYLT_TEST_API_SECRET = "leg-s";
  try {
    const c = getTyltCredentials("test", "payout");
    assert.equal(c?.apiKey, "leg-k");
  } finally {
    clearTyltEnv();
  }
});
