import assert from "node:assert/strict";
import test from "node:test";
import { getTyltCredentials, getTyltCredentialsForProfile } from "./config.js";

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

test("eur_payin prefers TYLT_TEST_EUR_PAYIN_* over TYLT_TEST_PAYIN_*", () => {
  clearTyltEnv();
  process.env.TYLT_TEST_EUR_PAYIN_API_KEY = "eur-k";
  process.env.TYLT_TEST_EUR_PAYIN_API_SECRET = "eur-s";
  process.env.TYLT_TEST_PAYIN_API_KEY = "payin-k";
  process.env.TYLT_TEST_PAYIN_API_SECRET = "payin-s";
  try {
    const c = getTyltCredentialsForProfile("test", "eur_payin");
    assert.equal(c?.apiKey, "eur-k");
    assert.equal(c?.apiSecret, "eur-s");
  } finally {
    clearTyltEnv();
  }
});

test("india_payin prefers TYLT_TEST_INDIA_PAYIN_* over generic PAYIN", () => {
  clearTyltEnv();
  process.env.TYLT_TEST_INDIA_PAYIN_API_KEY = "in-k";
  process.env.TYLT_TEST_INDIA_PAYIN_API_SECRET = "in-s";
  process.env.TYLT_TEST_PAYIN_API_KEY = "payin-k";
  process.env.TYLT_TEST_PAYIN_API_SECRET = "payin-s";
  try {
    const c = getTyltCredentialsForProfile("test", "india_payin");
    assert.equal(c?.apiKey, "in-k");
  } finally {
    clearTyltEnv();
  }
});

test("eur_payout falls back to TYLT_TEST_PAYOUT_* when EUR_PAYOUT unset", () => {
  clearTyltEnv();
  process.env.TYLT_TEST_PAYOUT_API_KEY = "po-k";
  process.env.TYLT_TEST_PAYOUT_API_SECRET = "po-s";
  try {
    const c = getTyltCredentialsForProfile("test", "eur_payout");
    assert.equal(c?.apiKey, "po-k");
  } finally {
    clearTyltEnv();
  }
});
