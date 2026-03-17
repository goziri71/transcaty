/**
 * Payok HTTP client – signed requests for pay-in, payout, balance.
 */
import { getPayokConfig } from "./config.js";
import { signPayokRequest } from "./signature.js";

const PAYIN_BASE = "/api-pay/payment/V3.5";
const PAYOUT_BASE = "/api-pay/remit/V3.5";

function formatRequestTime(): string {
  return new Date().toISOString();
}

async function payokPost<T = unknown>(path: string, body: object): Promise<{ status: number; body: T }> {
  const config = getPayokConfig();
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

  return { status: res.status, body: bodyParsed };
}

/** Balance inquiry */
export async function payokBalanceQuery() {
  return payokPost<{ code: string; availableBalance?: string; [k: string]: unknown }>(
    `${PAYOUT_BASE}/balance/query`,
    {
      requestTime: formatRequestTime(),
      merchantId: getPayokConfig().merchantId,
    }
  );
}

/** Pay-in: Create order (API) */
export async function payokPayinCreateOrder(params: {
  merchantOrderId: string;
  amount: string;
  paymentMethodCode: string;
  notificationUrl: string;
  returnUrl?: string;
  customer: { name: string; email: string; phone: string; deviceId: string };
  goodsInfo: { name: string; id?: string; price?: string };
}) {
  const config = getPayokConfig();
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
  });
}

/** Pay-in: Inquiry status */
export async function payokPayinInquiry(merchantOrderId: string) {
  const config = getPayokConfig();
  return payokPost(`${PAYIN_BASE}/order/query`, {
    requestTime: formatRequestTime(),
    merchantId: config.merchantId,
    merchantOrderId,
  });
}

/** Payout: Bank account inquiry */
export async function payokPayoutAccountInquiry(params: {
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
  const config = getPayokConfig();
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
    }
  );
}

/** Payout: Create order */
export async function payokPayoutCreate(params: {
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
  const config = getPayokConfig();
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
  });
}

/** Payout: Inquiry status */
export async function payokPayoutInquiry(merchantOrderId: string) {
  const config = getPayokConfig();
  return payokPost(`${PAYOUT_BASE}/order/query`, {
    requestTime: formatRequestTime(),
    merchantId: config.merchantId,
    merchantOrderId,
  });
}
