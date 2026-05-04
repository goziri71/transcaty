import assert from "node:assert/strict";
import test from "node:test";
import { parseInternalTransferPairAllowlistJson } from "./internal-transfer.js";

test("pair allowlist parses directed UUID pairs", () => {
  const raw = JSON.stringify([
    ["550E8400-E29B-41D4-A716-446655440000", "660e8400-e29b-41d4-a716-446655440001"],
  ]);
  const set = parseInternalTransferPairAllowlistJson(raw);
  assert.equal(set.size, 1);
  assert.ok(set.has("550e8400-e29b-41d4-a716-446655440000|660e8400-e29b-41d4-a716-446655440001"));
});
