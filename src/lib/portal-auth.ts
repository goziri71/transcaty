/**
 * Portal auth: JWT for session, bcrypt for passwords.
 * Used by /portal/* routes (merchant dashboard login).
 *
 * P4 hardening: every issued token now carries `iss`, `aud`, `jti`,
 * and `iat` claims. Verification enforces `iss`/`aud` and applies a
 * 30s clock tolerance. Tokens issued before P4 (no `aud`/`iss`) are
 * still accepted in `verifyPortalToken` to avoid forcing a global
 * sign-out at deploy time.
 *
 * Security updates: shorter default session TTL, session_version for
 * revoke-all, optional PORTAL_MFA_REQUIRED gate, and step-up MFA tokens
 * for high-privilege mutations.
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { eq, sql } from "drizzle-orm";
import { isJtiRevoked } from "./jwt-revocation.js";
import { db } from "../db/index.js";
import { merchantUsers } from "../db/schema/index.js";

const SALT_ROUNDS = 10;
/** Default shortened from 7d — override with PORTAL_JWT_EXPIRES_IN (e.g. 12h, 8h). */
const DEFAULT_JWT_EXPIRY = "12h";
const MFA_PENDING_EXPIRY = "5m";
const STEP_UP_EXPIRY = "5m";
const CLOCK_TOLERANCE_SEC = 30;
const SESSION_VERSION_CACHE_TTL_MS = 5_000;

export const PORTAL_JWT_ISSUER = "transacty.portal";
export const PORTAL_JWT_AUDIENCE = "transacty.portal.session";
export const PORTAL_MFA_PENDING_AUDIENCE = "transacty.portal.mfa_pending";
export const PORTAL_STEP_UP_AUDIENCE = "transacty.portal.step_up";

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
  sessionVersion: number;
};

export type PortalStepUpAction =
  | "api_keys.write"
  | "webhook.write"
  | "money.write"
  | "audit.export";

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

function getPortalJwtExpiry(): jwt.SignOptions["expiresIn"] {
  const raw = process.env.PORTAL_JWT_EXPIRES_IN?.trim();
  return (raw && raw.length > 0 ? raw : DEFAULT_JWT_EXPIRY) as jwt.SignOptions["expiresIn"];
}

export function isPortalMfaRequired(): boolean {
  const v = process.env.PORTAL_MFA_REQUIRED?.trim().toLowerCase();
  return v === "true" || v === "1";
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signPortalToken(
  payload: PortalContext & { sessionVersion?: number }
): string {
  const sv = payload.sessionVersion ?? 0;
  return jwt.sign(
    {
      merchantUserId: payload.merchantUserId,
      merchantId: payload.merchantId,
      email: payload.email,
      role: payload.role,
      sv,
      purpose: "portal_session" as const,
    },
    getJwtSecret(),
    {
      expiresIn: getPortalJwtExpiry(),
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
  sv?: number;
  sessionVersion?: number;
}

function decodeAndValidate(token: string, audience?: string): PortalTokenPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), {
      ...(audience ? { audience, issuer: PORTAL_JWT_ISSUER } : {}),
      clockTolerance: CLOCK_TOLERANCE_SEC,
    }) as PortalTokenPayload;
    return decoded;
  } catch {
    return null;
  }
}

const sessionVersionCache = new Map<string, { version: number; expiresAt: number }>();

/** Test seam: stub session-version lookup without a live DB. */
type SessionVersionLookupFn = (userId: string) => Promise<number | null>;
let sessionVersionLookupOverride: SessionVersionLookupFn | null = null;
export function __setPortalSessionVersionLookupForTesting(
  fn: SessionVersionLookupFn | null
): void {
  sessionVersionLookupOverride = fn;
  sessionVersionCache.clear();
}

export function invalidatePortalSessionVersionCache(userId: string): void {
  sessionVersionCache.delete(userId);
}

async function loadSessionVersion(userId: string): Promise<number | null> {
  if (sessionVersionLookupOverride) {
    return sessionVersionLookupOverride(userId);
  }
  const now = Date.now();
  const cached = sessionVersionCache.get(userId);
  if (cached && cached.expiresAt > now) return cached.version;
  const [row] = await db
    .select({ sessionVersion: merchantUsers.sessionVersion })
    .from(merchantUsers)
    .where(eq(merchantUsers.id, userId))
    .limit(1);
  if (!row) return null;
  sessionVersionCache.set(userId, {
    version: row.sessionVersion,
    expiresAt: now + SESSION_VERSION_CACHE_TTL_MS,
  });
  return row.sessionVersion;
}

