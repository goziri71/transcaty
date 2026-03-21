/**
 * Simple fixed-window rate limit using Redis INCR + EXPIRE.
 * When Redis is unavailable, returns allowed: true (fail-open) so auth still works.
 */
import { getRedis } from "./redis.js";

export async function checkRedisRateLimit(
  key: string,
  max: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number }> {
  const redis = getRedis();
  if (!redis) {
    return { allowed: true, remaining: max };
  }
  const k = `rl:${key}`;
  try {
    const n = await redis.incr(k);
    if (n === 1) {
      await redis.expire(k, windowSeconds);
    }
    const allowed = n <= max;
    const remaining = Math.max(0, max - n);
    return { allowed, remaining };
  } catch {
    return { allowed: true, remaining: max };
  }
}
