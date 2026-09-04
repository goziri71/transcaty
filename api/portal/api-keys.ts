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
import {
  normalizeMerchantApiScopes,
} from "../../src/lib/merchant-api-scopes.js";
import { requirePortalAdminRole } from "../../src/lib/portal-roles.js";
import { requirePortalStepUp } from "../../src/lib/portal-auth.js";
import {
  maskMerchantApiKey,
  merchantApiKeyHint,
} from "../../src/lib/merchant-api-key-display.js";

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
          keyHint: merchantApiKeys.keyHint,
          environment: merchantApiKeys.environment,
          scopes: merchantApiKeys.scopes,
          status: merchantApiKeys.status,
          createdAt: merchantApiKeys.createdAt,
        })
        .from(merchantApiKeys)
        .where(eq(merchantApiKeys.merchantId, user.merchantId));

      const items = rows.map((r) => ({
        id: r.id,
        keyMasked: maskMerchantApiKey(r.keyHint),
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
          /** Optional least-privilege scopes. Omit for backward-compatible default (includes `*`). */
          scopes: z.array(z.string().min(1)).min(1).optional(),
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
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          500: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      if (!(await requirePortalAdminRole(request, reply))) return;
      if (!(await requirePortalStepUp(request, reply, "api_keys.write"))) return;

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

      const body = request.body as {
        environment?: "live" | "test";
        scopes?: string[];
      };
      const environment = body.environment ?? "test";
      const scopesNorm = normalizeMerchantApiScopes(body.scopes);
      if (!scopesNorm.ok) {
        return reply.status(400).send({ error: "Bad Request", message: scopesNorm.message });
      }
      const scopesValue = scopesNorm.value;

      const masterKey = process.env.ENCRYPTION_MASTER_KEY;
      if (!masterKey) {
        return reply.status(500).send({
          error: "Internal",
          message: "API key encryption not configured",
        });
      }

      // One active live key: creating a new live key revokes prior live keys.
      if (environment === "live") {
        const priorLive = await db
          .select({ id: merchantApiKeys.id, keyHash: merchantApiKeys.keyHash })
          .from(merchantApiKeys)
          .where(
            and(
              eq(merchantApiKeys.merchantId, user.merchantId),
              eq(merchantApiKeys.environment, "live"),
              eq(merchantApiKeys.status, "active")
            )
          );
        if (priorLive.length > 0) {
          await db
            .update(merchantApiKeys)
            .set({ status: "revoked" })
            .where(
              and(
                eq(merchantApiKeys.merchantId, user.merchantId),
                eq(merchantApiKeys.environment, "live"),
                eq(merchantApiKeys.status, "active")
              )
            );
          for (const k of priorLive) {
            invalidateMerchantApiKeyCache(k.keyHash);
          }
          audit({
            action: "portal.api_key.auto_revoked_prior_live",
            merchantId: user.merchantId,
            merchantUserId: user.merchantUserId,
            actorEmail: user.email,
            meta: { revokedIds: priorLive.map((k) => k.id) },
          });
        }
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
          keyHint: merchantApiKeyHint(apiKey),
          secretEnc,
          environment,
          scopes: scopesValue,
          status: "active",
        })
        .returning({ id: merchantApiKeys.id });

      audit({
        action: "portal.api_key.created",
        merchantId: user.merchantId,
        merchantUserId: user.merchantUserId,
        actorEmail: user.email,
        resource: inserted!.id,
        meta: { environment, scopes: scopesValue },
      });

      return reply.status(201).send({
        id: inserted!.id,
        apiKey,
        secret,
        environment,
        scopes: scopesValue,
        message:
          environment === "live"
            ? "Save the secret securely. It will not be shown again. Any previous live API key was revoked."
            : "Save the secret securely. It will not be shown again.",
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
      if (!(await requirePortalAdminRole(request, reply))) return;
      if (!(await requirePortalStepUp(request, reply, "api_keys.write"))) return;

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
