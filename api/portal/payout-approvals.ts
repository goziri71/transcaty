/**
 * Maker-checker approvals for large merchant-portal payouts (dual control).
 * A pending row here means a payout was queued instead of executed by
 * evaluatePortalPayoutGate (src/lib/payout-approvals.ts) — a different
 * admin/finance user must approve (or reject) it before anything happens.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { portalPayoutApprovalRequests } from "../../src/db/schema/index.js";
import { requirePortalMoneyRole } from "../../src/lib/portal-roles.js";
import { requirePortalStepUp } from "../../src/lib/portal-auth.js";
import { requireMerchantPayoutPin } from "../../src/lib/merchant-payout-pin.js";
import {
  approvePortalPayoutRequest,
  rejectPortalPayoutRequest,
  listPortalPayoutApprovals,
} from "../../src/lib/payout-approvals.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

const approvalItemSchema = z.object({
  id: z.string(),
  rail: z.string(),
  status: z.string(),
  amount: z.string(),
  currency: z.string(),
  environment: z.string(),
  triggerReason: z.string(),
  requestedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

export async function registerPortalPayoutApprovalRoutes(app: FastifyInstance) {
  app.get(
    "/portal/me/payout-approvals",
    {
      schema: {
        querystring: z.object({
          status: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
        response: {
          200: z.object({ items: z.array(approvalItemSchema) }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      if (!(await requirePortalMoneyRole(request, reply))) return;

      const query = request.query as { status?: string; limit?: number };
      return listPortalPayoutApprovals({
        merchantId: user.merchantId,
        status: query.status,
        limit: query.limit,
      });
    }
  );

  app.get(
    "/portal/me/payout-approvals/:id",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: approvalItemSchema.extend({
            lastError: z.string().nullable(),
            rejectedReason: z.string().nullable(),
            executedTransactionId: z.string().nullable(),
          }),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      if (!(await requirePortalMoneyRole(request, reply))) return;

      const { id } = request.params as { id: string };
      const [row] = await db
        .select()
        .from(portalPayoutApprovalRequests)
        .where(
          and(eq(portalPayoutApprovalRequests.id, id), eq(portalPayoutApprovalRequests.merchantId, user.merchantId))
        )
        .limit(1);

      if (!row) {
        return reply.status(404).send({ error: "Not found", message: "Payout approval request not found" });
      }

      return {
        id: row.id,
        rail: row.rail,
        status: row.status,
        amount: row.amount,
        currency: row.currency,
        environment: row.environment,
        triggerReason: row.triggerReason,
        requestedBy: row.requestedBy,
        approvedBy: row.approvedBy,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        lastError: row.lastError,
        rejectedReason: row.rejectedReason,
        executedTransactionId: row.executedTransactionId,
      };
    }
  );

  app.post(
    "/portal/me/payout-approvals/:id/approve",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ pin: z.string() }),
        response: {
          200: z.object({ transactionId: z.string() }),
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      if (!(await requirePortalMoneyRole(request, reply))) return;
      if (!(await requirePortalStepUp(request, reply, "payout_approval.review"))) return;
      const body = request.body as { pin: string };
      if (!(await requireMerchantPayoutPin(request, reply, body.pin))) return;

      const { id } = request.params as { id: string };
      const result = await approvePortalPayoutRequest({
        requestId: id,
        merchantId: user.merchantId,
        approverMerchantUserId: user.merchantUserId,
        approverEmail: user.email,
        reply,
      });

      if (!result.ok) {
        const status =
          result.error === "NOT_FOUND"
            ? 404
            : result.error === "MAKER_CHECKER" || result.error === "EXPIRED"
              ? 403
              : result.error === "ALREADY_PROCESSED"
                ? 409
                : 400;
        return reply.status(status).send({ error: result.error, message: result.message });
      }

      return { transactionId: result.transactionId };
    }
  );

  app.post(
    "/portal/me/payout-approvals/:id/reject",
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ reason: z.string().min(1).max(500) }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          401: errorResponse,
          404: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      if (!(await requirePortalMoneyRole(request, reply))) return;
      if (!(await requirePortalStepUp(request, reply, "payout_approval.review"))) return;

      const { id } = request.params as { id: string };
      const body = request.body as { reason: string };
      const result = await rejectPortalPayoutRequest({
        requestId: id,
        merchantId: user.merchantId,
        rejectorMerchantUserId: user.merchantUserId,
        rejectorEmail: user.email,
        reason: body.reason,
      });

      if (!result.ok) {
        const status = result.error === "NOT_FOUND" ? 404 : 409;
        return reply.status(status).send({
          error: result.error,
          message: result.error === "NOT_FOUND" ? "Payout approval request not found" : "This request is no longer pending",
        });
      }

      return { ok: true as const };
    }
  );
}
