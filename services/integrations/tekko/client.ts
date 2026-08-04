/**
 * Signed HTTP client for Tekko Platform API.
 */
import {
  TEKKO_CIRCUIT_KEY,
  getProviderCircuit,
} from "../../../src/lib/provider-circuit-breaker.js";
import { outboundFetch } from "../../../src/lib/outbound-http.js";
import { getTekkoLiveConfig, tekkoSignPath, type TekkoConfig } from "./config.js";
import { signTekkoPlatformRequest } from "./sign.js";

const TEKKO_CIRCUIT = getProviderCircuit(TEKKO_CIRCUIT_KEY);

export type TekkoHttpResult = {
  status: number;
  json: unknown;
  text: string;
};

export async function tekkoPlatformRequest(params: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path relative to platform root, e.g. `/customers` or `/ping`. */
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  label?: string;
  config?: TekkoConfig;
}): Promise<TekkoHttpResult> {
  const config = params.config ?? getTekkoLiveConfig();
  if (!config) {
    throw new Error("Tekko credentials not configured (TEKKO_LIVE_KEY_ID + private key)");
  }

  const signPath = tekkoSignPath(params.path);
  const rawBody =
    params.method === "GET" || params.body === undefined
      ? ""
      : JSON.stringify(params.body);
  const idempotencyKey =
    params.method === "GET" ? undefined : params.idempotencyKey?.trim() || undefined;

  const signed = signTekkoPlatformRequest({
    method: params.method,
    path: signPath,
    rawBody,
    idempotencyKey,
    privateKeyPem: config.privateKeyPem,
    keyId: config.keyId,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Tekko-Key-Id": signed.keyId,
    "X-Tekko-Timestamp": signed.timestamp,
    "X-Tekko-Signature": signed.signature,
  };
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  // baseUrl already includes /api/v1/platform; request relative suffix only.
  const rel = signPath.replace(/^\/api\/v1\/platform/, "") || "/";
  const url = `${config.baseUrl.replace(/\/$/, "")}${rel.startsWith("/") ? rel : `/${rel}`}`;

  const result = await outboundFetch(
    url,
    {
      method: params.method,
      headers,
      body: params.method === "GET" ? undefined : rawBody,
    },
    {
      circuit: TEKKO_CIRCUIT,
      label: params.label ?? `tekko ${params.method} ${rel}`,
      idempotencyKey,
      retries: params.method === "GET" ? 2 : 1,
    }
  );

  let json: unknown = null;
  try {
    json = result.text ? JSON.parse(result.text) : null;
  } catch {
    json = { raw: result.text };
  }
  return { status: result.status, json, text: result.text };
}

export async function tekkoGet(
  path: string,
  opts?: { label?: string; config?: TekkoConfig }
): Promise<TekkoHttpResult> {
  return tekkoPlatformRequest({
    method: "GET",
    path,
    label: opts?.label,
    config: opts?.config,
  });
}

export async function tekkoPost(
  path: string,
  body: unknown,
  idempotencyKey: string,
  opts?: { label?: string; config?: TekkoConfig }
): Promise<TekkoHttpResult> {
  return tekkoPlatformRequest({
    method: "POST",
    path,
    body,
    idempotencyKey,
    label: opts?.label,
    config: opts?.config,
  });
}
