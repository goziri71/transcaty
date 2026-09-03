import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getPayokRailStartupSummary,
  isPayokCredentialsConfigured,
} from "../../src/lib/payok-rail-status.js";

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of [
    "BANGLADESH_PAYMENTS_DISABLED",
    "PAYOK_DEFAULT_ENV",
    "PAYOK_TEST_MERCHANT_ID",
    "PAYOK_TEST_MERCHANT_PRI_KEY",
    "PAYOK_TEST_BASE_URL",
    "PAYOK_TEST_PLATFORM_PUB_KEY",
  ]) {
    saved[key] = process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("payok-rail-status", () => {
  it("reports Bangladesh paused independently of Brazil credential probe", () => {
    delete process.env.BANGLADESH_PAYMENTS_DISABLED;
    delete process.env.PAYOK_TEST_MERCHANT_ID;

    const summary = getPayokRailStartupSummary();
    assert.equal(summary.bangladeshCollectPayout, "paused");
    assert.equal(summary.brazilCollectPayout, "credentials_missing");
  });

  it("detects configured test Brazil credentials", () => {
    process.env.PAYOK_DEFAULT_ENV = "test";
    process.env.PAYOK_TEST_MERCHANT_ID = "merchant-test-id";
    process.env.PAYOK_TEST_MERCHANT_PRI_KEY = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    process.env.PAYOK_TEST_BASE_URL = "https://api.payok.example";
    process.env.PAYOK_TEST_PLATFORM_PUB_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA";

    assert.equal(isPayokCredentialsConfigured("test", "BR"), true);
    assert.equal(getPayokRailStartupSummary().brazilCollectPayout, "ready");
  });
});
