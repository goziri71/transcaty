/**
 * Payok HTTP client – signed requests for pay-in, payout, balance.
 *
 * All outbound traffic flows through {@link outboundFetch} which provides
 * per-call timeouts, retries with jitter, response size caps, and
 * circuit-breaker accounting via {@link getProviderCircuit}.
 *
 * Money safety: payout creation is the only path where a duplicate POST
 * could result in a duplicate debit on the provider side. We send the
 * `Idempotency-Key` header with the merchantOrderId on every retry-able
 * create. Payok already dedupes on merchantOrderId; the header is a
 * belt-and-braces signal for any future provider-side replay guard.
 */
import {
  PAYOK_CIRCUIT_KEY,
  PAYOK_BR_CIRCUIT_KEY,
  getProviderCircuit,
} from "../../../../src/lib/provider-circuit-breaker.js";
import { outboundFetch, parseJsonResult, type ProviderCircuit } from "../../../../src/lib/outbound-http.js";
import { getPayokConfig } from "./config.js";
import { getPayokConfigForEnvironment, type PayokEnvironment } from "./config.js";
import { signPayokRequest } from "./signature.js";

const PAYIN_BASE = "/api-pay/payment/V3.5";
const PAYOUT_BASE = "/api-pay/remit/V3.5";

// One circuit per key, memoized. Bangladesh stays on "payok"; Brazil uses
// "payok-br" so a country-specific outage does not trip the other's breaker.
const circuits = new Map<string, ProviderCircuit>();
function circuitFor(key: string): ProviderCircuit {
  let c = circuits.get(key);
  if (!c) {
    c = getProviderCircuit(key);
    circuits.set(key, c);
  }
  return c;
}

/** Map a request's countryCode to its PayOK circuit key (defaults to Bangladesh). */
function payokCircuitKeyForCountry(countryCode?: string): string {
  return countryCode === "BR" ? PAYOK_BR_CIRCUIT_KEY : PAYOK_CIRCUIT_KEY;
}

function formatRequestTime(): string {
  return new Date().toISOString();
}

interface PayokPostOptions {
  environment?: PayokEnvironment;
  idempotencyKey?: string;
  /** Mutating endpoints (create-order, payout-create) should not retry on
   * 4xx and should send Idempotency-Key. Reads (queries) can retry freely. */
  retryable?: boolean;
  /** Circuit-breaker key; defaults to the shared Bangladesh "payok" key. */
  circuitKey?: string;
}

async function payokPost<T = unknown>(
  path: string,
  body: object,
  options: PayokPostOptions = {}
): Promise<{ status: number; body: T }> {
  const config = options.environment
    ? getPayokConfigForEnvironment(options.environment)
    : getPayokConfig();
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}${path}`;

  // Per Payok: stringify and remove spaces before signing. JSON.stringify produces compact output.
  const jsonBody = JSON.stringify(body);
  const sign = signPayokRequest(jsonBody, path, config.privateKey);

  const result = await outboundFetch(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=utf-8", sign },
      body: jsonBody,
    },
    {
      label: `payok ${path}`,
      circuit: circuitFor(options.circuitKey ?? PAYOK_CIRCUIT_KEY),
      idempotencyKey: options.idempotencyKey,
      // Reads can retry on transient 4xx like 429; mutations also retry on
      // network errors and 5xx but the underlying provider must dedupe.
      retries: options.retryable ? 2 : 1,
    }
  );

  return { status: result.status, body: parseJsonResult<T>(result) };
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
    { environment }
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
  countryCode?: string;
  currency?: string;
  language?: string;
}) {
  const config = params.environment ? getPayokConfigForEnvironment(params.environment) : getPayokConfig();
  return payokPost(
    `${PAYIN_BASE}/order/create-api`,
    {
      requestTime: formatRequestTime(),
      merchantId: config.merchantId,
      paymentMethodCode: params.paymentMethodCode,
      countryCode: params.countryCode ?? "BD",
      merchantOrderId: params.merchantOrderId,
      amount: params.amount,
      currency: params.currency ?? "BDT",
      notificationUrl: params.notificationUrl,
      returnUrl: params.returnUrl,
      language: params.language ?? "EN",
      customer: params.customer,
      goodsInfo: params.goodsInfo,
    },
    {
      environment: params.environment,
      idempotencyKey: params.merchantOrderId,
      retryable: true,
      circuitKey: payokCircuitKeyForCountry(params.countryCode),
    }
  );
}

/** Pay-in: Inquiry status */
export async function payokPayinInquiry(merchantOrderId: string, environment?: PayokEnvironment) {
  const config = environment ? getPayokConfigForEnvironment(environment) : getPayokConfig();
  return payokPost(
    `${PAYIN_BASE}/order/query`,
    {
      requestTime: formatRequestTime(),
      merchantId: config.merchantId,
      merchantOrderId,
    },
    { environment }
  );
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
  countryCode?: string;
  currency?: string;
  language?: string;
}) {
  const config = params.environment ? getPayokConfigForEnvironment(params.environment) : getPayokConfig();
  return payokPost<{ code: string; inquiryToken?: string; message?: string; [k: string]: unknown }>(
    `${PAYOUT_BASE}/account/inquiry`,
    {
      requestTime: formatRequestTime(),
      merchantId: config.merchantId,
      merchantOrderId: params.merchantOrderId,
      amount: params.amount,
      countryCode: params.countryCode ?? "BD",
      currency: params.currency ?? "BDT",
      language: params.language ?? "EN",
      benificiaryAccountInfo: params.benificiaryAccountInfo,
    },
    {
      environment: params.environment,
      idempotencyKey: params.merchantOrderId,
      retryable: true,
      circuitKey: payokCircuitKeyForCountry(params.countryCode),
    }
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
  countryCode?: string;
  currency?: string;
  language?: string;
}) {
  const config = params.environment ? getPayokConfigForEnvironment(params.environment) : getPayokConfig();
  return payokPost(
    `${PAYOUT_BASE}/order/create`,
    {
      requestTime: formatRequestTime(),
      merchantId: config.merchantId,
      merchantOrderId: params.merchantOrderId,
      amount: params.amount,
      countryCode: params.countryCode ?? "BD",
      currency: params.currency ?? "BDT",
      language: params.language ?? "EN",
      inquiryToken: params.inquiryToken,
      notificationUrl: params.notificationUrl,
      description: params.description,
      benificiaryAccountInfo: params.benificiaryAccountInfo,
      cardHolderInfo: params.cardHolderInfo,
    },
    {
      environment: params.environment,
      idempotencyKey: params.merchantOrderId,
      retryable: true,
      circuitKey: payokCircuitKeyForCountry(params.countryCode),
    }
  );
}

/** Payout: Inquiry status */
export async function payokPayoutInquiry(merchantOrderId: string, environment?: PayokEnvironment) {
  const config = environment ? getPayokConfigForEnvironment(environment) : getPayokConfig();
  return payokPost(
    `${PAYOUT_BASE}/order/query`,
    {
      requestTime: formatRequestTime(),
      merchantId: config.merchantId,
      merchantOrderId,
    },
    { environment }
  );
}
