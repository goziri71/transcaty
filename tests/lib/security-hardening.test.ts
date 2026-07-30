/**
 * Unit tests for HTTPS webhook URLs and portal RBAC helpers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { assertHttpsWebhookUrl } from "../../src/lib/https-url.js";
import {
  portalRoleCanManageCredentials,
  portalRoleCanMoveMoney,
} from "../../src/lib/portal-roles.js";

test("assertHttpsWebhookUrl accepts https and null clear", () => {
  assert.equal(assertHttpsWebhookUrl(null).ok, true);
  assert.equal(assertHttpsWebhookUrl("").ok, true);
  const ok = assertHttpsWebhookUrl("https://example.com/hooks");
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.url, "https://example.com/hooks");
});

test("assertHttpsWebhookUrl rejects http in production-like default", () => {
  const prev = process.env.ALLOW_HTTP_WEBHOOKS;
  const prevNode = process.env.NODE_ENV;
  process.env.ALLOW_HTTP_WEBHOOKS = undefined;
  process.env.NODE_ENV = "test";
  const bad = assertHttpsWebhookUrl("http://example.com/hooks");
  assert.equal(bad.ok, false);
  if (prev === undefined) delete process.env.ALLOW_HTTP_WEBHOOKS;
  else process.env.ALLOW_HTTP_WEBHOOKS = prev;
  if (prevNode === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevNode;
});

test("portal roles: money vs credentials", () => {
  assert.equal(portalRoleCanMoveMoney("admin"), true);
  assert.equal(portalRoleCanMoveMoney("finance"), true);
  assert.equal(portalRoleCanMoveMoney("viewer"), false);
  assert.equal(portalRoleCanManageCredentials("admin"), true);
  assert.equal(portalRoleCanManageCredentials("finance"), false);
  assert.equal(portalRoleCanManageCredentials("viewer"), false);
});
