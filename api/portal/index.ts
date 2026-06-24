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
import { registerPortalMfaRoutes } from "./mfa.js";
import { registerPortalWebhookRoutes } from "./webhook.js";
import { registerPortalApiIpRulesRoutes } from "./api-ip-rules.js";
import { registerPortalEurPayoutRoutes } from "./eur-payouts.js";
import { registerPortalPayinsRoutes } from "./payins.js";
import { registerPortalAuditLogRoutes } from "./audit-log.js";

export async function registerPortalRoutes(app: FastifyInstance) {
  await registerPortalAuthRoutes(app);
  await registerPortalMfaRoutes(app);
  await registerPortalMeRoutes(app);
  await registerPortalKycRoutes(app);
  await registerPortalApiKeysRoutes(app);
  await registerPortalWebhookRoutes(app);
  await registerPortalApiIpRulesRoutes(app);
  await registerPortalEurPayoutRoutes(app);
  await registerPortalCustomersRoutes(app);
  await registerPortalTransactionsRoutes(app);
  await registerPortalPayinsRoutes(app);
  await registerPortalAuditLogRoutes(app);
}
