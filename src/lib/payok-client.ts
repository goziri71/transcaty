/**
 * Payok HTTP client – signed requests, balance inquiry.
 */
import { getPayokConfig } from "./payok-config.js";
import { signPayokRequest } from "./payok-signature.js";

const BALANCE_PATH = "/api-pay/remit/V3.5/balance/query";

function formatRequestTime(): string {
  return new Date().toISOString().replace("Z", "Z").slice(0, 24);
}

/**
 * Call Payok balance inquiry. Use to verify API connectivity.
 * @returns Response body and status code
 */
export async function payokBalanceQuery(): Promise<{
  status: number;
  body: unknown;
}> {
  const config = getPayokConfig();
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}${BALANCE_PATH}`;

  const body = {
    requestTime: formatRequestTime(),
    merchantId: config.merchantId,
  };
  const jsonBody = JSON.stringify(body);

  const sign = signPayokRequest(jsonBody, BALANCE_PATH, config.privateKey);

  let res: Response;
  try {
    res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      sign,
    },
    body: jsonBody,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause ? (err.cause instanceof Error ? err.cause.message : String(err.cause)) : "";
    throw new Error(`Payok request failed: ${msg}${cause ? `. ${cause}` : ""} (URL: ${url})`);
  }

  const text = await res.text();
  let bodyParsed: unknown;
  try {
    bodyParsed = text ? JSON.parse(text) : {};
  } catch {
    bodyParsed = { raw: text };
  }

  return { status: res.status, body: bodyParsed };
}
