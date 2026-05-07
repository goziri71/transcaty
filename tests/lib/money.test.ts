import assert from "node:assert/strict";
import test from "node:test";
import {
  addAmount,
  assertNonNegative,
  assertPositive,
  cmpAmount,
  fromCents,
  gteAmount,
  subAmount,
  toCents,
} from "../../src/lib/money.js";

test("toCents parses common forms", () => {
  assert.equal(toCents("0"), 0n);
  assert.equal(toCents("0.00"), 0n);
  assert.equal(toCents("1"), 100n);
  assert.equal(toCents("1.0"), 100n);
  assert.equal(toCents("1.00"), 100n);
  assert.equal(toCents("1.5"), 150n);
  assert.equal(toCents("123.45"), 12345n);
  assert.equal(toCents("999999999999.99"), 99999999999999n);
});

test("toCents handles negatives", () => {
  assert.equal(toCents("-0.01"), -1n);
  assert.equal(toCents("-123.45"), -12345n);
});

test("toCents rejects malformed amounts", () => {
  for (const bad of ["", " ", "abc", "1.234", "1e5", "Infinity", "NaN", "1,000.00", ".5", "5."]) {
    assert.throws(() => toCents(bad), new RegExp(`Invalid money amount`));
  }
});

test("fromCents round-trips toCents", () => {
  for (const v of ["0.00", "0.01", "1.00", "12.34", "999999999999.99", "-1.99"]) {
    assert.equal(fromCents(toCents(v)), v);
  }
});

test("addAmount and subAmount preserve precision", () => {
  // The classic IEEE-754 trap: 0.1 + 0.2 !== 0.3 in floats.
  assert.equal(addAmount("0.10", "0.20"), "0.30");
  assert.equal(subAmount("100.00", "0.01"), "99.99");
  assert.equal(addAmount("99999999999.99", "0.01"), "100000000000.00");
});

test("cmpAmount orders correctly across decimals", () => {
  assert.equal(cmpAmount("1.00", "1.00"), 0);
  assert.equal(cmpAmount("1.00", "1.01"), -1);
  assert.equal(cmpAmount("1.01", "1.00"), 1);
  assert.equal(cmpAmount("9.99", "10.00"), -1);
});

test("gteAmount mirrors >=", () => {
  assert.equal(gteAmount("100.00", "100.00"), true);
  assert.equal(gteAmount("100.00", "99.99"), true);
  assert.equal(gteAmount("99.99", "100.00"), false);
});

test("assertPositive rejects zero, negatives, and malformed amounts", () => {
  assertPositive("0.01");
  assert.throws(() => assertPositive("0"));
  assert.throws(() => assertPositive("0.00"));
  assert.throws(() => assertPositive("-1.00"));
  assert.throws(() => assertPositive("notanumber"));
});

test("assertNonNegative allows zero, rejects negatives", () => {
  assertNonNegative("0");
  assertNonNegative("0.00");
  assertNonNegative("0.01");
  assert.throws(() => assertNonNegative("-0.01"));
});