/** Bump session epoch so all existing JWTs for this user fail verification. */
export async function bumpPortalSessionVersion(userId: string): Promise<number> {
  const [row] = await db
    .update(merchantUsers)
    .set({
      sessionVersion: sql`${merchantUsers.sessionVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(merchantUsers.id, userId))
    .returning({ sessionVersion: merchantUsers.sessionVersion });
  invalidatePortalSessionVersionCache(userId);
  return row?.sessionVersion ?? 0;
}

/**
 * Verify a portal session token. Backward-compatible with pre-P4
 * tokens that lack `aud`/`iss`/`jti`: those are accepted so existing
 * users aren't force-logged-out by a deploy.
 */
export async function verifyPortalToken(token: string): Promise<PortalSessionToken | null> {
  let decoded = decodeAndValidate(token, PORTAL_JWT_AUDIENCE);
  if (!decoded) {
    decoded = decodeAndValidate(token);
  }
  if (!decoded) return null;
  if (decoded.sub === "mfa_pending") return null;
  if (decoded.aud === PORTAL_MFA_PENDING_AUDIENCE) return null;
  if (decoded.aud === PORTAL_STEP_UP_AUDIENCE) return null;
  if (decoded.purpose != null && decoded.purpose !== "portal_session") return null;
  if (decoded.aud && decoded.aud !== PORTAL_JWT_AUDIENCE) return null;
  if (decoded.iss && decoded.iss !== PORTAL_JWT_ISSUER) return null;
  if (!decoded.merchantUserId || !decoded.merchantId || !decoded.email || !decoded.role) {
    return null;
  }
  if (decoded.jti && (await isJtiRevoked("portal", decoded.jti))) {
    return null;
  }

  const tokenSv = decoded.sv ?? decoded.sessionVersion ?? 0;
  const currentSv = await loadSessionVersion(decoded.merchantUserId);
  if (currentSv == null) return null;
  if (tokenSv !== currentSv) return null;

  return {
    merchantUserId: decoded.merchantUserId,
    merchantId: decoded.merchantId,
    email: decoded.email,
    role: decoded.role,
    jti: decoded.jti ?? "",
    expiresAt: decoded.exp ? new Date(decoded.exp * 1000) : new Date(0),
    sessionVersion: tokenSv,
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

export function signPortalStepUpToken(payload: {
  merchantUserId: string;
  action: PortalStepUpAction;
}): string {
  return jwt.sign(
    { merchantUserId: payload.merchantUserId, action: payload.action },
    getJwtSecret(),
    {
      expiresIn: STEP_UP_EXPIRY,
      issuer: PORTAL_JWT_ISSUER,
      audience: PORTAL_STEP_UP_AUDIENCE,
      subject: payload.merchantUserId,
      jwtid: randomUUID(),
    }
  );
}

export function verifyPortalStepUpToken(
  token: string,
  action: PortalStepUpAction
): { merchantUserId: string; jti: string } | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), {
      audience: PORTAL_STEP_UP_AUDIENCE,
      issuer: PORTAL_JWT_ISSUER,
      clockTolerance: CLOCK_TOLERANCE_SEC,
    }) as { merchantUserId: string; action: PortalStepUpAction; jti?: string };
    // Exact match only — a step-up token proven for one sensitive action must
    // never authorize a different one (see security review: scoping bypass).
    if (decoded.action !== action) return null;
    if (!decoded.merchantUserId) return null;
    return { merchantUserId: decoded.merchantUserId, jti: decoded.jti ?? "" };
  } catch {
    return null;
  }
}

/**
 * Require `X-Portal-Step-Up` when the actor has MFA enrolled.
 * Skipped (allow) when MFA is not enabled — same fail-open enrollment
 * pattern as provider; combine with PORTAL_MFA_REQUIRED to force enroll.
 */
export async function requirePortalStepUp(
  request: FastifyRequest,
  reply: FastifyReply,
  action: PortalStepUpAction
): Promise<boolean> {
  const user = request.portalUser;
  if (!user) {
    reply.status(401).send({ error: "Unauthorized" });
    return false;
  }

  const [row] = await db
    .select({ mfaEnabled: merchantUsers.mfaEnabled })
    .from(merchantUsers)
    .where(eq(merchantUsers.id, user.merchantUserId))
    .limit(1);

  if (!row?.mfaEnabled) {
    return true;
  }

  const headerToken = request.headers["x-portal-step-up"];
  const token = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (!token || typeof token !== "string") {
    reply.status(403).send({
      error: "Forbidden",
      message: "Step-up MFA required",
      stepUpRequired: true,
      action,
    });
    return false;
  }

  const verified = verifyPortalStepUpToken(token, action);
  if (!verified || verified.merchantUserId !== user.merchantUserId) {
    reply.status(403).send({
      error: "Forbidden",
      message: "Invalid or expired step-up token",
      stepUpRequired: true,
      action,
    });
    return false;
  }
  return true;
}

function isPortalMfaEnrollmentPath(path: string, method: string): boolean {
  if (path.startsWith("/portal/me/mfa/")) return true;
  if (method === "GET" && (path === "/portal/me" || path === "/portal/me/")) return true;
  return false;
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

  if (!isPortalMfaRequired()) return;

  const path = request.url.split("?")[0] ?? "";
  if (isPortalMfaEnrollmentPath(path, request.method)) return;

  const [row] = await db
    .select({ mfaEnabled: merchantUsers.mfaEnabled })
    .from(merchantUsers)
    .where(eq(merchantUsers.id, session.merchantUserId))
    .limit(1);

  if (!row?.mfaEnabled) {
    return reply.status(403).send({
      error: "Forbidden",
      message: "MFA enrollment required",
      mfaSetupRequired: true,
    });
  }
}
