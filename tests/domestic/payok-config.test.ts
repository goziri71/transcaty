import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { resolvePayokMerchantIdForCountry } from "../../services/domestic/bangladesh/provider/config.js";

describe("resolvePayokMerchantIdForCountry", () => {
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    for (const key of Object.keys(saved)) {
      delete saved[key];
    }
  });

  function setEnv(key: string, value: string | undefined) {
    if (!(key in saved)) {
      saved[key] = process.env[key];
    }
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  it("returns default merchant id for Bangladesh", () => {
    assert.equal(resolvePayokMerchantIdForCountry("test", "BD", "mid-bd"), "mid-bd");
    assert.equal(resolvePayokMerchantIdForCountry("test", undefined, "mid-bd"), "mid-bd");
  });

  it("uses PAYOK_TEST_BR_MERCHANT_ID override for Brazil", () => {
    setEnv("PAYOK_TEST_BR_MERCHANT_ID", "mid-br");
    assert.equal(resolvePayokMerchantIdForCountry("test", "BR", "mid-default"), "mid-br");
  });

  it("falls back to default when BR override is unset", () => {
    setEnv("PAYOK_TEST_BR_MERCHANT_ID", undefined);
    assert.equal(resolvePayokMerchantIdForCountry("test", "br", "mid-default"), "mid-default");
  });
});
