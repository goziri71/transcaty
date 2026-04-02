import type { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { providerUsers } from "../db/schema/index.js";
import { getSecret } from "./encryption.js";

export const PROVIDER_ROLES = ["super_admin", "ops", "risk", "finance", "support"] as const;
export type ProviderRole = (typeof PROVIDER_ROLES)[number];
export type ProviderPermission =
  | "merchant.read"
  | "merchant.status.write"
  | "merchant.kyc.write"
  | "merchant.pricing.read"
  | "merchant.pricing.write"
  | "customer.read"
  | "customer.status.write"
  | "wallet.adjust"
  | "tx.read"
  | "tx.reconcile"
  | "tx.status.write"
  | "approval.read"
  | "approval.review"
  | "provider.users.manage";

export type ProviderContext = {
  providerUserId?: string;
  email?: string;
  role: ProviderRole;
  authType: "api_key" | "jwt";
};

declare module "fastify" {
  interface FastifyRequest {
    provider?: ProviderContext;
  }
}

/**
 * Provider (Transacty admin) auth.
 * Headers:
 * - API key: X-Provider-Key or Authorization: Bearer <key>
 * - JWT: Authorization: Bearer <token> or X-Provider-Token
 * Env: PROVIDER_API_KEY or PROVIDER_API_KEY_ENC
 */

const SALT_ROUNDS = 10;
const PROVIDER_JWT_EXPIRY = "12h";

export function getProviderApiKey(): string | null {
  const expected = getSecret("PROVIDER_API_KEY", "PROVIDER_API_KEY_ENC");
  return expected?.trim() || null;
}

function getProviderJwtSecret(): string {
  const secret = process.env.PROVIDER_JWT_SECRET ?? process.env.PORTAL_JWT_SECRET ?? process.env.JWT_SECRET;
  if (!secret?.trim()) {
    throw new Error("PROVIDER_JWT_SECRET (or PORTAL_JWT_SECRET/JWT_SECRET fallback) required for provider JWT auth");
  }
  return secret;
}

export function signProviderToken(payload: {
  providerUserId: string;
  email: string;
  role: ProviderRole;
}): string {
  return jwt.sign(
    { ...payload, purpose: "provider_session" as const },
    getProviderJwtSecret(),
    { expiresIn: PROVIDER_JWT_EXPIRY }
  );
}

export function verifyProviderToken(token: string): {
  providerUserId: string;
  email: string;
  role: ProviderRole;
} | null {
  try {
    const decoded = jwt.verify(token, getProviderJwtSecret()) as {
      providerUserId: string;
      email: string;
      role: ProviderRole;
      purpose?: string;
      sub?: string;
    };
    if (decoded.sub === "mfa_pending") return null;
    if (decoded.purpose != null && decoded.purpose !== "provider_session") return null;
    return {
      providerUserId: decoded.providerUserId,
      email: decoded.email,
      role: decoded.role,
    };
  } catch {
    return null;
  }
}

export function signProviderMfaPendingToken(payload: {
  providerUserId: string;
  email: string;
  role: ProviderRole;
}): string {
  return jwt.sign(
    {
      sub: "mfa_pending" as const,
      providerUserId: payload.providerUserId,
      email: payload.email,
      role: payload.role,
    },
    getProviderJwtSecret(),
    { expiresIn: "5m" }
  );
}

export function verifyProviderMfaPendingToken(token: string): {
  providerUserId: string;
  email: string;
  role: ProviderRole;
} | null {
  try {
    const decoded = jwt.verify(token, getProviderJwtSecret()) as {
      providerUserId: string;
      email: string;
      role: ProviderRole;
      sub?: string;
    };
    if (decoded.sub !== "mfa_pending") return null;
    return {
      providerUserId: decoded.providerUserId,
      email: decoded.email,
      role: decoded.role,
    };
  } catch {
    return null;
  }
}

export function hashProviderPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export function verifyProviderPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

const ROLE_PERMISSIONS: Record<ProviderRole, ProviderPermission[]> = {
  super_admin: [
    "merchant.read",
    "merchant.status.write",
    "merchant.kyc.write",
    "merchant.pricing.read",
    "merchant.pricing.write",
    "customer.read",
    "customer.status.write",
    "wallet.adjust",
    "tx.read",
    "tx.reconcile",
    "tx.status.write",
    "approval.read",
    "approval.review",
    "provider.users.manage",
  ],
  ops: ["merchant.read", "customer.read", "customer.status.write", "tx.read", "tx.reconcile", "approval.read"],
  risk: [
    "merchant.read",
    "merchant.status.write",
    "merchant.kyc.write",
    "customer.read",
    "customer.status.write",
    "tx.read",
    "tx.reconcile",
    "tx.status.write",
    "approval.read",
    "approval.review",
  ],
  finance: [
    "merchant.read",
    "merchant.pricing.read",
    "merchant.pricing.write",
    "customer.read",
    "tx.read",
    "tx.reconcile",
    "wallet.adjust",
    "tx.status.write",
    "approval.read",
  ],
  support: ["merchant.read", "customer.read", "tx.read", "tx.reconcile", "approval.read"],
};

export function getProviderPermissions(role: ProviderRole): ProviderPermission[] {
  return ROLE_PERMISSIONS[role];
}

export function canProviderAccess(role: ProviderRole, permission: ProviderPermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

function normalizeIp(ip: string): string {
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

export async function providerAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const allowlistRaw = process.env.PROVIDER_IP_ALLOWLIST?.trim();
  if (allowlistRaw) {
    const allowlist = allowlistRaw
      .split(",")
      .map((v) => normalizeIp(v.trim()))
      .filter(Boolean);
    const forwarded = (request.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
    const requestIp = normalizeIp(forwarded || request.ip || "");
    if (!allowlist.includes(requestIp)) {
      return reply.status(403).send({
        error: "Forbidden",
        message: "Provider access denied for this IP",
      });
    }
  }

  const headerKey = request.headers["x-provider-key"] as string | undefined;
  const headerToken = request.headers["x-provider-token"] as string | undefined;
  const authHeader = request.headers.authorization;
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;

  // 1) API key auth (fallback + bootstrap)
  const apiKey = getProviderApiKey();
  const providedApiKey = headerKey ?? bearer;
  if (apiKey && providedApiKey && providedApiKey === apiKey) {
    request.provider = { role: "super_admin", authType: "api_key" };
    return;
  }

  // 2) JWT auth
  const token = bearer ?? headerToken;
  if (!token) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Missing provider credentials",
    });
  }
  const payload = verifyProviderToken(token);
  if (!payload) {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Invalid or expired provider token",
    });
  }

  const [user] = await db
    .select({
      id: providerUsers.id,
      email: providerUsers.email,
      role: providerUsers.role,
      status: providerUsers.status,
    })
    .from(providerUsers)
    .where(and(eq(providerUsers.id, payload.providerUserId), eq(providerUsers.email, payload.email)))
    .limit(1);

  if (!user || user.status !== "active") {
    return reply.status(401).send({
      error: "Unauthorized",
      message: "Provider user is inactive or missing",
    });
  }

  request.provider = {
    providerUserId: user.id,
    email: user.email,
    role: user.role as ProviderRole,
    authType: "jwt",
  };
}
 
