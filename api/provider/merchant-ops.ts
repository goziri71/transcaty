/**
 * Provider merchant operations: KYC review, audit log, webhook, users, API keys.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, count, desc, eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  merchantApiKeys,
  merchantAuditLog,
  merchantBusinessProfiles,
  merchantKycDocuments,
  merchantPersons,
  merchants,
  merchantUsers,
} from "../../src/db/schema/index.js";
import { createKycDownloadUrl } from "../../src/lib/kyc-storage.js";
import { invalidateMerchantApiKeyCache } from "../../src/lib/merchant-key-cache.js";
import { providerMerchantAudit } from "../../src/lib/provider-audit.js";
import { canProviderActionContext } from "../../src/lib/provider-auth.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

type MerchantReadPerm = "merchant.read";
type MerchantWritePerm = "merchant.status.write" | "merchant.kyc.write";

function ensurePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  permission: MerchantReadPerm | MerchantWritePerm
): boolean {
  const actor = request.provider;
  if (!actor) {
    reply.status(401).send({ error: "Unauthorized" });
    return false;
  }
  if (!canProviderActionContext(actor, permission)) {
    const message =
      actor.authType === "api_key"
        ? "API-key sessions cannot perform this action; use a JWT session"
        : "Insufficient role permission";
    reply.status(403).send({ error: "Forbidden", message });
    return false;
  }
  return true;
}

async function merchantExists(merchantId: string): Promise<boolean> {
  const [row] = await db.select({ id: merchants.id }).from(merchants).where(eq(merchants.id, merchantId)).limit(1);
  return !!row;
}

function maskApiKeyId(id: string): string {
  return "••••••••" + id.slice(-8);
}

export async function registerProviderMerchantOpsRoutes(app: FastifyInstance) {
  app.get(
    "/provider/merchants/:merchantId/kyc/business",
    {
      schema: {
        params: z.object({ merchantId: z.string().uuid() }),
        response: {
          200: z
            .object({
              id: z.string(),
              legalName: z.string(),
              tradingName: z.string().nullable(),
              businessType: z.string(),
              registrationNumber: z.string().nullable(),
              incorporationDate: z.string().nullable(),
              industry: z.string().nullable(),
              registeredAddress: z.string(),
              operatingAddress: z.string().nullable(),
              taxId: z.string().nullable(),
              contactPhone: z.string(),
              contactEmail: z.string(),
              status: z.string(),
              rejectionReason: z.string().nullable(),
              verifiedAt: z.string().nullable(),
              rejectedAt: z.string().nullable(),
              createdAt: z.string(),
              updatedAt: z.string(),
            })
            .nullable(),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensurePermission(request, reply, "merchant.read")) return;
      const { merchantId } = request.params as { merchantId: string };
      if (!(await merchantExists(merchantId))) {
        return reply.status(404).send({ error: "Not found", message: "Merchant not found" });
      }

      const [profile] = await db
        .select()
        .from(merchantBusinessProfiles)
        .where(eq(merchantBusinessProfiles.merchantId, merchantId))
        .limit(1);

      if (!profile) return null;

      return {
        id: profile.id,
        legalName: profile.legalName,
        tradingName: profile.tradingName,
        businessType: profile.businessType,
        registrationNumber: profile.registrationNumber,
        incorporationDate: profile.incorporationDate?.toISOString() ?? null,
        industry: profile.industry,
        registeredAddress: profile.registeredAddress,
        operatingAddress: profile.operatingAddress,
        taxId: profile.taxId,
        contactPhone: profile.contactPhone,
        contactEmail: profile.contactEmail,
        status: profile.status,
        rejectionReason: profile.rejectionReason,
        verifiedAt: profile.verifiedAt?.toISOString() ?? null,
        rejectedAt: profile.rejectedAt?.toISOString() ?? null,
        createdAt: profile.createdAt.toISOString(),
        updatedAt: profile.updatedAt.toISOString(),
      };
    }
  );

  app.get(
    "/provider/merchants/:merchantId/kyc/persons",
    {
      schema: {
        params: z.object({ merchantId: z.string().uuid() }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                role: z.string(),
                fullName: z.string(),
                nationality: z.string(),
                dateOfBirth: z.string().nullable(),
                idType: z.string(),
                idNumber: z.string(),
                address: z.string(),
                ownershipPercentage: z.string().nullable(),
                status: z.string(),
                rejectionReason: z.string().nullable(),
                createdAt: z.string(),
              })
            ),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensurePermission(request, reply, "merchant.read")) return;
      const { merchantId } = request.params as { merchantId: string };
      if (!(await merchantExists(merchantId))) {
        return reply.status(404).send({ error: "Not found", message: "Merchant not found" });
      }

      const rows = await db
        .select()
        .from(merchantPersons)
        .where(eq(merchantPersons.merchantId, merchantId))
        .orderBy(desc(merchantPersons.createdAt));

      return {
        items: rows.map((p) => ({
          id: p.id,
          role: p.role,
          fullName: p.fullName,
          nationality: p.nationality,
          dateOfBirth: p.dateOfBirth?.toISOString() ?? null,
          idType: p.idType,
          idNumber: p.idNumber,
          address: p.address,
          ownershipPercentage: p.ownershipPercentage ? String(p.ownershipPercentage) : null,
          status: p.status,
          rejectionReason: p.rejectionReason,
          createdAt: p.createdAt.toISOString(),
        })),
      };
    }
  );

  app.get(
    "/provider/merchants/:merchantId/kyc/documents",
    {
      schema: {
        params: z.object({ merchantId: z.string().uuid() }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                documentType: z.string(),
                documentNumber: z.string().nullable(),
                merchantPersonId: z.string().nullable(),
                status: z.string(),
                submittedAt: z.string(),
                verifiedAt: z.string().nullable(),
              })
            ),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensurePermission(request, reply, "merchant.read")) return;
      const { merchantId } = request.params as { merchantId: string };
      if (!(await merchantExists(merchantId))) {
        return reply.status(404).send({ error: "Not found", message: "Merchant not found" });
      }

      const rows = await db
        .select({
          id: merchantKycDocuments.id,
          documentType: merchantKycDocuments.documentType,
          documentNumber: merchantKycDocuments.documentNumber,
          merchantPersonId: merchantKycDocuments.merchantPersonId,
          status: merchantKycDocuments.status,
          submittedAt: merchantKycDocuments.submittedAt,
          verifiedAt: merchantKycDocuments.verifiedAt,
        })
        .from(merchantKycDocuments)
        .where(eq(merchantKycDocuments.merchantId, merchantId))
        .orderBy(desc(merchantKycDocuments.submittedAt));

      return {
        items: rows.map((d) => ({
          id: d.id,
          documentType: d.documentType,
          documentNumber: d.documentNumber,
          merchantPersonId: d.merchantPersonId,
          status: d.status,
          submittedAt: d.submittedAt.toISOString(),
          verifiedAt: d.verifiedAt?.toISOString() ?? null,
        })),
      };
    }
  );

  app.get(
    "/provider/merchants/:merchantId/kyc/documents/:documentId/download-url",
    {
      schema: {
        params: z.object({
          merchantId: z.string().uuid(),
          documentId: z.string().uuid(),
        }),
        response: {
          200: z.object({
            downloadUrl: z.string().url(),
            expiresIn: z.number(),
          }),
          401: errorResponse,
          404: errorResponse,
          503: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensurePermission(request, reply, "merchant.kyc.write")) return;
      const { merchantId, documentId } = request.params as { merchantId: string; documentId: string };

      const [doc] = await db
        .select({
          fileReference: merchantKycDocuments.fileReference,
        })
        .from(merchantKycDocuments)
        .where(and(eq(merchantKycDocuments.id, documentId), eq(merchantKycDocuments.merchantId, merchantId)))
        .limit(1);

      if (!doc) {
        return reply.status(404).send({ error: "Not found", message: "Document not found" });
      }

      try {
        const result = await createKycDownloadUrl(doc.fileReference);
        providerMerchantAudit(request, {
          action: "config.changed",
          merchantId,
          resource: documentId,
          meta: { kind: "kyc_document_download" },
        });
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Storage unavailable";
        return reply.status(503).send({ error: "Service Unavailable", message: msg });
      }
    }
  );

  app.get(
    "/provider/merchants/:merchantId/audit-log",
    {
      schema: {
        params: z.object({ merchantId: z.string().uuid() }),
        querystring: z.object({
          limit: z.coerce.number().min(1).max(100).default(20),
          offset: z.coerce.number().min(0).default(0),
          action: z.string().min(1).max(100).optional(),
        }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                action: z.string(),
                resource: z.string().nullable(),
                actorEmail: z.string().nullable(),
                meta: z.record(z.unknown()).nullable(),
                createdAt: z.string(),
              })
            ),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensurePermission(request, reply, "merchant.read")) return;
      const { merchantId } = request.params as { merchantId: string };
      const { limit, offset, action } = request.query as {
        limit: number;
        offset: number;
        action?: string;
      };

      if (!(await merchantExists(merchantId))) {
        return reply.status(404).send({ error: "Not found", message: "Merchant not found" });
      }

      const conditions = [eq(merchantAuditLog.merchantId, merchantId)];
      if (action) conditions.push(eq(merchantAuditLog.action, action));

      const [totalResult] = await db
        .select({ count: count() })
        .from(merchantAuditLog)
        .where(and(...conditions));

      const rows = await db
        .select()
        .from(merchantAuditLog)
        .where(and(...conditions))
        .orderBy(desc(merchantAuditLog.createdAt))
        .limit(limit)
        .offset(offset);

      return {
        items: rows.map((r) => ({
          id: r.id,
          action: r.action,
          resource: r.resource,
          actorEmail: r.actorEmail,
          meta: r.meta,
          createdAt: r.createdAt.toISOString(),
        })),
        total: Number(totalResult?.count ?? 0),
        limit,
        offset,
      };
    }
  );

  app.get(
    "/provider/merchants/:merchantId/webhook",
    {
      schema: {
        params: z.object({ merchantId: z.string().uuid() }),
        response: {
          200: z.object({
            webhookUrl: z.string().nullable(),
            webhookConfigured: z.boolean(),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensurePermission(request, reply, "merchant.read")) return;
      const { merchantId } = request.params as { merchantId: string };

      const [m] = await db
        .select({
          webhookUrl: merchants.webhookUrl,
          webhookSecretEnc: merchants.webhookSecretEnc,
        })
        .from(merchants)
        .where(eq(merchants.id, merchantId))
        .limit(1);

      if (!m) {
        return reply.status(404).send({ error: "Not found", message: "Merchant not found" });
      }

      return {
        webhookUrl: m.webhookUrl,
        webhookConfigured: !!(m.webhookUrl && m.webhookSecretEnc),
      };
    }
  );

  app.get(
    "/provider/merchants/:merchantId/users",
    {
      schema: {
        params: z.object({ merchantId: z.string().uuid() }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                email: z.string(),
                role: z.string(),
                status: z.string(),
                mfaEnabled: z.boolean(),
                createdAt: z.string(),
              })
            ),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensurePermission(request, reply, "merchant.read")) return;
      const { merchantId } = request.params as { merchantId: string };
      if (!(await merchantExists(merchantId))) {
        return reply.status(404).send({ error: "Not found", message: "Merchant not found" });
      }

      const rows = await db
        .select({
          id: merchantUsers.id,
          email: merchantUsers.email,
          role: merchantUsers.role,
          status: merchantUsers.status,
          mfaEnabled: merchantUsers.mfaEnabled,
          createdAt: merchantUsers.createdAt,
        })
        .from(merchantUsers)
        .where(eq(merchantUsers.merchantId, merchantId))
        .orderBy(desc(merchantUsers.createdAt));

      return {
        items: rows.map((u) => ({
          id: u.id,
          email: u.email,
          role: u.role,
          status: u.status,
          mfaEnabled: u.mfaEnabled,
          createdAt: u.createdAt.toISOString(),
        })),
      };
    }
  );

  app.get(
    "/provider/merchants/:merchantId/api-keys",
    {
      schema: {
        params: z.object({ merchantId: z.string().uuid() }),
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
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensurePermission(request, reply, "merchant.read")) return;
      const { merchantId } = request.params as { merchantId: string };
      if (!(await merchantExists(merchantId))) {
        return reply.status(404).send({ error: "Not found", message: "Merchant not found" });
      }

      const rows = await db
        .select({
          id: merchantApiKeys.id,
          environment: merchantApiKeys.environment,
          scopes: merchantApiKeys.scopes,
          status: merchantApiKeys.status,
          createdAt: merchantApiKeys.createdAt,
        })
        .from(merchantApiKeys)
        .where(eq(merchantApiKeys.merchantId, merchantId))
        .orderBy(desc(merchantApiKeys.createdAt));

      return {
        items: rows.map((k) => ({
          id: k.id,
          keyMasked: maskApiKeyId(k.id),
          environment: k.environment,
          scopes: k.scopes,
          status: k.status,
          createdAt: k.createdAt.toISOString(),
        })),
      };
    }
  );

  app.patch(
    "/provider/merchants/:merchantId/api-keys/:keyId",
    {
      schema: {
        params: z.object({
          merchantId: z.string().uuid(),
          keyId: z.string().uuid(),
        }),
        body: z.object({
          status: z.literal("revoked"),
          reason: z.string().min(3).max(500).optional(),
        }),
        response: {
          200: z.object({ id: z.string(), status: z.literal("revoked") }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      if (!ensurePermission(request, reply, "merchant.status.write")) return;
      const { merchantId, keyId } = request.params as { merchantId: string; keyId: string };

      const [key] = await db
        .select()
        .from(merchantApiKeys)
        .where(and(eq(merchantApiKeys.id, keyId), eq(merchantApiKeys.merchantId, merchantId)))
        .limit(1);

      if (!key) {
        return reply.status(404).send({ error: "Not found", message: "API key not found" });
      }
      if (key.status === "revoked") {
        return { id: keyId, status: "revoked" as const };
      }

      await db
        .update(merchantApiKeys)
        .set({ status: "revoked" })
        .where(eq(merchantApiKeys.id, keyId));

      invalidateMerchantApiKeyCache(key.keyHash);

      providerMerchantAudit(request, {
        action: "portal.api_key.revoked",
        merchantId,
        resource: keyId,
        meta: {
          environment: key.environment,
          reason: (request.body as { reason?: string }).reason ?? null,
          revokedByProvider: true,
        },
      });

      return { id: keyId, status: "revoked" as const };
    }
  );
}
