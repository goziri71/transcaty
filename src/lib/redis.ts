/**
 * Optional Redis client for distributed rate limiting and future caching.
 * If REDIS_URL/REDIS_URL_ENC is unset, getRedis() returns null (callers should degrade gracefully).
 */
import { Redis } from "ioredis";
import { getSecret } from "./encryption.js";

let client: InstanceType<typeof Redis> | null | undefined;

/** Cap how long a TCP connect to Redis may take (ioredis default is 10000). */
function redisConnectTimeoutMs(): number {
  const raw = process.env.REDIS_CONNECT_TIMEOUT_MS;
  if (raw == null || raw === "") return 3000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 500) return 3000;
  return Math.min(Math.floor(n), 30_000);
}

/**
 * After this many reconnect tries, stop (avoids endless ENOTFOUND / ECONNREFUSED
 * when REDIS_URL points at an unreachable host, e.g. Render internal Redis from a laptop).
 */
function redisMaxReconnectAttempts(): number {
  const raw = process.env.REDIS_MAX_RECONNECT_ATTEMPTS;
  if (raw == null || raw === "") return 15;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 15;
  return Math.min(Math.floor(n), 200);
}

function redisRetryStrategy(times: number): number | null {
  const max = redisMaxReconnectAttempts();
  if (times > max) return null;
  return Math.min(times * 100, 2000);
}

function attachRedisErrorSilencer(r: InstanceType<typeof Redis>): void {
  // ioredis emits "error" on reconnect failures; without a listener, Node logs
  // "Unhandled error event" for every attempt.
  r.on("error", () => {});
}

export function getRedis(): InstanceType<typeof Redis> | null {
  if (client !== undefined) return client;
  const url = getSecret("REDIS_URL", "REDIS_URL_ENC")?.trim();
  if (!url) {
    client = null;
    return null;
  }
  try {
    const r = new Redis(url, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      lazyConnect: true,
      connectTimeout: redisConnectTimeoutMs(),
      retryStrategy: redisRetryStrategy,
    });
    attachRedisErrorSilencer(r);
    client = r;
    return r;
  } catch {
    client = null;
    return null;
  }
}

/** Best-effort disconnect on shutdown. */
export async function disconnectRedis(): Promise<void> {
  if (!client) return;
  try {
    await client.quit();
  } catch {
    /* ignore */
  }
  client = undefined;
}

/**
 * One-off connectivity check for /health. Uses a dedicated client with no reconnect
 * loop so a bad REDIS_URL cannot stall the handler for many seconds on the shared singleton.
 */
export async function pingRedis(): Promise<boolean> {
  const url = getSecret("REDIS_URL", "REDIS_URL_ENC")?.trim();
  if (!url) return false;

  const r = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    lazyConnect: false,
    connectTimeout: Math.min(redisConnectTimeoutMs(), 2500),
    retryStrategy: () => null,
  });
  attachRedisErrorSilencer(r);
  try {
    const p = await r.ping();
    return p === "PONG";
  } catch {
    return false;
  } finally {
    try {
      r.disconnect();
    } catch {
      /* ignore */
    }
  }
}
