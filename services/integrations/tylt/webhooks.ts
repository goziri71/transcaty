/**
 * Tylt webhook helpers: shared signature verification and routing by stored transaction metadata (`rail` / `tyltProduct`).
 */
import { eq } from "drizzle-orm";
import { db } from "../../../src/db/index.js";
import { transactions } from "../../../src/db/schema/index.js";
import type { WebhookEvent } from "../../../src/lib/merchant-webhook.js";
import {
  applyTyltCrossRampWebhookPayload,
  parseCrossRampMerchantOrderId,
  parseTransactionMetadata,
  TYLT_PRODUCT_CROSSRAMP,
  TYLT_PRODUCT_H2H_UPI,
} from "./crossramp-payin.js";
import { applyTyltCpgPayinWebhookPayload, extractCpgPayInWebhookFields, TYLT_PRODUCT_CPG_PAYIN } from "./cpg-payin.js";
import { applyTyltCpgPayoutWebhookPayload, extractCpgPayOutWebhookFields, TYLT_PRODUCT_CPG_PAYOUT } from "./cpg-payout.js";
import { getTyltConfig, type TyltMerchantEnvironment } from "./config.js";
import { verifyTyltSignature } from "./sign.js";

/** Prefer structured CrossRamp shape first, then CPG extractors (merchant order id is our transactions.id). */
export function extractTyltWebhookMerchantOrderId(parsed: unknown): string | undefined {
  const cross = parseCrossRampMerchantOrderId(parsed)?.trim();
  if (cross) return cross;
  const payinId = extractCpgPayInWebhookFields(parsed).merchantOrderId?.trim();
  if (payinId) return payinId;
  const payoutId = extractCpgPayOutWebhookFields(parsed).merchantOrderId?.trim();
  if (payoutId) return payoutId;
  return undefined;
}

export function readTyltWebhookSignatureHeader(headers: {
  [k: string]: string | string[] | undefined;
}): string | undefined {
  const lower = headers["x-tlp-signature"];
  const upper = headers["X-TLP-SIGNATURE"];
  const raw =
    (typeof lower === "string" ? lower : Array.isArray(lower) ? lower[0] : undefined) ??
    (typeof upper === "string" ? upper : Array.isArray(upper) ? upper[0] : undefined);
  const s = raw?.trim();
  return s || undefined;
}

export function verifyTyltWebhookSignature(
  environment: string,
  rawBody: string,
  signatureHeader: string | undefined
): boolean {
  if (environment !== "test" && environment !== "live") return false;
  const cfg = getTyltConfig(environment as TyltMerchantEnvironment);
  if (!cfg) return false;
  return verifyTyltSignature(cfg.apiSecret, rawBody, signatureHeader);
}

export type TyltWebhookProductRoute = "crossramp_upi" | "cpg_payin" | "cpg_payout";

/** Explicit URL-based routing (legacy callbacks): delegates to the matching processor. */
export async function applyTyltWebhookByProductRoute(
  route: TyltWebhookProductRoute,
  parsed: unknown
): Promise<{ merchantId: string; event: WebhookEvent } | null> {
  switch (route) {
    case "crossramp_upi":
      return applyTyltCrossRampWebhookPayload(parsed);
    case "cpg_payin":
      return applyTyltCpgPayinWebhookPayload(parsed);
    case "cpg_payout":
      return applyTyltCpgPayoutWebhookPayload(parsed);
    default:
      return null;
  }
}

/**
 * Route using persisted metadata on `transactions` (fail-safe: unknown → null → caller still acks `ok`).
 */
export async function applyTyltWebhookByStoredRailProduct(
  parsed: unknown
): Promise<{ merchantId: string; event: WebhookEvent } | null> {
  const orderId = extractTyltWebhookMerchantOrderId(parsed);
  if (!orderId) return null;

  const [tx] = await db.select().from(transactions).where(eq(transactions.id, orderId)).limit(1);
  if (!tx) return null;

  const meta = parseTransactionMetadata(tx);
  if (meta.rail !== "tylt") return null;

  const product = String(meta.tyltProduct ?? "");

  if (product === TYLT_PRODUCT_CPG_PAYIN) return applyTyltCpgPayinWebhookPayload(parsed);
  if (product === TYLT_PRODUCT_CPG_PAYOUT) return applyTyltCpgPayoutWebhookPayload(parsed);
  if (product === TYLT_PRODUCT_CROSSRAMP || product === TYLT_PRODUCT_H2H_UPI) {
    return applyTyltCrossRampWebhookPayload(parsed);
  }

  return null;
}
