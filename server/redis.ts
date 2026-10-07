import { createClient } from "redis";
import type { RateLimiter, TargetCache } from "./ports.ts";
import { Metrics } from "./observability.ts";

const script = `local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return count`;
export async function withTimeout<T>(work: Promise<T>, ms = 200): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Dependency timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function connectRedis(url: string, metrics: Metrics) {
  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 2000,
      reconnectStrategy: (retries) =>
        Math.min(100 * 2 ** Math.min(retries, 5), 2000),
    },
  });
  // Redis emits error events on network loss. Operations report their own typed failures.
  client.on("error", () => {});
  let cacheOpenUntil = 0;
  const cache: TargetCache = {
    async get(code) {
      if (Date.now() < cacheOpenUntil) {
        metrics.event("cache_miss");
        return null;
      }
      try {
        const value = await withTimeout(client.get(`target:v1:${code}`));
        metrics.event(value === null ? "cache_miss" : "cache_hit");
        return value;
      } catch {
        cacheOpenUntil = Date.now() + 5000;
        metrics.event("cache_error");
        return null;
      }
    },
    async set(code, target) {
      if (Date.now() < cacheOpenUntil) return;
      try {
        await withTimeout(
          client.set(`target:v1:${code}`, target, { EX: 3600 }),
        );
      } catch {
        cacheOpenUntil = Date.now() + 5000;
        metrics.event("cache_error");
      }
    },
  };
  const limiter: RateLimiter = {
    async consume(key, limit, windowSeconds) {
      const now = Date.now();
      const window = Math.floor(now / (windowSeconds * 1000));
      const count = Number(
        await withTimeout(
          client.eval(script, {
            keys: [`rate:v1:${key}:${window}`],
            arguments: [String(windowSeconds * 1000)],
          }),
        ),
      );
      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        retryAfter: Math.max(
          1,
          Math.ceil(((window + 1) * windowSeconds * 1000 - now) / 1000),
        ),
      };
    },
    async ping() {
      await withTimeout(client.ping());
    },
  };
  return { client, cache, limiter };
}
