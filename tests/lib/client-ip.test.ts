import assert from "node:assert/strict";
import { test } from "node:test";
import type { FastifyRequest } from "fastify";
import { getTrustedClientIp } from "../../src/lib/client-ip.js";

function fakeRequest(opts: {
  socketRemoteAddress: string;
  headers?: Record<string, string>;
  ip: string;
}): FastifyRequest {
  return {
    socket: { remoteAddress: opts.socketRemoteAddress },
    headers: opts.headers ?? {},
    ip: opts.ip,
  } as unknown as FastifyRequest;
}

test("getTrustedClientIp prefers CF-Connecting-IP when the peer is a real Cloudflare edge IP", () => {
  const request = fakeRequest({
    socketRemoteAddress: "172.69.123.200",
    headers: { "cf-connecting-ip": "203.0.113.7" },
    ip: "172.69.123.200",
  });
  assert.equal(getTrustedClientIp(request), "203.0.113.7");
});

test("getTrustedClientIp falls back to request.ip when the peer is not a Cloudflare edge IP", () => {
  const request = fakeRequest({
    socketRemoteAddress: "203.0.113.5",
    headers: { "cf-connecting-ip": "9.9.9.9" },
    ip: "203.0.113.5",
  });
  assert.equal(getTrustedClientIp(request), "203.0.113.5");
});

test("getTrustedClientIp falls back to request.ip when CF-Connecting-IP is absent", () => {
  const request = fakeRequest({
    socketRemoteAddress: "172.69.123.200",
    headers: {},
    ip: "198.51.100.4",
  });
  assert.equal(getTrustedClientIp(request), "198.51.100.4");
});
