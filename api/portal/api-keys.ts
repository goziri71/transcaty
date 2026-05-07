/**
 * Portal API keys routes: list, create, revoke.
 * Requires portal JWT auth and kycStatus === 'verified'.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomBytes, createHash } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { merchants, merchantApiKeys } from "../../src/db/schema/index.js";
import { encrypt } from "../../src/lib/encryption.js";
import { audit } from "../../src/lib/audit.js";
import { invalidateMerchantApiKeyCache } from "../../src/lib/merchant-key-cache.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

function generateKey(): string {
  return "transacty_" + randomBytes(24).toString("hex");
}

function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function maskKey(keyId: string): string {
  return "••••••••" + keyId.slice(-8);
}

export async function registerPortalApiKeysRoutes(app: FastifyInstance) {
  app.get(
    "/portal/me/api-keys",
    {
      schema: {
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                keyMasked: z.string(),
                environment: z.string(),
                scopes: z.string(),
                status: z.string(),
                createdAt: z.string(),
              })
            ),
          }),
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const [merchant] = await db
        .select({ kycStatus: merchants.kycStatus })
        .from(merchants)
        .where(eq(merchants.id, user.merchantId))
        .limit(1);

      if (merchant?.kycStatus !== "verified") {
        return reply.status(403).send({
          error: "Forbidden",
          message: "KYC verification required to manage API keys",
        });
      }

      const rows = await db
        .select({
          id: merchantApiKeys.id,
          keyHash: merchantApiKeys.keyHash,
          environment: merchantApiKeys.environment,
          scopes: merchantApiKeys.scopes,
          status: merchantApiKeys.status,
          createdAt: merchantApiKeys.createdAt,
        })
        .from(merchantApiKeys)
        .where(eq(merchantApiKeys.merchantId, user.merchantId));

      const items = rows.map((r) => ({
        id: r.id,
        keyMasked: maskKey(r.id),
        environment: r.environment,
        scopes: r.scopes,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      }));

      return { items };
    }
  );

  app.post(
    "/portal/me/api-keys",
    {
      schema: {
        body: z.object({
          environment: z.enum(["live", "test"]).default("test"),
        }),
        response: {
          201: z.object({
            id: z.string(),
            apiKey: z.string(),
            secret: z.string(),
            environment: z.string(),
            scopes: z.string(),
            message: z.string(),
          }),
          401: errorResponse,
          403: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const [merchant] = await db
        .select({ kycStatus: merchants.kycStatus })
        .from(merchants)
        .where(eq(merchants.id, user.merchantId))
        .limit(1);

      if (merchant?.kycStatus !== "verified") {
        return reply.status(403).send({
          error: "Forbidden",
          message: "KYC verification required to create API keys",
        });
      }

      const body = request.body as { environment?: "live" | "test" };
      const environment = body.environment ?? "test";

      const masterKey = process.env.ENCRYPTION_MASTER_KEY;
      if (!masterKey) {
        return reply.status(500).send({
          error: "Internal",
          message: "API key encryption not configured",
        });
      }

      const apiKey = generateKey();
      const secret = generateSecret();
      const keyHash = hashKey(apiKey);
      const secretEnc = encrypt(secret, masterKey);

      const [inserted] = await db
        .insert(merchantApiKeys)
        .values({
          merchantId: user.merchantId,
          keyHash,
          secretEnc,
          environment,
          scopes: "payin:create,payout:create,balance:read,*",
          status: "active",
        })
        .returning({ id: merchantApiKeys.id });

      audit({
        action: "portal.api_key.created",
        merchantId: user.merchantId,
        merchantUserId: user.merchantUserId,
        actorEmail: user.email,
        resource: inserted!.id,
        meta: { environment },
      });

      return reply.status(201).send({
        id: inserted!.id,
        apiKey,
        secret,
        environment,
        scopes: "payin:create,payout:create,balance:read,*",
        message: "Save the secret securely. It will not be shown again.",
      });
    }
  );

  app.delete(
    "/portal/me/api-keys/:keyId",
    {
      schema: {
        params: z.object({ keyId: z.string().uuid() }),
        response: {
          200: z.object({ ok: z.boolean() }),
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const [merchant] = await db
        .select({ kycStatus: merchants.kycStatus })
        .from(merchants)
        .where(eq(merchants.id, user.merchantId))
        .limit(1);

      if (merchant?.kycStatus !== "verified") {
        return reply.status(403).send({
          error: "Forbidden",
          message: "KYC verification required to manage API keys",
        });
      }

      const { keyId } = request.params as { keyId: string };

      const [key] = await db
        .select({
          id: merchantApiKeys.id,
          keyHash: merchantApiKeys.keyHash,
        })
        .from(merchantApiKeys)
        .where(
          and(
            eq(merchantApiKeys.id, keyId),
            eq(merchantApiKeys.merchantId, user.merchantId)
          )
        )
        .limit(1);

      if (!key) {
        return reply.status(404).send({ error: "Not found", message: "API key not found" });
      }

      await db
        .update(merchantApiKeys)
        .set({ status: "revoked" })
        .where(eq(merchantApiKeys.id, keyId));

      // Drop any cached entry so a freshly-revoked key cannot continue
      // authenticating from per-process cache for up to the positive TTL.
      invalidateMerchantApiKeyCache(key.keyHash);

      audit({
        action: "portal.api_key.revoked",
        merchantId: user.merchantId,
        merchantUserId: user.merchantUserId,
        actorEmail: user.email,
        resource: keyId,
      });

      return { ok: true };
    }
  );
}
