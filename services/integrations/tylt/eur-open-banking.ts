/**
 * TL Pay EU Open Banking (Prime Fiat v2): shared webhook parsing and instance details.
 * @see https://docs.tylt.money/introduction/tylt-crossramp-fiat-crypto-solutions/eu-open-banking
 */
import { normalizeMoneyAmountToTwoDecimals } from "../../../src/lib/money.js";
import { tyltSignedGetJson } from "./client.js";
import type { TyltMerchantEnvironment } from "./config.js";

export const TYLT_PRODUCT_EUR_PAYIN = "eur_payin";
export const TYLT_PRODUCT_EUR_PAYOUT = "eur_payout";

const EUR_PAYIN_SUCCESS_EVENT_IDS = new Set([5]);
const EUR_PAYIN_FAILURE_EVENT_IDS = new Set([8, 9, 10]);
const EUR_PAYOUT_SUCCESS_EVENT_IDS = new Set([5]);
const EUR_PAYOUT_FAILURE_EVENT_IDS = new Set([8, 9, 10]);

export type EurOpenBankingTerminalDecision = "success" | "failed" | "non_terminal" | "unknown";

export function extractEurOpenBankingData(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  const data = (root.data ?? root.result ?? root.payload ?? root) as Record<string, unknown>;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return data;
}

export function parseEurMerchantOrderId(payload: unknown): string | undefined {
  const data = extractEurOpenBankingData(payload);
  if (!data) return undefined;
  const id = data.merchantOrderId;
  if (typeof id === "string" && id.trim()) return id.trim();
  return undefined;
}

export function parseEurEventId(payload: unknown): number | undefined {
  const data = extractEurOpenBankingData(payload);
  if (!data) return undefined;
  const eventDetails = data.eventDetails as Record<string, unknown> | undefined;
  const raw = eventDetails?.eventId ?? data.eventId ?? data.event_id;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return parseInt(raw.trim(), 10);
  return undefined;
}

export function parseEurIsBuying(payload: unknown): number | undefined {
  const data = extractEurOpenBankingData(payload);
  if (!data) return undefined;
  const raw = data.isBuying;
  if (raw === 0 || raw === 1) return raw;
  if (typeof raw === "string" && (raw === "0" || raw === "1")) return parseInt(raw, 10);
  return undefined;
}

export function parseEurAccounts(payload: unknown): Record<string, unknown> | null {
  const data = extractEurOpenBankingData(payload);
  if (!data) return null;
  const accounts = data.accounts;
  if (accounts && typeof accounts === "object" && !Array.isArray(accounts)) {
    return accounts as Record<string, unknown>;
  }
  return null;
}

export function parseEurCreditAmount(payload: unknown, fallbackAmount: string): string {
  const accounts = parseEurAccounts(payload);
  const raw =
    pickAmount(accounts?.cryptoAmount) ??
    pickAmount(accounts?.settledAmountCredited) ??
    fallbackAmount;
  return normalizeMoneyAmountToTwoDecimals(raw);
}

function pickAmount(v: unknown): string | null {
  if (typeof v === "string" && v.trim() && Number.isFinite(parseFloat(v))) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

export function classifyEurPayinDecision(eventId: number | undefined): EurOpenBankingTerminalDecision {
  if (eventId == null) return "unknown";
  if (EUR_PAYIN_SUCCESS_EVENT_IDS.has(eventId)) return "success";
  if (EUR_PAYIN_FAILURE_EVENT_IDS.has(eventId)) return "failed";
  if (eventId >= 1 && eventId <= 4) return "non_terminal";
  if (eventId === 6 || eventId === 7) return "non_terminal";
  return "unknown";
}

export function classifyEurPayoutDecision(eventId: number | undefined): EurOpenBankingTerminalDecision {
  if (eventId == null) return "unknown";
  if (EUR_PAYOUT_SUCCESS_EVENT_IDS.has(eventId)) return "success";
  if (EUR_PAYOUT_FAILURE_EVENT_IDS.has(eventId)) return "failed";
  if (eventId === 11) return "non_terminal";
  if (eventId >= 1 && eventId <= 4) return "non_terminal";
  return "unknown";
}

export async function fetchEurInstanceDetails(params: {
  environment: TyltMerchantEnvironment;
  merchantOrderId: string;
}): Promise<{ status: number; json: unknown }> {
  return tyltSignedGetJson({
    environment: params.environment,
    path: "/v2/prime-fiat/instance/details",
    queryParams: { merchantOrderId: params.merchantOrderId },
    credentialProfile: "eur_payin",
  });
}

export function extractEurCreateInstanceResponse(json: unknown): {
  instanceId: string;
  checkoutUrl: string;
  cryptoAmount: string | null;
  rate: number | null;
  fiatCurrency: string | null;
} {
  const root = json as Record<string, unknown>;
  const data = (root.data ?? root.result ?? root) as Record<string, unknown>;
  const instanceId = String(data.instanceId ?? data.instance_id ?? "").trim();
  const checkoutUrl = String(data.url ?? data.checkoutUrl ?? "").trim();
  const cryptoRaw = data.cryptoAmount ?? data.crypto_amount;
  const cryptoAmount =
    typeof cryptoRaw === "number" && Number.isFinite(cryptoRaw)
      ? String(cryptoRaw)
      : typeof cryptoRaw === "string" && cryptoRaw.trim()
        ? cryptoRaw.trim()
        : null;
  const rateRaw = data.rate;
  const rate =
    typeof rateRaw === "number" && Number.isFinite(rateRaw)
      ? rateRaw
      : typeof rateRaw === "string" && Number.isFinite(parseFloat(rateRaw))
        ? parseFloat(rateRaw)
        : null;
  const fiatCurrency = String(data.fiatCurrencySymbol ?? data.fiatCurrency ?? "").trim() || null;
  return { instanceId, checkoutUrl, cryptoAmount, rate, fiatCurrency };
}

export function extractEurInstanceDetailsView(json: unknown): Record<string, unknown> | null {
  const root = json as Record<string, unknown>;
  const data = (root.data ?? root.result ?? root) as Record<string, unknown>;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return data;
}
