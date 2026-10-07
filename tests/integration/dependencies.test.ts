import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { connectPostgres } from "../../server/postgres.ts";
import { connectRedis } from "../../server/redis.ts";
import { Metrics } from "../../server/observability.ts";
import { LinkService } from "../../server/domain.ts";

test("PostgreSQL multi-connection uniqueness and real Redis atomic quotas", async () => {
  const url = process.env.TEST_DATABASE_URL;
  const redisUrl = process.env.TEST_REDIS_URL;
  assert(
    url && redisUrl,
    "Set TEST_DATABASE_URL and TEST_REDIS_URL to disposable test services.",
  );
  assert(
    new URL(url).pathname.endsWith("_test"),
    "The database name must end in _test.",
  );
  const admin = connectPostgres(url);
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await admin.pool.query(`CREATE SCHEMA ${schema}`);
  const isolatedUrl = new URL(url);
  isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
  const db = connectPostgres(isolatedUrl.toString());
  const metrics = new Metrics();
  const redis = connectRedis(redisUrl, metrics);
  const created: string[] = [];
  try {
    await db.pool.query(
      await readFile("migrations/postgres/001_initial.sql", "utf8"),
    );
    await redis.client.connect();
    const owner = randomUUID();
    const key = randomUUID();
    const service = new LinkService(
      db.repo,
      redis.cache,
      "https://short.example",
    );
    const writes = await Promise.all(
      Array.from({ length: 40 }, () =>
        service.create(
          owner,
          { targetUrl: "https://example.com/integration" },
          key,
        ),
      ),
    );
    assert.equal(writes.filter((w) => !w.replayed).length, 1);
    assert.equal(new Set(writes.map((w) => w.link.code)).size, 1);
    const code = writes[0].link.code;
    created.push(code);
    assert.equal(
      await service.resolve(code),
      "https://example.com/integration",
    );
    assert.equal(
      await redis.client.get(`target:v1:${code}`),
      "https://example.com/integration",
    );
    assert.equal(await db.repo.revoke(owner, code, Date.now()), true);
    await assert.rejects(service.resolve(code), { code: "LINK_GONE" });
    const limitKey = `integration:${randomUUID()}`;
    const rates = await Promise.all(
      Array.from({ length: 100 }, () =>
        redis.limiter.consume(limitKey, 10, 3600),
      ),
    );
    assert.equal(rates.filter((r) => r.allowed).length, 10);
    const bucketKey = `rate:v1:${limitKey}:${Math.floor(Date.now() / 3600000)}`;
    assert(Number(await redis.client.pTTL(bucketKey)) > 0);
    await redis.client.del(bucketKey);
    assert(metrics.events.get("cache_miss"));
  } finally {
    if (redis.client.isOpen) {
      for (const code of created) await redis.client.del(`target:v1:${code}`);
      await redis.client.close();
    }
    await db.pool.end();
    await admin.pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.pool.end();
  }
});
