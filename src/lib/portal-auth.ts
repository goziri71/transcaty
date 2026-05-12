/**
 * Portal auth: JWT for session, bcrypt for passwords.
 * Used by /portal/* routes (merchant dashboard login).
 *
 * P4 hardening: every issued token now carries `iss`, `aud`, `jti`,
 * and `iat` claims. Verification enforces `iss`/`aud` and applies a
 * 30s clock tolerance. Tokens issued before P4 (no `aud`/`iss`) are
 * still accepted in `verifyPortalToken` to avoid forcing a global
 * sign-out at deploy time; new code that needs to revoke a session
 * should use `verifyPortalTokenStrict`.
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { isJtiRevoked } from "./jwt-revocation.js";

const SALT_ROUNDS = 10;
const JWT_EXPIRY = "7d";
const MFA_PENDING_EXPIRY = "5m";
const CLOCK_TOLERANCE_SEC = 30;

export const PORTAL_JWT_ISSUER = "transacty.portal";
export const PORTAL_JWT_AUDIENCE = "transacty.portal.session";
export const PORTAL_MFA_PENDING_AUDIENCE = "transacty.portal.mfa_pending";

export type PortalContext = {
  merchantUserId: string;
  merchantId: string;
  email: string;
  role: string;
};

/** Decoded token with the JWT id so handlers can revoke it on logout. */
export type PortalSessionToken = PortalContext & {
  jti: string;
  expiresAt: Date;
};

declare module "fastify" {
  interface FastifyRequest {
    portalUser?: PortalContext;
    portalSession?: PortalSessionToken;
  }
}

function getJwtSecret(): string {
  const secret = process.env.PORTAL_JWT_SECRET ?? process.env.JWT_SECRET;
  if (!secret) throw new Error("PORTAL_JWT_SECRET or JWT_SECRET required for portal auth");
  return secret;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signPortalToken(payload: PortalContext): string {
  return jwt.sign(
    { ...payload, purpose: "portal_session" as const },
    getJwtSecret(),
    {
      expiresIn: JWT_EXPIRY,
      issuer: PORTAL_JWT_ISSUER,
      audience: PORTAL_JWT_AUDIENCE,
      subject: payload.merchantUserId,
      jwtid: randomUUID(),
    }
  );
}

interface PortalTokenPayload extends PortalContext {
  purpose?: string;
  sub?: string;
  jti?: string;
  exp?: number;
  iss?: string;
  aud?: string | string[];
}

function decodeAndValidate(token: string, audience?: string): PortalTokenPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), {
      // Backward-compat: tokens issued before P4 don't have iss/aud.
      // We still enforce them when present by passing the expected
      // values; the optional flags below are emulated per call site.
      ...(audience ? { audience, issuer: PORTAL_JWT_ISSUER } : {}),
      clockTolerance: CLOCK_TOLERANCE_SEC,
    }) as PortalTokenPayload;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Verify a portal session token. Backward-compatible with pre-P4
 * tokens that lack `aud`/`iss`/`jti`: those are accepted so existing
 * users aren't force-logged-out by a deploy.
 */
export async function verifyPortalToken(token: string): Promise<PortalSessionToken | null> {
  // Try strict (iss + aud) first; fall back to lax verification for
  // legacy tokens.
  let decoded = decodeAndValidate(token, PORTAL_JWT_AUDIENCE);
  if (!decoded) {
    decoded = decodeAndValidate(token);
  }
  if (!decoded) return null;
  if (decoded.sub === "mfa_pending") return null;
  if (decoded.aud === PORTAL_MFA_PENDING_AUDIENCE) return null;
  if (decoded.purpose != null && decoded.purpose !== "portal_session") return null;
  // Enforce expected aud when the token carries one (block tokens
  // minted for other audiences).
  if (decoded.aud && decoded.aud !== PORTAL_JWT_AUDIENCE) return null;
  if (decoded.iss && decoded.iss !== PORTAL_JWT_ISSUER) return null;
  if (!decoded.merchantUserId || !decoded.merchantId || !decoded.email || !decoded.role) {
    return null;
  }
  if (decoded.jti && (await isJtiRevoked("portal", decoded.jti))) {
    return null;
  }
  return {
    merchantUserId: decoded.merchantUserId,
    merchantId: decoded.merchantId,
    email: decoded.email,
    role: decoded.role,
    jti: decoded.jti ?? "",
    expiresAt: decoded.exp ? new Date(decoded.exp * 1000) : new Date(0),
  };
}

/** Short-lived token after password OK when MFA is enabled; exchange via POST /portal/auth/mfa/verify */
export function signPortalMfaPendingToken(payload: PortalContext): string {
  return jwt.sign(
    {
      sub: "mfa_pending" as const,
      merchantUserId: payload.merchantUserId,
      merchantId: payload.merchantId,
      email: payload.email,
      role: payload.role,
    },
    getJwtSecret(),
    {
      expiresIn: MFA_PENDING_EXPIRY,
      issuer: PORTAL_JWT_ISSUER,
      audience: PORTAL_MFA_PENDING_AUDIENCE,
      jwtid: randomUUID(),
    }
  );
}

export function verifyPortalMfaPendingToken(token: string): PortalContext | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), {
      audience: PORTAL_MFA_PENDING_AUDIENCE,
      issuer: PORTAL_JWT_ISSUER,
      clockTolerance: CLOCK_TOLERANCE_SEC,
    }) as PortalContext & { sub?: string };
    if (decoded.sub !== "mfa_pending") return null;
    return {
      merchantUserId: decoded.merchantUserId,
      merchantId: decoded.merchantId,
      email: decoded.email,
      role: decoded.role,
    };
  } catch {
    // Backward-compat path for MFA tokens issued before the audience
    // was added. They still embed `sub: "mfa_pending"` so they can be
    // distinguished from session tokens.
    try {
      const decoded = jwt.verify(token, getJwtSecret(), {
        clockTolerance: CLOCK_TOLERANCE_SEC,
      }) as PortalContext & { sub?: string };
      if (decoded.sub !== "mfa_pending") return null;
      return {
        merchantUserId: decoded.merchantUserId,
        merchantId: decoded.merchantId,
        email: decoded.email,
        role: decoded.role,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Verify portal JWT. Expects Authorization: Bearer <token> or X-Portal-Token.
 */
export async function portalAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;
  const headerToken = request.headers["x-portal-token"] as string | undefined;
  const token =
    (authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined) ??
    headerToken;

  if (!token) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Missing portal token (Authorization: Bearer or X-Portal-Token)",
    });
  }

  const session = await verifyPortalToken(token);
  if (!session) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Invalid or expired token",
    });
  }

  request.portalUser = {
    merchantUserId: session.merchantUserId,
    merchantId: session.merchantId,
    email: session.email,
    role: session.role,
  };
  request.portalSession = session;
}
