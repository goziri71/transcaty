import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  UpstreamProviderClientError,
} from "../../src/lib/merchant-facing-errors.js";
import { ProviderCircuitOpenError } from "../../src/lib/provider-circuit-breaker.js";
import {
  classifyTekkoPyusdError,
  tekkoOpsSnapshot,
} from "../../services/integrations/tekko/diagnostics.js";
import {
  TekkoStaticProxyNotConfiguredError,
  TekkoStaticProxyInvalidError,
} from "../../services/integrations/tekko/static-proxy.js";

describe("classifyTekkoPyusdError", () => {
  it("tags live-only gate", () => {
    const err = new UpstreamProviderClientError(
      "Tekko PYUSD is live-only (no sandbox credentials)",
      "PYUSD checkout is only available in the live environment",
      503
    );
    assert.equal(classifyTekkoPyusdError(err), "test_environment_rejected");
  });

  it("tags missing credentials", () => {
    assert.equal(
      classifyTekkoPyusdError(new Error("Tekko credentials not configured (TEKKO_LIVE_KEY_ID + private key)")),
      "tekko_credentials_missing"
    );
  });

  it("tags proxy / circuit", () => {
    assert.equal(classifyTekkoPyusdError(new TekkoStaticProxyNotConfiguredError()), "static_proxy_not_configured");
    assert.equal(classifyTekkoPyusdError(new TekkoStaticProxyInvalidError("socks")), "static_proxy_invalid");
    assert.equal(classifyTekkoPyusdError(new ProviderCircuitOpenError("tekko")), "circuit_open");
  });

  it("tekkoOpsSnapshot is secret-free shape", () => {
    const s = tekkoOpsSnapshot();
    assert.equal(typeof s.tekkoCredentialsLoaded, "boolean");
    assert.equal(typeof s.proxyConfigured, "boolean");
    assert.ok(!("privateKey" in s));
    assert.ok(!("webhookSecret" in s));
  });
});
