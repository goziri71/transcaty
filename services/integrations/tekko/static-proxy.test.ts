import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  getTekkoStaticProxyDispatcher,
  resetTekkoStaticProxyForTests,
  TekkoStaticProxyInvalidError,
  TekkoStaticProxyNotConfiguredError,
  validateTekkoStaticProxyUrl,
} from "./static-proxy.js";

const saved = {
  url: process.env.TEKKO_STATIC_PROXY_URL,
  enc: process.env.TEKKO_STATIC_PROXY_URL_ENC,
  qg: process.env.QUOTAGUARDSTATIC_URL,
  qgEnc: process.env.QUOTAGUARDSTATIC_URL_ENC,
  required: process.env.TEKKO_STATIC_PROXY_REQUIRED,
  nodeEnv: process.env.NODE_ENV,
};

afterEach(() => {
  resetTekkoStaticProxyForTests();
  for (const key of [
    "TEKKO_STATIC_PROXY_URL",
    "TEKKO_STATIC_PROXY_URL_ENC",
    "QUOTAGUARDSTATIC_URL",
    "QUOTAGUARDSTATIC_URL_ENC",
    "TEKKO_STATIC_PROXY_REQUIRED",
  ] as const) {
    delete process.env[key];
  }
  if (saved.url) process.env.TEKKO_STATIC_PROXY_URL = saved.url;
  if (saved.enc) process.env.TEKKO_STATIC_PROXY_URL_ENC = saved.enc;
  if (saved.qg) process.env.QUOTAGUARDSTATIC_URL = saved.qg;
  if (saved.qgEnc) process.env.QUOTAGUARDSTATIC_URL_ENC = saved.qgEnc;
  if (saved.required) process.env.TEKKO_STATIC_PROXY_REQUIRED = saved.required;
  process.env.NODE_ENV = saved.nodeEnv;
});

describe("tekko static proxy", () => {
  test("accepts QuotaGuard-style HTTP CONNECT URLs", () => {
    const u = validateTekkoStaticProxyUrl("http://user:pass@proxy.quotaguard.com:9293");
    assert.equal(u.hostname, "proxy.quotaguard.com");
    assert.equal(u.port, "9293");
  });

  test("rejects SOCKS URLs", () => {
    assert.throws(
      () => validateTekkoStaticProxyUrl("socks5://user:pass@proxy.quotaguard.com:1080"),
      TekkoStaticProxyInvalidError
    );
  });

  test("optional in non-production when unset", () => {
    process.env.NODE_ENV = "test";
    process.env.TEKKO_STATIC_PROXY_REQUIRED = "false";
    assert.equal(getTekkoStaticProxyDispatcher(), undefined);
  });

  test("fail closed when required and unset", () => {
    process.env.TEKKO_STATIC_PROXY_REQUIRED = "true";
    assert.throws(() => getTekkoStaticProxyDispatcher(), TekkoStaticProxyNotConfiguredError);
  });

  test("returns a dispatcher when URL is set", () => {
    process.env.TEKKO_STATIC_PROXY_REQUIRED = "false";
    process.env.TEKKO_STATIC_PROXY_URL = "http://user:pass@proxy.example.test:9293";
    const agent = getTekkoStaticProxyDispatcher();
    assert.ok(agent);
    assert.equal(getTekkoStaticProxyDispatcher(), agent);
  });
});
