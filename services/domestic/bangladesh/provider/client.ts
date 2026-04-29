/**
 * Payok HTTP client – signed requests for pay-in, payout, balance.
 */
import {
  PAYOK_CIRCUIT_KEY,
  assertCircuitClosed,
  recordProviderFailure,
  recordProviderSuccess,
} from "../../../../src/lib/provider-circuit-breaker.js";
import { getPayokConfig } from "./config.js";
import { getPayokConfigForEnvironment, type PayokEnvironment } from "./config.js";
import { signPayokRequest } from "./signature.js";

const PAYIN_BASE = "/api-pay/payment/V3.5";
const PAYOUT_BASE = "/api-pay/remit/V3.5";

function formatRequestTime(): string {
  return new Date().toISOString();
}

async function payokPost<T = unknown>(
  path: string,
  body: object,
  environment?: PayokEnvironment
): Promise<{ status: number; body: T }> {
  assertCircuitClosed(PAYOK_CIRCUIT_KEY);

  const config = environment ? getPayokConfigForEnvironment(environment) : getPayokConfig();
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}${path}`;

  // Per Payok: stringify and remove spaces before signing. JSON.stringify produces compact output.
  const jsonBody = JSON.stringify(body);
  const sign = signPayokRequest(jsonBody, path, config.privateKey);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=utf-8", sign },
      body: jsonBody,
    });
  } catch (err) {
    recordProviderFailure(PAYOK_CIRCUIT_KEY);
    const msg = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause ? (err.cause instanceof Error ? err.cause.message : String(err.cause)) : "";
    throw new Error(`Payok request failed: ${msg}${cause ? `. ${cause}` : ""} (URL: ${url})`);
  }

  const text = await res.text();
  let bodyParsed: T;
  try {
    bodyParsed = (text ? JSON.parse(text) : {}) as T;
  } catch {
    bodyParsed = { raw: text } as T;
  }

  if (res.status >= 500) {
    recordProviderFailure(PAYOK_CIRCUIT_KEY);
  } else {
    recordProviderSuccess(PAYOK_CIRCUIT_KEY);
  }

  return { status: res.status, body: bodyParsed };
}

/** Balance inquiry */
export async function payokBalanceQuery(environment?: PayokEnvironment) {
  const config = environment ? getPayokConfigForEnvironment(environment) : getPayokConfig();
  return payokPost<{ code: string; availableBalance?: string; [k: string]: unknown }>(
    `${PAYOUT_BASE}/balance/query`,
    {
      requestTime: formatRequestTime(),
      merchantId: config.merchantId,
    },
    environment
  );
}

/** Pay-in: Create order (API) */
export async function payokPayinCreateOrder(params: {
  environment?: PayokEnvironment;
  merchantOrderId: string;
  amount: string;
  paymentMethodCode: string;
  notificationUrl: string;
  returnUrl?: string;
  customer: { name: string; email: string; phone: string; deviceId: string };
  goodsInfo: { name: string; id?: string; price?: string };
}) {
  const config = params.environment ? getPayokConfigForEnvironment(params.environment) : getPayokConfig();
  return payokPost(`${PAYIN_BASE}/order/create-api`, {
    requestTime: formatRequestTime(),
    merchantId: config.merchantId,
    paymentMethodCode: params.paymentMethodCode,
    countryCode: "BD",
    merchantOrderId: params.merchantOrderId,
    amount: params.amount,
    currency: "BDT",
    notificationUrl: params.notificationUrl,
    returnUrl: params.returnUrl,
    language: "EN",
    customer: params.customer,
    goodsInfo: params.goodsInfo,
  }, params.environment);
}

/** Pay-in: Inquiry status */
export async function payokPayinInquiry(merchantOrderId: string, environment?: PayokEnvironment) {
  const config = environment ? getPayokConfigForEnvironment(environment) : getPayokConfig();
  return payokPost(`${PAYIN_BASE}/order/query`, {
    requestTime: formatRequestTime(),
    merchantId: config.merchantId,
    merchantOrderId,
  }, environment);
}

/** Payout: Bank account inquiry */
export async function payokPayoutAccountInquiry(params: {
  environment?: PayokEnvironment;
  merchantOrderId: string;
  amount: string;
  benificiaryAccountInfo: {
    number: string;
    orgId: string;
    orgCode: string;
    orgName: string;
    holderName: string;
  };
}) {
  const config = params.environment ? getPayokConfigForEnvironment(params.environment) : getPayokConfig();
  return payokPost<{ code: string; inquiryToken?: string; message?: string; [k: string]: unknown }>(
    `${PAYOUT_BASE}/account/inquiry`,
    {
      requestTime: formatRequestTime(),
      merchantId: config.merchantId,
      merchantOrderId: params.merchantOrderId,
      amount: params.amount,
      countryCode: "BD",
      currency: "BDT",
      language: "EN",
      benificiaryAccountInfo: params.benificiaryAccountInfo,
    },
    params.environment
  );
}

/** Payout: Create order */
export async function payokPayoutCreate(params: {
  environment?: PayokEnvironment;
  merchantOrderId: string;
  amount: string;
  inquiryToken: string;
  notificationUrl?: string;
  description?: string;
  benificiaryAccountInfo: {
    number: string;
    orgId: string;
    orgCode: string;
    orgName: string;
    holderName: string;
  };
  cardHolderInfo: { firstName: string; lastName: string; email: string; phone: string };
}) {
  const config = params.environment ? getPayokConfigForEnvironment(params.environment) : getPayokConfig();
  return payokPost(`${PAYOUT_BASE}/order/create`, {
    requestTime: formatRequestTime(),
    merchantId: config.merchantId,
    merchantOrderId: params.merchantOrderId,
    amount: params.amount,
    countryCode: "BD",
    currency: "BDT",
    language: "EN",
    inquiryToken: params.inquiryToken,
    notificationUrl: params.notificationUrl,
    description: params.description,
    benificiaryAccountInfo: params.benificiaryAccountInfo,
    cardHolderInfo: params.cardHolderInfo,
  }, params.environment);
}

/** Payout: Inquiry status */
export async function payokPayoutInquiry(merchantOrderId: string, environment?: PayokEnvironment) {
  const config = environment ? getPayokConfigForEnvironment(environment) : getPayokConfig();
  return payokPost(`${PAYOUT_BASE}/order/query`, {
    requestTime: formatRequestTime(),
    merchantId: config.merchantId,
    merchantOrderId,
  }, environment);
}
