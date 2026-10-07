import {
  describe,
  test,
  before,
  beforeEach,
  after,
  afterEach,
} from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { SqlRepository } from "../server/sql-repository.ts";
import { buildApp } from "../server/app.ts";
import type { RateLimiter, TargetCache } from "../server/ports.ts";

describe("Node API against the PostgreSQL SQL engine", () => {
  let db: PGlite;
  let repo: SqlRepository;
  let now = Date.now();
  const active: ReturnType<typeof buildApp>[] = [];
  before(async () => {
    db = new PGlite();
    await db.exec(
      await readFile("migrations/postgres/001_initial.sql", "utf8"),
    );
    repo = new SqlRepository(async (sql, params = []) => {
      let index = 0;
      return (
        await db.query<Record<string, unknown>>(
          sql.replace(/\?/g, () => `$${++index}`),
          params,
        )
      ).rows;
    });
  });
  beforeEach(async () => {
    now = Date.now();
    await db.exec("TRUNCATE click_daily, links, sessions");
  });
  afterEach(async () => {
    for (const h of active.splice(0)) {
      await h.analytics.drain();
      await h.app.close();
    }
  });
  after(async () => {
    await db.close();
  });

  function harness(code?: () => string) {
    const map = new Map<string, string>();
    const flags = { cacheDown: false, limiterDown: false };
    const cache: TargetCache = {
      async get(key) {
        if (flags.cacheDown) throw new Error("offline");
        return map.get(key) ?? null;
      },
      async set(key, target) {
        map.set(key, target);
      },
    };
    const counts = new Map<string, number>();
    const limiter: RateLimiter = {
      async consume(key, limit) {
        if (flags.limiterDown) throw new Error("offline");
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return {
          allowed: count <= limit,
          remaining: Math.max(0, limit - count),
          retryAfter: 60,
        };
      },
      async ping() {
        if (flags.limiterDown) throw new Error("offline");
      },
    };
    const result = buildApp(
      { repo, cache, limiter, now: () => now, code },
      {
        baseUrl: "https://short.example",
        metricsToken: "test-monitoring-token-32-characters",
        logLevel: "silent",
        trustProxyHops: 0,
      },
    );
    active.push(result);
    return { ...result, flags, map };
  }
  const writeHeaders = {
    "x-requested-with": "shortlink",
    origin: "https://short.example",
  };
  async function workspace(h: ReturnType<typeof harness>) {
    const response = await h.app.inject({
      method: "POST",
      url: "/api/v1/session",
      headers: writeHeaders,
    });
    assert.equal(response.statusCode, 201);
    assert.match(String(response.headers["set-cookie"]), /HttpOnly/);
    return String(response.headers["set-cookie"]).split(";")[0];
  }
  function create(
    h: ReturnType<typeof harness>,
    cookie: string,
    body: Record<string, unknown>,
    key: string = randomUUID(),
  ) {
    return h.app.inject({
      method: "POST",
      url: "/api/v1/links",
      headers: { ...writeHeaders, cookie, "idempotency-key": key },
      payload: body,
    });
  }

  test("creates, lists, redirects, and counts without revealing another workspace", async () => {
    const h = harness();
    const first = await workspace(h);
    const second = await workspace(h);
    const made = await create(h, first, {
      targetUrl: "https://example.com/guide",
    });
    assert.equal(made.statusCode, 201);
    const link = made.json();
    assert.match(link.code, /^[a-zA-Z0-9]{10}$/);
    const redirected = await h.app.inject(`/r/${link.code}`);
    assert.equal(redirected.statusCode, 302);
    assert.equal(redirected.headers.location, "https://example.com/guide");
    assert.equal(redirected.headers["cache-control"], "no-store");
    await h.analytics.drain();
    const list = await h.app.inject({
      url: "/api/v1/links",
      headers: { cookie: first },
    });
    assert.equal(list.json().items[0].clicks, 1);
    const hidden = await h.app.inject({
      url: "/api/v1/links",
      headers: { cookie: second },
    });
    assert.deepEqual(hidden.json().items, []);
  });
  test("same idempotency key returns one code under thirty concurrent requests", async () => {
    const h = harness();
    const cookie = await workspace(h);
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 30 }, () =>
        create(h, cookie, { targetUrl: "https://example.com/same" }, key),
      ),
    );
    assert.equal(responses.filter((r) => r.statusCode === 201).length, 1);
    assert.equal(new Set(responses.map((r) => r.json().code)).size, 1);
    const conflict = await create(
      h,
      cookie,
      { targetUrl: "https://example.com/different" },
      key,
    );
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, "IDEMPOTENCY_CONFLICT");
  });
  test("an alias has a single winner across simultaneous owners", async () => {
    const h = harness();
    const a = await workspace(h);
    const b = await workspace(h);
    const results = await Promise.all([
      create(h, a, { targetUrl: "https://example.com/a", alias: "shared" }),
      create(h, b, { targetUrl: "https://example.com/b", alias: "shared" }),
    ]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
  });
  test("generated-code collisions retry and exhaustion is bounded", async () => {
    const h = harness(() => "collision1");
    const cookie = await workspace(h);
    assert.equal(
      (await create(h, cookie, { targetUrl: "https://example.com/a" }))
        .statusCode,
      201,
    );
    const failed = await create(h, cookie, {
      targetUrl: "https://example.com/b",
    });
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.json().error.code, "CODE_EXHAUSTED");
    let tries = 0;
    const succeeds = harness(() =>
      ++tries === 1 ? "collision1" : "newcode123",
    );
    assert.equal(
      (
        await create(succeeds, cookie, { targetUrl: "https://example.com/c" })
      ).json().code,
      "newcode123",
    );
  });
  test("revocation and expiry override a warm stale cache; aliases are never recycled", async () => {
    const h = harness();
    const cookie = await workspace(h);
    const expiry = new Date(now + 1000).toISOString();
    const link = (
      await create(
        h,
        cookie,
        {
          targetUrl: "https://example.com/time",
          alias: "timed",
          expiresAt: expiry,
        },
        "stable-key-123",
      )
    ).json();
    assert.equal((await h.app.inject(`/r/${link.code}`)).statusCode, 302);
    assert(h.map.has(link.code));
    now += 1001;
    assert.equal((await h.app.inject(`/r/${link.code}`)).statusCode, 410);
    const replay = await create(
      h,
      cookie,
      {
        targetUrl: "https://example.com/time",
        alias: "timed",
        expiresAt: expiry,
      },
      "stable-key-123",
    );
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().status, "expired");
    const revoked = (
      await create(h, cookie, {
        targetUrl: "https://example.com/live",
        alias: "revoked",
      })
    ).json();
    await h.app.inject(`/r/${revoked.code}`);
    const remove = () =>
      h.app.inject({
        method: "DELETE",
        url: `/api/v1/links/${revoked.code}`,
        headers: { ...writeHeaders, cookie },
      });
    assert.equal((await remove()).statusCode, 204);
    assert.equal((await remove()).statusCode, 204);
    assert.equal((await h.app.inject(`/r/${revoked.code}`)).statusCode, 410);
    assert.equal(
      (
        await create(h, cookie, {
          targetUrl: "https://example.com/new",
          alias: "revoked",
        })
      ).statusCode,
      409,
    );
  });
  test("another owner cannot revoke or claim an existing link", async () => {
    const h = harness();
    const a = await workspace(h);
    const b = await workspace(h);
    const link = (
      await create(h, a, { targetUrl: "https://example.com/a" })
    ).json();
    assert.equal(
      (
        await h.app.inject({
          method: "DELETE",
          url: `/api/v1/links/${link.code}`,
          headers: { ...writeHeaders, cookie: b },
        })
      ).statusCode,
      404,
    );
    assert.equal((await h.app.inject(`/r/${link.code}`)).statusCode, 302);
  });
  test("cache loss preserves redirects, while unavailable rate limiting closes writes", async () => {
    const h = harness();
    const cookie = await workspace(h);
    const code = (
      await create(h, cookie, { targetUrl: "https://example.com/a" })
    ).json().code;
    h.flags.cacheDown = true;
    h.flags.limiterDown = true;
    assert.equal((await h.app.inject(`/r/${code}`)).statusCode, 302);
    assert.equal(
      (await create(h, cookie, { targetUrl: "https://example.com/b" }))
        .statusCode,
      503,
    );
    assert.equal((await h.app.inject("/health/ready")).statusCode, 503);
    assert.equal((await h.app.inject("/health/live")).statusCode, 200);
  });
  test("write quota returns 429 and Retry-After", async () => {
    const h = harness();
    const cookie = await workspace(h);
    for (let i = 0; i < 60; i++)
      assert.equal(
        (
          await create(
            h,
            cookie,
            { targetUrl: "https://example.com/a" },
            randomUUID(),
          )
        ).statusCode,
        201,
      );
    const over = await create(h, cookie, {
      targetUrl: "https://example.com/b",
    });
    assert.equal(over.statusCode, 429);
    assert.equal(over.headers["retry-after"], "60");
  });
  test("keyset pagination handles tied timestamps and rejects invalid limits", async () => {
    const h = harness();
    const cookie = await workspace(h);
    for (const alias of ["AAAA", "bbbb", "cccc", "dddd", "eeee"])
      await create(h, cookie, {
        targetUrl: `https://example.com/${alias}`,
        alias,
      });
    const found: string[] = [];
    let cursor = "";
    do {
      const r = await h.app.inject({
        url: `/api/v1/links?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        headers: { cookie },
      });
      found.push(...r.json().items.map((l: { code: string }) => l.code));
      cursor = r.json().nextCursor;
    } while (cursor);
    assert.deepEqual(found, ["eeee", "dddd", "cccc", "bbbb", "AAAA"]);
    assert.equal(
      (
        await h.app.inject({
          url: "/api/v1/links?limit=101",
          headers: { cookie },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await h.app.inject({
          url: "/api/v1/links?cursor=invalid",
          headers: { cookie },
        })
      ).statusCode,
      400,
    );
  });
  test("ownership and CSRF barriers reject missing, forged, and cross-origin cookies", async () => {
    const h = harness();
    const cookie = await workspace(h);
    assert.equal((await h.app.inject("/api/v1/links")).statusCode, 401);
    assert.equal(
      (
        await h.app.inject({
          url: "/api/v1/links",
          headers: { cookie: "sl_session=" + "a".repeat(64) },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await h.app.inject({ method: "POST", url: "/api/v1/session" }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await h.app.inject({
          method: "POST",
          url: "/api/v1/links",
          headers: {
            ...writeHeaders,
            cookie,
            origin: "https://attacker.example",
          },
          payload: { targetUrl: "https://example.com" },
        })
      ).statusCode,
      403,
    );
    now += 31 * 86400000;
    assert.equal(
      (await h.app.inject({ url: "/api/v1/links", headers: { cookie } }))
        .statusCode,
      401,
    );
  });
  test("private monitoring requires its separate token; HEAD does not count as a click", async () => {
    const h = harness();
    const cookie = await workspace(h);
    const code = (
      await create(h, cookie, { targetUrl: "https://example.com/a" })
    ).json().code;
    assert.equal(
      (await h.app.inject({ method: "HEAD", url: `/r/${code}` })).statusCode,
      302,
    );
    await h.analytics.drain();
    assert.equal(
      (await h.app.inject({ url: "/api/v1/links", headers: { cookie } })).json()
        .items[0].clicks,
      0,
    );
    assert.equal((await h.app.inject("/internal/metrics")).statusCode, 401);
    assert.equal(
      (
        await h.app.inject({
          url: "/internal/metrics",
          headers: {
            authorization: "Bearer test-monitoring-token-32-characters",
          },
        })
      ).statusCode,
      200,
    );
  });
  test("database rows and the cookie survive a new server instance", async () => {
    const h = harness();
    const cookie = await workspace(h);
    const code = (
      await create(h, cookie, { targetUrl: "https://example.com/a" })
    ).json().code;
    const restarted = harness();
    assert.equal((await restarted.app.inject(`/r/${code}`)).statusCode, 302);
    assert.equal(
      (
        await restarted.app.inject({
          url: "/api/v1/links",
          headers: { cookie },
        })
      ).json().items[0].code,
      code,
    );
  });
});
