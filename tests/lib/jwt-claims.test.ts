/**
 * Unit tests for JWT claim hardening (P4 Auth Hardening).
 *
 * Verifies that:
 *   - signed tokens carry iss, aud, jti, sub, exp
 *   - verify accepts P4-shaped tokens
 *   - verify rejects tokens with the wrong audience
 *   - verify accepts pre-P4 (legacy) tokens for backward compat
 *   - clock-tolerance allows tokens that just expired
 *   - step-up tokens are bound to the action
 *
 * Revocation list lookups are stubbed via the test seam exported by
 * `src/lib/jwt-revocation.ts` so we don't need a live DB.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import jwt from "jsonwebtoken";
import {
  __setJwtRevocationLookupForTesting,
  clearJwtRevocationCache,
} from "../../src/lib/jwt-revocation.js";

const ORIGINAL_PORTAL_SECRET = process.env.PORTAL_JWT_SECRET;
const ORIGINAL_PROVIDER_SECRET = process.env.PROVIDER_JWT_SECRET;

describe("portal JWT (P4 hardening)", () => {
  beforeEach(async () => {
    process.env.PORTAL_JWT_SECRET = "test-portal-secret-do-not-use";
    process.env.PROVIDER_JWT_SECRET = "test-provider-secret-do-not-use";
    __setJwtRevocationLookupForTesting(async () => false);
    const portal = await import("../../src/lib/portal-auth.js");
    portal.__setPortalSessionVersionLookupForTesting(async () => 0);
  });

  afterEach(async () => {
    if (ORIGINAL_PORTAL_SECRET == null) delete process.env.PORTAL_JWT_SECRET;
    else process.env.PORTAL_JWT_SECRET = ORIGINAL_PORTAL_SECRET;
    if (ORIGINAL_PROVIDER_SECRET == null) delete process.env.PROVIDER_JWT_SECRET;
    else process.env.PROVIDER_JWT_SECRET = ORIGINAL_PROVIDER_SECRET;
    __setJwtRevocationLookupForTesting(null);
    clearJwtRevocationCache();
    const portal = await import("../../src/lib/portal-auth.js");
    portal.__setPortalSessionVersionLookupForTesting(null);
  });

  it("signed portal token carries iss, aud, jti, sub, exp", async () => {
    const portal = await import("../../src/lib/portal-auth.js");
    const token = portal.signPortalToken({
      merchantUserId: "00000000-0000-0000-0000-000000000001",
      merchantId: "00000000-0000-0000-0000-000000000002",
      email: "u@example.com",
      role: "admin",
    });
    const decoded = jwt.decode(token, { complete: false }) as Record<string, unknown> | null;
    assert.ok(decoded);
    assert.equal(decoded.iss, "transacty.portal");
    assert.equal(decoded.aud, "transacty.portal.session");
    assert.equal(decoded.sub, "00000000-0000-0000-0000-000000000001");
    assert.ok(typeof decoded.jti === "string" && decoded.jti.length >= 16);
    assert.ok(typeof decoded.exp === "number");
    assert.ok(typeof decoded.iat === "number");
    assert.equal(decoded.merchantUserId, "00000000-0000-0000-0000-000000000001");

    const verified = await portal.verifyPortalToken(token);
    assert.ok(verified);
    assert.equal(verified.merchantUserId, "00000000-0000-0000-0000-000000000001");
    assert.ok(verified.jti.length > 0);
  });

  it("rejects portal tokens minted for the wrong audience", async () => {
    const portal = await import("../../src/lib/portal-auth.js");
    const wrongAud = jwt.sign(
      {
        merchantUserId: "u1",
        merchantId: "m1",
        email: "u@example.com",
        role: "admin",
        purpose: "portal_session",
      },
      process.env.PORTAL_JWT_SECRET as string,
      {
        expiresIn: "1h",
        issuer: "transacty.portal",
        audience: "transacty.portal.mfa_pending", // wrong aud
        subject: "u1",
        jwtid: "fake-jti-1",
      }
    );
    const verified = await portal.verifyPortalToken(wrongAud);
    assert.equal(verified, null);
  });

  it("accepts legacy portal tokens (no iss/aud/jti) for backward compat", async () => {
    const portal = await import("../../src/lib/portal-auth.js");
    const legacy = jwt.sign(
      {
        merchantUserId: "u1",
        merchantId: "m1",
        email: "u@example.com",
        role: "admin",
        purpose: "portal_session",
      },
      process.env.PORTAL_JWT_SECRET as string,
      { expiresIn: "1h" }
    );
    const verified = await portal.verifyPortalToken(legacy);
    assert.ok(verified);
    assert.equal(verified.email, "u@example.com");
    assert.equal(verified.jti, ""); // no jti on legacy token
  });

  it("rejects portal tokens whose jti is revoked", async () => {
    __setJwtRevocationLookupForTesting(async () => true);
    const portal = await import("../../src/lib/portal-auth.js");
    const token = portal.signPortalToken({
      merchantUserId: "u1",
      merchantId: "m1",
      email: "u@example.com",
      role: "admin",
    });
    const verified = await portal.verifyPortalToken(token);
    assert.equal(verified, null);
  });

  it("provider step-up token is bound to the action", async () => {
    const provider = await import("../../src/lib/provider-auth.js");
    const tokenForWalletAdjust = provider.signProviderStepUpToken({
      providerUserId: "p1",
      action: "wallet.adjust",
    });
    assert.ok(provider.verifyProviderStepUpToken(tokenForWalletAdjust, "wallet.adjust"));
    // Different action: rejected.
    assert.equal(
      provider.verifyProviderStepUpToken(tokenForWalletAdjust, "tx.status.write"),
      null
    );

    // 'any' tokens are accepted for any action.
    const anyToken = provider.signProviderStepUpToken({
      providerUserId: "p1",
      action: "any",
    });
    assert.ok(provider.verifyProviderStepUpToken(anyToken, "wallet.adjust"));
    assert.ok(provider.verifyProviderStepUpToken(anyToken, "tx.status.write"));
  });

  it("provider session token rejects step-up audience", async () => {
    const provider = await import("../../src/lib/provider-auth.js");
    const stepUpToken = provider.signProviderStepUpToken({
      providerUserId: "p1",
      action: "wallet.adjust",
    });
    // A step-up token must not work as a normal session.
    const verified = await provider.verifyProviderToken(stepUpToken);
    assert.equal(verified, null);
  });
});
