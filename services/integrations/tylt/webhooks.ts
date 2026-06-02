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
  selectPayinTxByMerchantOrderRef,
  TYLT_PRODUCT_CROSSRAMP,
  TYLT_PRODUCT_H2H_UPI,
} from "./crossramp-payin.js";
import { applyTyltCpgPayinWebhookPayload, extractCpgPayInWebhookFields, TYLT_PRODUCT_CPG_PAYIN } from "./cpg-payin.js";
import { applyTyltCpgPayoutWebhookPayload, extractCpgPayOutWebhookFields, TYLT_PRODUCT_CPG_PAYOUT } from "./cpg-payout.js";
import { applyTyltEurPayinWebhookPayload, TYLT_PRODUCT_EUR_PAYIN } from "./eur-payin.js";
import { applyTyltEurPayoutWebhookPayload, TYLT_PRODUCT_EUR_PAYOUT } from "./eur-payout.js";
import { parseEurMerchantOrderId } from "./eur-open-banking.js";
import {
  getTyltCredentials,
  getTyltCredentialsForProfile,
  TYLT_PAYIN_PROFILE_VERIFY_ORDER,
  TYLT_PAYOUT_PROFILE_VERIFY_ORDER,
  type TyltCredentialProfile,
  type TyltCredentialRole,
  type TyltMerchantEnvironment,
} from "./config.js";
import { verifyTyltSignature } from "./sign.js";

/** Prefer structured CrossRamp shape first, then CPG extractors. Ref may be `transactions.id` or H2H `metadata.tyltMerchantOrderId`. */
export function extractTyltWebhookMerchantOrderId(parsed: unknown): string | undefined {
  const cross = parseCrossRampMerchantOrderId(parsed)?.trim();
  if (cross) return cross;
  const payinId = extractCpgPayInWebhookFields(parsed).merchantOrderId?.trim();
  if (payinId) return payinId;
  const payoutId = extractCpgPayOutWebhookFields(parsed).merchantOrderId?.trim();
  if (payoutId) return payoutId;
  const eurId = parseEurMerchantOrderId(parsed)?.trim();
  if (eurId) return eurId;
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

export type TyltWebhookCredentialMode = TyltCredentialProfile | TyltCredentialRole | "unified";

function verifyWithConfiguredSecrets(
  rawBody: string,
  signatureHeader: string,
  configs: Array<ReturnType<typeof getTyltCredentialsForProfile>>
): boolean {
  for (const cfg of configs) {
    if (cfg && verifyTyltSignature(cfg.apiSecret, rawBody, signatureHeader)) return true;
  }
  return false;
}

/**
 * Verify webhook HMAC using the Tylt secret for the matching product lane.
 * Use `unified` when one URL receives multiple products: tries EU then India
 * pay-in secrets, then pay-out secrets, then generic PAYIN_/PAYOUT_ fallbacks.
 */
export function verifyTyltWebhookSignature(
  environment: string,
  rawBody: string,
  signatureHeader: string | undefined,
  credentialMode: TyltWebhookCredentialMode = "india_payin"
): boolean {
  if (environment !== "test" && environment !== "live") return false;
  const env = environment as TyltMerchantEnvironment;
  if (!signatureHeader?.trim()) return false;

  if (credentialMode === "unified") {
    const profileConfigs = [
      ...TYLT_PAYIN_PROFILE_VERIFY_ORDER,
      ...TYLT_PAYOUT_PROFILE_VERIFY_ORDER,
    ].map((p) => getTyltCredentialsForProfile(env, p));
    if (verifyWithConfiguredSecrets(rawBody, signatureHeader, profileConfigs)) return true;
    return verifyWithConfiguredSecrets(rawBody, signatureHeader, [
      getTyltCredentials(env, "payin"),
      getTyltCredentials(env, "payout"),
    ]);
  }

  if (credentialMode === "payin" || credentialMode === "payout") {
    const cfg = getTyltCredentials(env, credentialMode);
    if (!cfg) return false;
    return verifyTyltSignature(cfg.apiSecret, rawBody, signatureHeader);
  }

  const cfg = getTyltCredentialsForProfile(env, credentialMode);
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

  const [txById] = await db.select().from(transactions).where(eq(transactions.id, orderId)).limit(1);
  const tx = txById ?? (await selectPayinTxByMerchantOrderRef(orderId));
  if (!tx) return null;

  const meta = parseTransactionMetadata(tx);
  if (meta.rail !== "tylt") return null;

  const product = String(meta.tyltProduct ?? "");

  if (product === TYLT_PRODUCT_CPG_PAYIN) return applyTyltCpgPayinWebhookPayload(parsed);
  if (product === TYLT_PRODUCT_CPG_PAYOUT) return applyTyltCpgPayoutWebhookPayload(parsed);
  if (product === TYLT_PRODUCT_CROSSRAMP || product === TYLT_PRODUCT_H2H_UPI) {
    return applyTyltCrossRampWebhookPayload(parsed);
  }
  if (product === TYLT_PRODUCT_EUR_PAYIN) return applyTyltEurPayinWebhookPayload(parsed);
  if (product === TYLT_PRODUCT_EUR_PAYOUT) return applyTyltEurPayoutWebhookPayload(parsed);

  return null;
}
