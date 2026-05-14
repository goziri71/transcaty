import { tyltFetch } from "./http.js";
import { assertTyltConfigured, type TyltCredentialRole, type TyltMerchantEnvironment } from "./config.js";
import { canonicalPayloadForTyltGet, createTyltSignature, sortKeysRecursive } from "./sign.js";

function encodeQueryValue(v: unknown): string {
  if (Array.isArray(v)) return JSON.stringify(v.map((x) => sortKeysRecursive(x)));
  if (v !== null && typeof v === "object") return JSON.stringify(sortKeysRecursive(v));
  return String(v as string | number | boolean | bigint);
}

function buildUrlWithQuery(baseUrl: string, path: string, queryParams: Record<string, unknown>): string {
  const base = baseUrl.replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${base}${p}`);
  const sortedKeys = Object.keys(queryParams).sort();
  for (const k of sortedKeys) {
    const v = queryParams[k];
    if (v === undefined || v === null) continue;
    url.searchParams.append(k, encodeQueryValue(v));
  }
  return url.toString();
}

/**
 * Signed GET to Tylt: signature is HMAC-SHA256 of {@link canonicalPayloadForTyltGet}(queryParams).
 * Query keys should match the signed object (omit undefined/null values before calling).
 */
export async function tyltSignedGetJson<T = unknown>(params: {
  environment: TyltMerchantEnvironment;
  path: string;
  /** Serialized to query string and to the canonical JSON string that is signed. */
  queryParams?: Record<string, unknown>;
  /** Optional Idempotency-Key header. Tylt dedupes on body identifiers,
   * but propagating one helps any provider-side replay guard. */
  idempotencyKey?: string;
  credentialRole: TyltCredentialRole;
}): Promise<{ status: number; json: T }> {
  const cfg = assertTyltConfigured(params.environment, params.credentialRole);
  const qp = params.queryParams ?? {};
  const payloadToSign = canonicalPayloadForTyltGet(qp);
  const signature = createTyltSignature(cfg.apiSecret, payloadToSign);
  const url = buildUrlWithQuery(cfg.baseUrl, params.path, qp);

  const res = await tyltFetch(
    url,
    {
      method: "GET",
      headers: {
        "X-TLP-APIKEY": cfg.apiKey,
        "X-TLP-SIGNATURE": signature,
      },
    },
    { label: `tylt GET ${params.path}`, idempotencyKey: params.idempotencyKey }
  );

  const text = await res.text();
  let json: T;
  try {
    json = (text ? JSON.parse(text) : {}) as T;
  } catch {
    json = { raw: text } as T;
  }
  return { status: res.status, json };
}

export async function tyltSignedPostJson<T = unknown>(params: {
  environment: TyltMerchantEnvironment;
  path: string;
  body: Record<string, unknown>;
  /** Optional Idempotency-Key header. Strongly recommended for any
   * mutating endpoint that could be retried (create payin/payout). */
  idempotencyKey?: string;
  credentialRole: TyltCredentialRole;
}): Promise<{ status: number; json: T }> {
  const cfg = assertTyltConfigured(params.environment, params.credentialRole);
  const raw = JSON.stringify(params.body);
  const signature = createTyltSignature(cfg.apiSecret, raw);
  const url = `${cfg.baseUrl}${params.path.startsWith("/") ? "" : "/"}${params.path}`;

  const res = await tyltFetch(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-TLP-APIKEY": cfg.apiKey,
        "X-TLP-SIGNATURE": signature,
      },
      body: raw,
    },
    { label: `tylt POST ${params.path}`, idempotencyKey: params.idempotencyKey }
  );

  const text = await res.text();
  let json: T;
  try {
    json = (text ? JSON.parse(text) : {}) as T;
  } catch {
    json = { raw: text } as T;
  }
  return { status: res.status, json };
}
