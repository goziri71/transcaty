import assert from "node:assert/strict";
import test from "node:test";
import { accountBalanceCacheTtlMs, discoveryCacheTtlMs } from "./discovery-balance.js";

test("discovery cache TTL defaults to 60s when unset", () => {
  delete process.env.TYLT_DISCOVERY_CACHE_TTL_MS;
  assert.equal(discoveryCacheTtlMs(), 60_000);
});

test("account balance cache TTL defaults to 0 when unset", () => {
  delete process.env.TYLT_ACCOUNT_BALANCE_CACHE_TTL_MS;
  assert.equal(accountBalanceCacheTtlMs(), 0);
});
