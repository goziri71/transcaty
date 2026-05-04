/**
 * Tylt discovery + account balance (§8): supported lists and getAccountBalance.
 *
 * Caching (recommended in spec §8):
 * - Lists: `TYLT_DISCOVERY_CACHE_TTL_MS` — default 60000 ms; set `0` to disable.
 * - Balance: `TYLT_ACCOUNT_BALANCE_CACHE_TTL_MS` — default `0` (no cache); set positive only if stale balances are acceptable.
 */
import { tyltSignedGetJson } from "./client.js";
import type { TyltMerchantEnvironment } from "./config.js";
import { sortKeysRecursive } from "./sign.js";

type CachedPayload = { status: number; json: unknown };

const cache = new Map<string, { expiresAt: number; payload: CachedPayload }>();

export function discoveryCacheTtlMs(): number {
  const raw = process.env.TYLT_DISCOVERY_CACHE_TTL_MS?.trim();
  if (!raw) return 60_000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

export function accountBalanceCacheTtlMs(): number {
  const raw = process.env.TYLT_ACCOUNT_BALANCE_CACHE_TTL_MS?.trim();
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function cacheKey(environment: TyltMerchantEnvironment, path: string, queryParams: Record<string, unknown>): string {
  return `${environment}:${path}:${JSON.stringify(sortKeysRecursive(queryParams))}`;
}

async function signedGet(params: {
  environment: TyltMerchantEnvironment;
  path: string;
  queryParams?: Record<string, unknown>;
  ttlMs: number;
}): Promise<CachedPayload> {
  const qp = params.queryParams ?? {};
  const ttl = params.ttlMs;
  if (ttl <= 0) {
    return tyltSignedGetJson({ environment: params.environment, path: params.path, queryParams: qp });
  }
  const key = cacheKey(params.environment, params.path, qp);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.payload;
  const payload = await tyltSignedGetJson({
    environment: params.environment,
    path: params.path,
    queryParams: qp,
  });
  cache.set(key, { expiresAt: Date.now() + ttl, payload });
  return payload;
}

export async function tyltGetSupportedCryptoCurrenciesList(environment: TyltMerchantEnvironment) {
  return signedGet({
    environment,
    path: "/transactions/merchant/getSupportedCryptoCurrenciesList",
    queryParams: {},
    ttlMs: discoveryCacheTtlMs(),
  });
}

export async function tyltGetSupportedFiatCurrenciesList(environment: TyltMerchantEnvironment) {
  return signedGet({
    environment,
    path: "/transactions/merchant/getSupportedFiatCurrenciesList",
    queryParams: {},
    ttlMs: discoveryCacheTtlMs(),
  });
}

export async function tyltGetSupportedCryptoNetworksList(environment: TyltMerchantEnvironment) {
  return signedGet({
    environment,
    path: "/transactions/merchant/getSupportedCryptoNetworksList",
    queryParams: {},
    ttlMs: discoveryCacheTtlMs(),
  });
}

export async function tyltGetSupportedBaseCurrenciesList(environment: TyltMerchantEnvironment) {
  return signedGet({
    environment,
    path: "/transactions/merchant/getSupportedBaseCurrenciesList",
    queryParams: {},
    ttlMs: discoveryCacheTtlMs(),
  });
}

/**
 * Pass-through query params when Tylt expects filters (empty `{}` otherwise).
 * Uses separate TTL env (`TYLT_ACCOUNT_BALANCE_CACHE_TTL_MS`, default 0).
 */
export async function tyltGetAccountBalance(
  environment: TyltMerchantEnvironment,
  queryParams?: Record<string, unknown>
) {
  return signedGet({
    environment,
    path: "/transactions/merchant/getAccountBalance",
    queryParams: queryParams ?? {},
    ttlMs: accountBalanceCacheTtlMs(),
  });
}
