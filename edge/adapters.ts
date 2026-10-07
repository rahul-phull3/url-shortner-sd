import { SqlRepository } from "../server/sql-repository.ts";
import type { RateLimiter, TargetCache } from "../server/ports.ts";
import type { Metrics } from "../server/observability.ts";

export function edgeAdapters(db: D1Database, metrics: Metrics) {
  // Every query deliberately starts at the primary. Replica reads would weaken revocation.
  const query = async (sql: string, params: unknown[] = []) => {
    const result = await db
      .withSession("first-primary")
      .prepare(sql)
      .bind(...params)
      .all<Record<string, unknown>>();
    return result.results;
  };
  const repo = new SqlRepository(query);
  const limiter: RateLimiter = {
    async consume(key, limit, seconds) {
      const now = Date.now();
      const bucket = Math.floor(now / (seconds * 1000));
      const expiry = (bucket + 2) * seconds * 1000;
      const rows = await query(
        `INSERT INTO rate_buckets (key, count, expires_at) VALUES (?, 1, ?)
        ON CONFLICT (key) DO UPDATE SET count = rate_buckets.count + 1 RETURNING count`,
        [`${key}:${bucket}`, expiry],
      );
      const count = Number(rows[0].count);
      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        retryAfter: Math.max(
          1,
          Math.ceil(((bucket + 1) * seconds * 1000 - now) / 1000),
        ),
      };
    },
    async ping() {
      await repo.ping();
    },
  };
  const targets = new Map<string, { url: string; expires: number }>();
  const cache: TargetCache = {
    async get(code) {
      const found = targets.get(code);
      if (found && found.expires > Date.now()) {
        targets.delete(code);
        targets.set(code, found);
        metrics.event("cache_hit");
        return found.url;
      }
      targets.delete(code);
      metrics.event("cache_miss");
      return null;
    },
    async set(code, url) {
      targets.delete(code);
      targets.set(code, { url, expires: Date.now() + 3600000 });
      if (targets.size > 128) targets.delete(targets.keys().next().value!);
    },
  };
  async function cleanup() {
    await repo.cleanup(Date.now());
    await query("DELETE FROM rate_buckets WHERE expires_at <= ?", [Date.now()]);
  }
  return { repo, limiter, cache, cleanup };
}
