/**
 * Per-rail portal payout access gates (KYC/active + market entitlement).
 * Shared by each rail's own route file AND by payout-approvals.ts, which
 * re-runs the same gate when a queued payout is later approved — kept in
 * one place (rather than duplicated per route file, as before) so the two
 * call sites can never drift, and so payout-approvals.ts doesn't have to
 * import from the route files (which would create a circular import,
 * since the route files import evaluatePortalPayoutGate from
 * payout-approvals.ts).
 */
import type { FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { merchants } from "../db/schema/index.js";
import { assertMerchantMarketApiAccess } from "./merchant-markets.js";

export async function requirePortalEuropeAccess(
  merchantId: string,
  environment: "test" | "live",
  reply: FastifyReply
): Promise<boolean> {
  const kycRequired = process.env.KYC_REQUIRED === "true";

  if (environment === "live" || kycRequired) {
    const [merchant] = await db
      .select({ status: merchants.status, kycStatus: merchants.kycStatus })
      .from(merchants)
      .where(eq(merchants.id, merchantId))
      .limit(1);
    if (!merchant) {
      reply.status(401).send({ error: "Unauthorized" });
      return false;
    }
    if (environment === "live" && merchant.status !== "active") {
      reply.status(403).send({ error: "Forbidden", message: "Merchant account is not active" });
      return false;
    }
    if (merchant.kycStatus !== "verified") {
      reply.status(403).send({
        error: "Forbidden",
        message: "KYC verification required for Europe payouts",
      });
      return false;
    }
  }

  const gate = await assertMerchantMarketApiAccess({
    merchantId,
    market: "europe",
    kycRequired,
  });
  if (!gate.ok) {
    reply.status(403).send({
      error: "Forbidden",
      message: gate.message,
      code: gate.code,
    });
    return false;
  }

  return true;
}

export async function requirePortalIndiaAccess(
  merchantId: string,
  environment: "test" | "live",
  reply: FastifyReply
): Promise<boolean> {
  const kycRequired = process.env.KYC_REQUIRED === "true";

  if (environment === "live" || kycRequired) {
    const [merchant] = await db
      .select({ status: merchants.status, kycStatus: merchants.kycStatus })
      .from(merchants)
      .where(eq(merchants.id, merchantId))
      .limit(1);
    if (!merchant) {
      reply.status(401).send({ error: "Unauthorized" });
      return false;
    }
    if (environment === "live" && merchant.status !== "active") {
      reply.status(403).send({ error: "Forbidden", message: "Merchant account is not active" });
      return false;
    }
    if (merchant.kycStatus !== "verified") {
      reply.status(403).send({
        error: "Forbidden",
        message: "KYC verification required for India payouts",
      });
      return false;
    }
  }

  const gate = await assertMerchantMarketApiAccess({
    merchantId,
    market: "india",
    kycRequired,
  });
  if (!gate.ok) {
    reply.status(403).send({
      error: "Forbidden",
      message: gate.message,
      code: gate.code,
    });
    return false;
  }

  return true;
}

/** Gate portal Brazil flows on KYC (live/forced) + the `brazil` market entitlement. */
export async function requirePortalBrazilAccess(
  merchantId: string,
  environment: "test" | "live",
  reply: FastifyReply
): Promise<boolean> {
  const kycRequired = process.env.KYC_REQUIRED === "true";

  if (environment === "live" || kycRequired) {
    const [merchant] = await db
      .select({ status: merchants.status, kycStatus: merchants.kycStatus })
      .from(merchants)
      .where(eq(merchants.id, merchantId))
      .limit(1);
    if (!merchant) {
      reply.status(401).send({ error: "Unauthorized" });
      return false;
    }
    if (environment === "live" && merchant.status !== "active") {
      reply.status(403).send({ error: "Forbidden", message: "Merchant account is not active" });
      return false;
    }
    if (merchant.kycStatus !== "verified") {
      reply.status(403).send({
        error: "Forbidden",
        message: "KYC verification required for Brazil payments",
      });
      return false;
    }
  }

  const gate = await assertMerchantMarketApiAccess({ merchantId, market: "brazil", kycRequired });
  if (!gate.ok) {
    reply.status(403).send({ error: "Forbidden", message: gate.message, code: gate.code });
    return false;
  }

  return true;
}

export async function requirePortalNgnAccess(
  merchantId: string,
  environment: "test" | "live",
  reply: FastifyReply
): Promise<boolean> {
  if (environment === "test") {
    reply.status(503).send({
      error: "Service Unavailable",
      message: "NGN is only available in the live environment",
      code: "payment_unavailable",
    });
    return false;
  }

  const kycRequired = process.env.KYC_REQUIRED === "true";

  if (environment === "live" || kycRequired) {
    const [merchant] = await db
      .select({ status: merchants.status, kycStatus: merchants.kycStatus })
      .from(merchants)
      .where(eq(merchants.id, merchantId))
      .limit(1);
    if (!merchant) {
      reply.status(401).send({ error: "Unauthorized" });
      return false;
    }
    if (environment === "live" && merchant.status !== "active") {
      reply.status(403).send({ error: "Forbidden", message: "Merchant account is not active" });
      return false;
    }
    if (merchant.kycStatus !== "verified") {
      reply.status(403).send({
        error: "Forbidden",
        message: "KYC verification required for NGN",
      });
      return false;
    }
  }

  const gate = await assertMerchantMarketApiAccess({
    merchantId,
    market: "nigeria",
    kycRequired,
  });
  if (!gate.ok) {
    reply.status(403).send({ error: "Forbidden", message: gate.message, code: gate.code });
    return false;
  }

  return true;
}

/**
 * Gate the legacy Bangladesh portal payout on merchant active/KYC status.
 * Note: unlike the other 4 payout rails this does not call
 * assertMerchantMarketApiAccess — a pre-existing divergence, not
 * introduced by this module.
 */
export async function requirePortalBangladeshAccess(
  merchantId: string,
  environment: "test" | "live",
  reply: FastifyReply
): Promise<boolean> {
  if (environment !== "live") return true;

  const [merchant] = await db
    .select({ status: merchants.status, kycStatus: merchants.kycStatus })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);
  if (!merchant) {
    reply.status(401).send({ error: "Unauthorized" });
    return false;
  }
  if (merchant.status !== "active") {
    reply.status(403).send({ error: "Forbidden", message: "Merchant account is not active" });
    return false;
  }
  if (merchant.kycStatus !== "verified") {
    reply.status(403).send({ error: "Forbidden", message: "KYC verification required for live payouts" });
    return false;
  }
  return true;
}
