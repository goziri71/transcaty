/**
 * Optional Redis client for distributed rate limiting and future caching.
 * If REDIS_URL/REDIS_URL_ENC is unset, getRedis() returns null (callers should degrade gracefully).
 */
import { Redis } from "ioredis";
import { getSecret } from "./encryption.js";

let client: InstanceType<typeof Redis> | null | undefined;

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
      lazyConnect: false,
    });
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

export async function pingRedis(): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;
  try {
    const p = await r.ping();
    return p === "PONG";
  } catch {
    return false;
  }
}
