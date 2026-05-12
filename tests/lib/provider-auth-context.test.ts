/**
 * Unit tests for the API-key context-aware authorization gate
 * (P4 Auth Hardening).
 *
 * `canProviderActionContext` must:
 *   1. Allow JWT super_admin to perform every permission.
 *   2. Deny API-key sessions any permission in API_KEY_DENIED_PERMISSIONS,
 *      even when the role mapping would allow it.
 *   3. Allow API-key sessions read-only permissions.
 *   4. Default API-key role to 'support' (not 'super_admin').
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  API_KEY_DENIED_PERMISSIONS,
  canProviderActionContext,
  getProviderApiKeyRole,
  type ProviderContext,
} from "../../src/lib/provider-auth.js";

describe("provider auth context (API key downgrade)", () => {
  const ORIGINAL = process.env.PROVIDER_API_KEY_ROLE;

  beforeEach(() => {
    delete process.env.PROVIDER_API_KEY_ROLE;
  });

  afterEach(() => {
    if (ORIGINAL == null) delete process.env.PROVIDER_API_KEY_ROLE;
    else process.env.PROVIDER_API_KEY_ROLE = ORIGINAL;
  });

  it("default API-key role is 'support'", () => {
    assert.equal(getProviderApiKeyRole(), "support");
  });

  it("PROVIDER_API_KEY_ROLE='super_admin' is rejected (downgraded to 'support')", () => {
    process.env.PROVIDER_API_KEY_ROLE = "super_admin";
    assert.equal(getProviderApiKeyRole(), "support");
  });

  it("PROVIDER_API_KEY_ROLE='ops' is honored", () => {
    process.env.PROVIDER_API_KEY_ROLE = "ops";
    assert.equal(getProviderApiKeyRole(), "ops");
  });

  it("invalid PROVIDER_API_KEY_ROLE falls back to 'support'", () => {
    process.env.PROVIDER_API_KEY_ROLE = "definitely-not-a-role";
    assert.equal(getProviderApiKeyRole(), "support");
  });

  it("JWT super_admin can perform money mutations", () => {
    const ctx: ProviderContext = {
      providerUserId: "p1",
      email: "p@example.com",
      role: "super_admin",
      authType: "jwt",
    };
    assert.equal(canProviderActionContext(ctx, "wallet.adjust"), true);
    assert.equal(canProviderActionContext(ctx, "tx.status.write"), true);
    assert.equal(canProviderActionContext(ctx, "merchant.kyc.write"), true);
    assert.equal(canProviderActionContext(ctx, "approval.review"), true);
  });

  it("API-key session is denied money & admin mutations even if role allows them", () => {
    // Pretend an operator misconfigured PROVIDER_API_KEY_ROLE to a
    // privileged role; the deny list MUST still block money mutations.
    const ctx: ProviderContext = {
      role: "finance",
      authType: "api_key",
    };
    for (const perm of API_KEY_DENIED_PERMISSIONS) {
      assert.equal(
        canProviderActionContext(ctx, perm),
        false,
        `API-key should be denied ${perm}`
      );
    }
  });

  it("API-key session can still perform read-only permissions allowed by its role", () => {
    const ctx: ProviderContext = {
      role: "support",
      authType: "api_key",
    };
    assert.equal(canProviderActionContext(ctx, "merchant.read"), true);
    assert.equal(canProviderActionContext(ctx, "tx.read"), true);
    assert.equal(canProviderActionContext(ctx, "approval.read"), true);
  });

  it("denies money mutations even if API-key were minted as super_admin", () => {
    // Belt-and-braces: even if a stale build still set the API-key
    // session to super_admin, the deny list must catch it.
    const ctx: ProviderContext = {
      role: "super_admin",
      authType: "api_key",
    };
    assert.equal(canProviderActionContext(ctx, "wallet.adjust"), false);
    assert.equal(canProviderActionContext(ctx, "tx.status.write"), false);
  });
});
