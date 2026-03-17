/**
 * Portal KYC routes: business, persons, documents, submit.
 * Same as v1/me/kyc/* but uses portal JWT auth.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  merchantBusinessProfiles,
  merchantPersons,
  merchantKycDocuments,
} from "../../src/db/schema/index.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

export async function registerPortalKycRoutes(app: FastifyInstance) {
  app.put(
    "/portal/me/kyc/business",
    {
      schema: {
        body: z.object({
          legalName: z.string().min(1),
          tradingName: z.string().optional(),
          businessType: z.string().min(1),
          registrationNumber: z.string().optional(),
          incorporationDate: z.string().datetime().optional(),
          industry: z.string().optional(),
          registeredAddress: z.string().min(1),
          operatingAddress: z.string().optional(),
          taxId: z.string().optional(),
          contactPhone: z.string().min(1),
          contactEmail: z.string().email(),
        }),
        response: {
          200: z.object({ id: z.string(), status: z.string() }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const body = request.body as {
        legalName: string;
        tradingName?: string;
        businessType: string;
        registrationNumber?: string;
        incorporationDate?: string;
        industry?: string;
        registeredAddress: string;
        operatingAddress?: string;
        taxId?: string;
        contactPhone: string;
        contactEmail: string;
      };

      const [existing] = await db
        .select()
        .from(merchantBusinessProfiles)
        .where(eq(merchantBusinessProfiles.merchantId, user.merchantId))
        .limit(1);

      const data = {
        legalName: body.legalName,
        tradingName: body.tradingName ?? null,
        businessType: body.businessType,
        registrationNumber: body.registrationNumber ?? null,
        incorporationDate: body.incorporationDate ? new Date(body.incorporationDate) : null,
        industry: body.industry ?? null,
        registeredAddress: body.registeredAddress,
        operatingAddress: body.operatingAddress ?? null,
        taxId: body.taxId ?? null,
        contactPhone: body.contactPhone,
        contactEmail: body.contactEmail,
        updatedAt: new Date(),
      };

      if (existing) {
        await db
          .update(merchantBusinessProfiles)
          .set(data)
          .where(eq(merchantBusinessProfiles.id, existing.id));
        return { id: existing.id, status: existing.status };
      }

      const [inserted] = await db
        .insert(merchantBusinessProfiles)
        .values({ merchantId: user.merchantId, ...data })
        .returning({ id: merchantBusinessProfiles.id, status: merchantBusinessProfiles.status });
      return { id: inserted!.id, status: inserted!.status };
    }
  );

  app.post(
    "/portal/me/kyc/persons",
    {
      schema: {
        body: z.object({
          role: z.enum(["director", "ubo", "authorized_signatory"]),
          fullName: z.string().min(1),
          nationality: z.string().min(1),
          dateOfBirth: z.string().datetime().optional(),
          idType: z.enum(["nid", "passport"]),
          idNumber: z.string().min(1),
          address: z.string().min(1),
          ownershipPercentage: z.number().min(0).max(100).optional(),
        }),
        response: {
          200: z.object({ id: z.string() }),
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const body = request.body as {
        role: "director" | "ubo" | "authorized_signatory";
        fullName: string;
        nationality: string;
        dateOfBirth?: string;
        idType: "nid" | "passport";
        idNumber: string;
        address: string;
        ownershipPercentage?: number;
      };

      const [inserted] = await db
        .insert(merchantPersons)
        .values({
          merchantId: user.merchantId,
          role: body.role,
          fullName: body.fullName,
          nationality: body.nationality,
          dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : null,
          idType: body.idType,
          idNumber: body.idNumber,
          address: body.address,
          ownershipPercentage: body.ownershipPercentage != null ? String(body.ownershipPercentage) : null,
        })
        .returning({ id: merchantPersons.id });
      return { id: inserted!.id };
    }
  );

  app.get(
    "/portal/me/kyc/persons",
    {
      schema: {
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                role: z.string(),
                fullName: z.string(),
                status: z.string(),
              })
            ),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const rows = await db
        .select({
          id: merchantPersons.id,
          role: merchantPersons.role,
          fullName: merchantPersons.fullName,
          status: merchantPersons.status,
        })
        .from(merchantPersons)
        .where(eq(merchantPersons.merchantId, user.merchantId));

      return {
        items: rows.map((r) => ({
          id: r.id,
          role: r.role,
          fullName: r.fullName,
          status: r.status,
        })),
      };
    }
  );

  app.post(
    "/portal/me/kyc/documents",
    {
      schema: {
        body: z.object({
          documentType: z.string().min(1),
          fileReference: z.string().min(1),
          documentNumber: z.string().optional(),
          merchantPersonId: z.string().uuid().optional(),
        }),
        response: {
          200: z.object({ id: z.string() }),
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const body = request.body as {
        documentType: string;
        fileReference: string;
        documentNumber?: string;
        merchantPersonId?: string;
      };

      if (body.merchantPersonId) {
        const [person] = await db
          .select()
          .from(merchantPersons)
          .where(
            and(
              eq(merchantPersons.id, body.merchantPersonId),
              eq(merchantPersons.merchantId, user.merchantId)
            )
          )
          .limit(1);
        if (!person) {
          return reply.status(400).send({ error: "Invalid merchantPersonId" });
        }
      }

      const [inserted] = await db
        .insert(merchantKycDocuments)
        .values({
          merchantId: user.merchantId,
          documentType: body.documentType,
          fileReference: body.fileReference,
          documentNumber: body.documentNumber ?? null,
          merchantPersonId: body.merchantPersonId ?? null,
        })
        .returning({ id: merchantKycDocuments.id });
      return { id: inserted!.id };
    }
  );

  app.get(
    "/portal/me/kyc/documents",
    {
      schema: {
        response: {
          200: z.object({
            items: z.array(
              z.object({
                id: z.string(),
                documentType: z.string(),
                status: z.string(),
                submittedAt: z.string(),
              })
            ),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const rows = await db
        .select({
          id: merchantKycDocuments.id,
          documentType: merchantKycDocuments.documentType,
          status: merchantKycDocuments.status,
          submittedAt: merchantKycDocuments.submittedAt,
        })
        .from(merchantKycDocuments)
        .where(eq(merchantKycDocuments.merchantId, user.merchantId));

      return {
        items: rows.map((r) => ({
          id: r.id,
          documentType: r.documentType,
          status: r.status,
          submittedAt: r.submittedAt.toISOString(),
        })),
      };
    }
  );

  app.post(
    "/portal/me/kyc/submit",
    {
      schema: {
        response: {
          200: z.object({ status: z.string() }),
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });

      const [profile] = await db
        .select()
        .from(merchantBusinessProfiles)
        .where(eq(merchantBusinessProfiles.merchantId, user.merchantId))
        .limit(1);

      if (!profile) {
        return reply.status(400).send({
          error: "Business profile required before submit",
        });
      }
      if (profile.status === "verified") {
        return reply.status(400).send({ error: "Already verified" });
      }

      await db
        .update(merchantBusinessProfiles)
        .set({ status: "submitted", updatedAt: new Date() })
        .where(eq(merchantBusinessProfiles.id, profile.id));

      return { status: "submitted" };
    }
  );
}
