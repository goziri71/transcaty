/**
 * Portal API: merchant dashboard routes.
 * Auth: JWT (portal) for /portal/me/*, no auth for /portal/auth/signup|login|logout.
 * PreHandler for portal auth is registered in app.ts.
 */
import type { FastifyInstance } from "fastify";
import { registerPortalAuthRoutes } from "./auth.js";
import { registerPortalMeRoutes } from "./me.js";
import { registerPortalKycRoutes } from "./kyc.js";
import { registerPortalApiKeysRoutes } from "./api-keys.js";
import { registerPortalCustomersRoutes } from "./customers.js";
import { registerPortalTransactionsRoutes } from "./transactions.js";

export async function registerPortalRoutes(app: FastifyInstance) {
  await registerPortalAuthRoutes(app);
  await registerPortalMeRoutes(app);
  await registerPortalKycRoutes(app);
  await registerPortalApiKeysRoutes(app);
  await registerPortalCustomersRoutes(app);
  await registerPortalTransactionsRoutes(app);
}
