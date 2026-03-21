/**
 * Portal auth: JWT for session, bcrypt for passwords.
 * Used by /portal/* routes (merchant dashboard login).
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";

const SALT_ROUNDS = 10;
const JWT_EXPIRY = "7d";

export type PortalContext = {
  merchantUserId: string;
  merchantId: string;
  email: string;
  role: string;
};

declare module "fastify" {
  interface FastifyRequest {
    portalUser?: PortalContext;
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
    { expiresIn: JWT_EXPIRY }
  );
}

export function verifyPortalToken(token: string): PortalContext | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as PortalContext & {
      purpose?: string;
      sub?: string;
    };
    if (decoded.sub === "mfa_pending") return null;
    if (decoded.purpose != null && decoded.purpose !== "portal_session") return null;
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
    { expiresIn: "5m" }
  );
}

export function verifyPortalMfaPendingToken(token: string): PortalContext | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as PortalContext & { sub?: string };
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

  const payload = verifyPortalToken(token);
  if (!payload) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Invalid or expired token",
    });
  }

  request.portalUser = payload;
}
