/**
 * Merchant payout PIN: set, change, and status (admin + step-up for writes).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePortalAdminRole } from "../../src/lib/portal-roles.js";
import { requirePortalStepUp } from "../../src/lib/portal-auth.js";
import {
  changeMerchantPayoutPin,
  getMerchantPayoutPinStatus,
  portalPayoutPinSchema,
  setMerchantPayoutPin,
} from "../../src/lib/merchant-payout-pin.js";
import { resetMerchantPayoutPinWithToken } from "../../src/lib/payout-pin-reset.js";

const errorResponse = z.object({
  error: z.string(),
  message: z.string().optional(),
});

export async function registerPortalPayoutPinRoutes(app: FastifyInstance) {
  app.get(
    "/portal/me/payout-pin",
    {
      schema: {
        response: {
          200: z.object({
            configured: z.boolean(),
            lockedUntil: z.string().nullable(),
          }),
          401: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      return getMerchantPayoutPinStatus(user.merchantId);
    }
  );

  app.post(
    "/portal/me/payout-pin",
    {
      schema: {
        body: z.object({
          pin: portalPayoutPinSchema,
          confirmPin: portalPayoutPinSchema,
        }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      if (!(await requirePortalAdminRole(request, reply))) return;
      if (!(await requirePortalStepUp(request, reply, "payout_pin.write"))) return;

      const body = request.body as { pin: string; confirmPin: string };
      if (body.pin !== body.confirmPin) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "PIN and confirmation do not match",
        });
      }

      const status = await getMerchantPayoutPinStatus(user.merchantId);
      if (status.configured) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Payout PIN is already set. Use PATCH to change it or request an email reset.",
        });
      }

      await setMerchantPayoutPin({
        merchantId: user.merchantId,
        pin: body.pin,
        merchantUserId: user.merchantUserId,
        actorEmail: user.email,
      });
      return { ok: true as const };
    }
  );

  app.patch(
    "/portal/me/payout-pin",
    {
      schema: {
        body: z.object({
          currentPin: portalPayoutPinSchema,
          newPin: portalPayoutPinSchema,
          confirmPin: portalPayoutPinSchema,
        }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      if (!(await requirePortalAdminRole(request, reply))) return;
      if (!(await requirePortalStepUp(request, reply, "payout_pin.write"))) return;

      const body = request.body as {
        currentPin: string;
        newPin: string;
        confirmPin: string;
      };
      if (body.newPin !== body.confirmPin) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "New PIN and confirmation do not match",
        });
      }
      if (body.currentPin === body.newPin) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "New PIN must differ from the current PIN",
        });
      }

      const result = await changeMerchantPayoutPin({
        merchantId: user.merchantId,
        currentPin: body.currentPin,
        newPin: body.newPin,
        merchantUserId: user.merchantUserId,
        actorEmail: user.email,
      });

      if (result === "not_configured") {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Payout PIN is not set yet. Use POST to create one.",
        });
      }
      if (result === "locked") {
        return reply.status(403).send({
          error: "Forbidden",
          message: "Payout PIN is temporarily locked due to failed attempts",
        });
      }
      if (result === "invalid_pin") {
        return reply.status(403).send({
          error: "Forbidden",
          message: "Current payout PIN is incorrect",
        });
      }

      return { ok: true as const };
    }
  );

  app.post(
    "/portal/me/payout-pin/reset",
    {
      schema: {
        body: z.object({
          token: z.string().min(1),
          newPin: portalPayoutPinSchema,
          confirmPin: portalPayoutPinSchema,
        }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const user = request.portalUser;
      if (!user) return reply.status(401).send({ error: "Unauthorized" });
      if (!(await requirePortalAdminRole(request, reply))) return;
      if (!(await requirePortalStepUp(request, reply, "payout_pin.write"))) return;

      const body = request.body as { token: string; newPin: string; confirmPin: string };
      if (body.newPin !== body.confirmPin) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "New PIN and confirmation do not match",
        });
      }

      const result = await resetMerchantPayoutPinWithToken({
        merchantId: user.merchantId,
        merchantUserId: user.merchantUserId,
        actorEmail: user.email,
        rawToken: body.token,
        newPin: body.newPin,
      });

      if (!result.ok) {
        return reply.status(400).send({ error: "Bad Request", message: result.reason });
      }

      return { ok: true as const };
    }
  );
}
