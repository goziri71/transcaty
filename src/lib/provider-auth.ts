import type { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { providerUsers } from "../db/schema/index.js";
import { getSecret } from "./encryption.js";
import { isJtiRevoked } from "./jwt-revocation.js";

export const PROVIDER_JWT_ISSUER = "transacty.provider";
export const PROVIDER_JWT_AUDIENCE = "transacty.provider.session";
export const PROVIDER_MFA_PENDING_AUDIENCE = "transacty.provider.mfa_pending";
export const PROVIDER_STEP_UP_AUDIENCE = "transacty.provider.step_up";
const PROVIDER_CLOCK_TOLERANCE_SEC = 30;
const SESSION_VERSION_CACHE_TTL_MS = 5_000;

/** Constant-time string compare for secret material. Returns false on
 * length mismatch instead of throwing. */
function timingSafeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Still run a same-length compare so the mismatch path doesn't take
    // a measurably different amount of time than the success path.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export const PROVIDER_ROLES = ["super_admin", "ops", "risk", "finance", "support"] as const;
export type ProviderRole = (typeof PROVIDER_ROLES)[number];
export type ProviderPermission =
  | "merchant.read"
  | "merchant.status.write"
  | "merchant.kyc.write"
  | "merchant.pricing.read"
  | "merchant.pricing.write"
  | "merchant.rates.read"
  | "merchant.rates.write"
  | "merchant.ip_whitelist.read"
  | "merchant.ip_whitelist.write"
  | "customer.read"
  | "customer.status.write"
  | "wallet.adjust"
  | "tx.read"
  | "tx.reconcile"
  | "tx.status.write"
  | "approval.read"
  | "approval.review"
  | "provider.users.manage"
  | "treasury.read";

/** Permissions that mutate money or transaction state. API-key auth is
 * always denied these regardless of the role mapping — JWT + MFA is
 * required for these actions. See P4 Auth Hardening. */
export const API_KEY_DENIED_PERMISSIONS = new Set<ProviderPermission>([
  "wallet.adjust",
  "tx.status.write",
  "merchant.status.write",
  "merchant.kyc.write",
  "merchant.pricing.write",
  "merchant.rates.write",
  "merchant.ip_whitelist.write",
  "approval.review",
  "provider.users.manage",
]);

export type ProviderContext = {
  providerUserId?: string;
  email?: string;
  role: ProviderRole;
  authType: "api_key" | "jwt";
  /** Set true once the request has presented a valid step-up MFA token
   * for the action it is performing. P4 step-up enforcement reads this
   * via `requireProviderStepUp` middleware. */
  stepUpVerified?: boolean;
};

declare module "fastify" {
  interface FastifyRequest {
    provider?: ProviderContext;
    providerSession?: ProviderSessionToken;
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

/** Role assigned to API-key sessions. Defaults to `support` (read-only).
 * Set `PROVIDER_API_KEY_ROLE` to override (e.g. `ops` for legacy callers
 * that need to ack approvals). `super_admin` is intentionally rejected
 * to prevent the leaked-key god-mode that originally motivated P4. */
export function getProviderApiKeyRole(): ProviderRole {
  const raw = process.env.PROVIDER_API_KEY_ROLE?.trim().toLowerCase();
  if (!raw) return "support";
  if (raw === "super_admin") {
    // Hard reject; loud warning at boot below also fires.
    return "support";
  }
  if ((PROVIDER_ROLES as readonly string[]).includes(raw)) {
    return raw as ProviderRole;
  }
  return "support";
}

let providerApiKeyBootWarningEmitted = false;
function emitProviderApiKeyBootWarning(): void {
  if (providerApiKeyBootWarningEmitted) return;
  providerApiKeyBootWarningEmitted = true;
  const role = getProviderApiKeyRole();
  const requested = process.env.PROVIDER_API_KEY_ROLE?.trim().toLowerCase();
  if (requested === "super_admin") {
    console.warn(
      "[provider-auth] PROVIDER_API_KEY_ROLE='super_admin' is rejected; " +
        "API-key sessions cannot perform money mutations. Falling back to 'support'."
    );
  } else {
    console.warn(
      `[provider-auth] PROVIDER_API_KEY is configured with role=${role}. ` +
        "API-key sessions are denied wallet.adjust, tx.status.write, " +
        "merchant.status.write, merchant.kyc.write, merchant.pricing.write, " +
        "approval.review and provider.users.manage. Use a JWT session for those actions."
    );
  }
}

function getProviderJwtSecret(): string {
  const secret = process.env.PROVIDER_JWT_SECRET ?? process.env.PORTAL_JWT_SECRET ?? process.env.JWT_SECRET;
  if (!secret?.trim()) {
    throw new Error("PROVIDER_JWT_SECRET (or PORTAL_JWT_SECRET/JWT_SECRET fallback) required for provider JWT auth");
  }
  return secret;
}

export type ProviderSessionToken = {
  providerUserId: string;
  email: string;
  role: ProviderRole;
  jti: string;
  expiresAt: Date;
  sessionVersion: number;
};

export function signProviderToken(payload: {
  providerUserId: string;
  email: string;
  role: ProviderRole;
  sessionVersion?: number;
}): string {
  const sv = payload.sessionVersion ?? 0;
  return jwt.sign(
    {
      providerUserId: payload.providerUserId,
      email: payload.email,
      role: payload.role,
      sv,
      purpose: "provider_session" as const,
    },
    getProviderJwtSecret(),
    {
      expiresIn: PROVIDER_JWT_EXPIRY,
      issuer: PROVIDER_JWT_ISSUER,
      audience: PROVIDER_JWT_AUDIENCE,
      subject: payload.providerUserId,
      jwtid: randomUUID(),
    }
  );
}

interface ProviderTokenPayload {
  providerUserId: string;
  email: string;
  role: ProviderRole;
  purpose?: string;
  sub?: string;
  jti?: string;
  exp?: number;
  iss?: string;
  aud?: string | string[];
  sv?: number;
}

function decodeProviderToken(token: string, audience?: string): ProviderTokenPayload | null {
  try {
    const decoded = jwt.verify(token, getProviderJwtSecret(), {
      ...(audience ? { audience, issuer: PROVIDER_JWT_ISSUER } : {}),
      clockTolerance: PROVIDER_CLOCK_TOLERANCE_SEC,
    }) as ProviderTokenPayload;
    return decoded;
  } catch {
    return null;
  }
}

const providerSessionVersionCache = new Map<string, { version: number; expiresAt: number }>();

/** Test seam: stub session-version lookup without a live DB. */
type ProviderSessionVersionLookupFn = (userId: string) => Promise<number | null>;
let providerSessionVersionLookupOverride: ProviderSessionVersionLookupFn | null = null;
export function __setProviderSessionVersionLookupForTesting(
  fn: ProviderSessionVersionLookupFn | null
): void {
  providerSessionVersionLookupOverride = fn;
  providerSessionVersionCache.clear();
}

export function invalidateProviderSessionVersionCache(userId: string): void {
  providerSessionVersionCache.delete(userId);
}

async function loadProviderSessionVersion(userId: string): Promise<number | null> {
  if (providerSessionVersionLookupOverride) {
    return providerSessionVersionLookupOverride(userId);
  }
  const now = Date.now();
  const cached = providerSessionVersionCache.get(userId);
  if (cached && cached.expiresAt > now) return cached.version;
  const [row] = await db
    .select({ sessionVersion: providerUsers.sessionVersion })
    .from(providerUsers)
    .where(eq(providerUsers.id, userId))
    .limit(1);
  if (!row) return null;
  providerSessionVersionCache.set(userId, {
    version: row.sessionVersion,
    expiresAt: now + SESSION_VERSION_CACHE_TTL_MS,
  });
  return row.sessionVersion;
}

/** Bump session epoch so all existing provider JWTs for this user fail verification. */
export async function bumpProviderSessionVersion(userId: string): Promise<number> {
  const [row] = await db
    .update(providerUsers)
    .set({
      sessionVersion: sql`${providerUsers.sessionVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(providerUsers.id, userId))
    .returning({ sessionVersion: providerUsers.sessionVersion });
  invalidateProviderSessionVersionCache(userId);
  return row?.sessionVersion ?? 0;
}

/**
 * Verify a provider session token. Backward-compatible with pre-P4
 * tokens (no aud/iss/jti) so a deploy doesn't kick everyone out.
 */
export async function verifyProviderToken(
  token: string
): Promise<ProviderSessionToken | null> {
  let decoded = decodeProviderToken(token, PROVIDER_JWT_AUDIENCE);
  if (!decoded) {
    decoded = decodeProviderToken(token);
  }
  if (!decoded) return null;
  if (decoded.sub === "mfa_pending") return null;
  if (decoded.aud === PROVIDER_MFA_PENDING_AUDIENCE) return null;
  if (decoded.aud === PROVIDER_STEP_UP_AUDIENCE) return null;
  if (decoded.purpose != null && decoded.purpose !== "provider_session") return null;
  if (decoded.aud && decoded.aud !== PROVIDER_JWT_AUDIENCE) return null;
  if (decoded.iss && decoded.iss !== PROVIDER_JWT_ISSUER) return null;
  if (!decoded.providerUserId || !decoded.email || !decoded.role) return null;
  if (decoded.jti && (await isJtiRevoked("provider", decoded.jti))) {
    return null;
  }

  const tokenSv = decoded.sv ?? 0;
  const currentSv = await loadProviderSessionVersion(decoded.providerUserId);
  if (currentSv == null) return null;
  if (tokenSv !== currentSv) return null;

  return {
    providerUserId: decoded.providerUserId,
    email: decoded.email,
    role: decoded.role,
    jti: decoded.jti ?? "",
    expiresAt: decoded.exp ? new Date(decoded.exp * 1000) : new Date(0),
    sessionVersion: tokenSv,
  };
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
    {
      expiresIn: "5m",
      issuer: PROVIDER_JWT_ISSUER,
      audience: PROVIDER_MFA_PENDING_AUDIENCE,
      jwtid: randomUUID(),
    }
  );
}

export function verifyProviderMfaPendingToken(token: string): {
  providerUserId: string;
  email: string;
  role: ProviderRole;
} | null {
  const tryVerify = (audience?: string): ProviderTokenPayload | null => {
    try {
      return jwt.verify(token, getProviderJwtSecret(), {
        ...(audience ? { audience, issuer: PROVIDER_JWT_ISSUER } : {}),
        clockTolerance: PROVIDER_CLOCK_TOLERANCE_SEC,
      }) as ProviderTokenPayload;
    } catch {
      return null;
    }
  };
  const decoded = tryVerify(PROVIDER_MFA_PENDING_AUDIENCE) ?? tryVerify();
  if (!decoded) return null;
  if (decoded.sub !== "mfa_pending") return null;
  return {
    providerUserId: decoded.providerUserId,
    email: decoded.email,
    role: decoded.role,
  };
}

/**
 * Step-up MFA token: issued via `POST /provider/auth/step-up` after
 * the actor presents a fresh TOTP code. The token is bound to a
 * specific `action` (e.g. "wallet.adjust") and is only valid for a
 * short window. Requests that mutate sensitive state must present
 * `X-Provider-Step-Up: <token>`; see `requireProviderStepUp`.
 */
const STEP_UP_EXPIRY = "5m";
export type ProviderStepUpAction =
  | "wallet.adjust"
  | "tx.status.write"
  | "merchant.kyc.write"
  | "merchant.pricing.write"
  | "merchant.rates.write"
  | "merchant.ip_whitelist.write";

export function signProviderStepUpToken(payload: {
  providerUserId: string;
  action: ProviderStepUpAction;
}): string {
  return jwt.sign(
    { providerUserId: payload.providerUserId, action: payload.action },
    getProviderJwtSecret(),
    {
      expiresIn: STEP_UP_EXPIRY,
      issuer: PROVIDER_JWT_ISSUER,
      audience: PROVIDER_STEP_UP_AUDIENCE,
      subject: payload.providerUserId,
      jwtid: randomUUID(),
    }
  );
}

export function verifyProviderStepUpToken(
  token: string,
  action: ProviderStepUpAction
): { providerUserId: string; jti: string } | null {
  try {
    const decoded = jwt.verify(token, getProviderJwtSecret(), {
      audience: PROVIDER_STEP_UP_AUDIENCE,
      issuer: PROVIDER_JWT_ISSUER,
      clockTolerance: PROVIDER_CLOCK_TOLERANCE_SEC,
    }) as { providerUserId: string; action: ProviderStepUpAction; jti?: string };
    // Exact match only — a step-up token proven for one sensitive action must
    // never authorize a different one (see security review: scoping bypass).
    if (decoded.action !== action) return null;
    if (!decoded.providerUserId) return null;
    return { providerUserId: decoded.providerUserId, jti: decoded.jti ?? "" };
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
    "merchant.rates.read",
    "merchant.rates.write",
    "merchant.ip_whitelist.read",
    "merchant.ip_whitelist.write",
    "customer.read",
    "customer.status.write",
    "wallet.adjust",
    "tx.read",
    "tx.reconcile",
    "tx.status.write",
    "approval.read",
    "approval.review",
    "provider.users.manage",
    "treasury.read",
  ],
  ops: ["merchant.read", "customer.read", "customer.status.write", "tx.read", "tx.reconcile", "approval.read"],
  risk: [
    "merchant.read",
    "merchant.status.write",
    "merchant.kyc.write",
    "merchant.ip_whitelist.read",
    "merchant.ip_whitelist.write",
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
    "merchant.rates.read",
    "merchant.rates.write",
    "merchant.ip_whitelist.read",
    "merchant.ip_whitelist.write",
    "customer.read",
    "tx.read",
    "tx.reconcile",
    "wallet.adjust",
    "tx.status.write",
    "approval.read",
    "treasury.read",
  ],
  support: ["merchant.read", "customer.read", "tx.read", "tx.reconcile", "approval.read"],
};

export function getProviderPermissions(role: ProviderRole): ProviderPermission[] {
  return ROLE_PERMISSIONS[role];
}

export function canProviderAccess(role: ProviderRole, permission: ProviderPermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Authorization gate aware of `authType`. API-key sessions are
 * permanently denied money- and admin-mutating permissions even when
 * the role mapping would otherwise allow them. Use this in routes that
 * mutate state; pass `request.provider` in.
 */
export function canProviderActionContext(
  ctx: ProviderContext,
  permission: ProviderPermission
): boolean {
  if (ctx.authType === "api_key" && API_KEY_DENIED_PERMISSIONS.has(permission)) {
    return false;
  }
  return canProviderAccess(ctx.role, permission);
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
    // request.ip is resolved via Fastify's trustProxy config (see app.ts), which
    // correctly picks the address nearest the trusted proxy rather than trusting
    // a client-supplied X-Forwarded-For entry.
    const requestIp = normalizeIp(request.ip || "");
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

  // 1) API key auth (fallback + bootstrap). Downgraded role per P4: API
  //    keys map to `support` by default and never to `super_admin`. The
  //    `canProviderActionContext` gate further denies money-mutating
  //    permissions for `authType === "api_key"`, so this path can only
  //    perform read-mostly actions plus bootstrap.
  const apiKey = getProviderApiKey();
  const providedApiKey = headerKey ?? bearer;
  if (apiKey) emitProviderApiKeyBootWarning();
  if (apiKey && providedApiKey && timingSafeStringEqual(providedApiKey, apiKey)) {
    request.provider = { role: getProviderApiKeyRole(), authType: "api_key" };
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
  const session = await verifyProviderToken(token);
  if (!session) {
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
    .where(and(eq(providerUsers.id, session.providerUserId), eq(providerUsers.email, session.email)))
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
  request.providerSession = session;
}

/**
 * Require that the request presents a step-up MFA token bound to the
 * given action. Bypassed when the actor authenticated via API key
 * (those are blocked from money mutations by `canProviderActionContext`
 * already) or has not enrolled MFA; the audit log records `stepUp:
 * "skipped_no_mfa"` so ops can chase enrollment.
 */
export async function requireProviderStepUp(
  request: FastifyRequest,
  reply: FastifyReply,
  action: ProviderStepUpAction
): Promise<boolean> {
  const actor = request.provider;
  if (!actor) {
    reply.status(401).send({ error: "Unauthorized" });
    return false;
  }

  if (actor.authType === "api_key") {
    // Money mutations from API keys are already blocked higher up; if
    // we got here for a non-mutating action, no step-up is required.
    return true;
  }

  if (!actor.providerUserId) {
    reply.status(401).send({ error: "Unauthorized" });
    return false;
  }

  const [user] = await db
    .select({ mfaEnabled: providerUsers.mfaEnabled })
    .from(providerUsers)
    .where(eq(providerUsers.id, actor.providerUserId))
    .limit(1);

  if (!user?.mfaEnabled) {
    // MFA not enrolled — flag in context but allow (so we don't lock
    // out non-MFA admins until enrollment is universal). Use audit
    // logs to track.
    actor.stepUpVerified = false;
    return true;
  }

  const headerToken = request.headers["x-provider-step-up"];
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

  const verified = verifyProviderStepUpToken(token, action);
  if (!verified || verified.providerUserId !== actor.providerUserId) {
    reply.status(403).send({
      error: "Forbidden",
      message: "Step-up MFA token invalid for this action",
      stepUpRequired: true,
      action,
    });
    return false;
  }

  actor.stepUpVerified = true;
  return true;
}
 
