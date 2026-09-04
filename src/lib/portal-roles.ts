/**
 * Portal RBAC helpers for money and high-privilege settings.
 * Roles: admin | finance | viewer (see merchant_user_role enum).
 */
import type { FastifyRequest, FastifyReply } from "fastify";
import { requirePortalStepUp } from "./portal-auth.js";
import { readIdempotencyKey } from "./idempotency.js";
import { requireMerchantPayoutPin } from "./merchant-payout-pin.js";

export function portalRoleCanMoveMoney(role: string): boolean {
  return role === "admin" || role === "finance";
}

/** API keys, webhook URL, and similar credential surface — admin only. */
export function portalRoleCanManageCredentials(role: string): boolean {
  return role === "admin";
}

export async function requirePortalMoneyRole(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  const user = request.portalUser;
  if (!user) {
    reply.status(401).send({ error: "Unauthorized" });
    return false;
  }
  if (!portalRoleCanMoveMoney(user.role)) {
    reply.status(403).send({
      error: "Forbidden",
      message: "Finance or admin role required for money operations",
    });
    return false;
  }
  return true;
}

export async function requirePortalAdminRole(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  const user = request.portalUser;
  if (!user) {
    reply.status(401).send({ error: "Unauthorized" });
    return false;
  }
  if (!portalRoleCanManageCredentials(user.role)) {
    reply.status(403).send({
      error: "Forbidden",
      message: "Admin role required",
    });
    return false;
  }
  return true;
}

/** Role + step-up + required Idempotency-Key for portal money mutations. */
export async function requirePortalMoneyGuards(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  if (!(await requirePortalMoneyRole(request, reply))) return false;
  if (!(await requirePortalStepUp(request, reply, "money.write"))) return false;
  if (!readIdempotencyKey(request)) {
    reply.status(400).send({
      error: "Bad Request",
      message: "Idempotency-Key header is required",
    });
    return false;
  }
  return true;
}

/** Role + step-up + idempotency + payout PIN for portal payout mutations. */
export async function requirePortalPayoutGuards(
  request: FastifyRequest,
  reply: FastifyReply,
  pin: string | undefined
): Promise<boolean> {
  if (!(await requirePortalMoneyGuards(request, reply))) return false;
  if (!(await requireMerchantPayoutPin(request, reply, pin))) return false;
  return true;
}
