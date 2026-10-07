import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Miniflare } from "miniflare";

test("deployed Worker runtime serves React and persists real D1 lifecycle operations", async () => {
  const mf = new Miniflare({
    modules: true,
    scriptPath: "dist/server/index.js",
    compatibilityDate: "2025-11-17",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: randomUUID() },
    d1Persist: false,
    bindings: {
      PUBLIC_BASE_URL: "https://short.example",
      METRICS_TOKEN: "test-monitoring-token-32-characters",
    },
  });
  try {
    const db = await mf.getD1Database("DB");
    for (const filename of (await readdir("drizzle"))
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      const sql = (await readFile(`drizzle/${filename}`, "utf8")).replaceAll(
        "--> statement-breakpoint",
        "",
      );
      for (const statement of sql
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean))
        await db.prepare(statement).run();
    }
    const call = (
      path: string,
      init?: Parameters<Miniflare["dispatchFetch"]>[1],
    ) =>
      mf.dispatchFetch(`https://short.example${path}`, {
        redirect: "manual",
        ...init,
      });
    const home = await call("/");
    assert.equal(home.status, 200);
    assert.match(await home.text(), /<div id="root">/);
    const readiness = await call("/health/ready");
    assert.equal(readiness.status, 200, await readiness.text());
    const headers = {
      "X-Requested-With": "shortlink",
      Origin: "https://short.example",
    };
    const session = await call("/api/v1/session", { method: "POST", headers });
    assert.equal(session.status, 201, await session.text());
    const cookie = session.headers.get("set-cookie")!.split(";")[0];
    const body = JSON.stringify({
      targetUrl: "https://example.com/edge",
      alias: "edge-link",
    });
    const createHeaders = {
      ...headers,
      Cookie: cookie,
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    };
    const made = await call("/api/v1/links", {
      method: "POST",
      headers: createHeaders,
      body,
    });
    assert.equal(made.status, 201, await made.clone().text());
    const link = (await made.json()) as { code: string; shortUrl: string };
    const replay = await call("/api/v1/links", {
      method: "POST",
      headers: createHeaders,
      body,
    });
    assert.equal(replay.status, 200);
    const redirect = await call(`/r/${link.code}`);
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), "https://example.com/edge");
    const list = await call("/api/v1/links", { headers: { Cookie: cookie } });
    const page = (await list.json()) as { items: Array<{ code: string }> };
    assert.equal(page.items[0].code, link.code);
    const removed = await call(`/api/v1/links/${link.code}`, {
      method: "DELETE",
      headers: { ...headers, Cookie: cookie },
    });
    assert.equal(removed.status, 204);
    assert.equal((await call(`/r/${link.code}`)).status, 410);
    const oversized = await call("/api/v1/links", {
      method: "POST",
      headers: createHeaders,
      body: "x".repeat(10000),
    });
    assert.equal(oversized.status, 413);
    const hidden = await call("/api/v1/links");
    assert.equal(hidden.status, 401);
    assert.equal((await call("/internal/metrics")).status, 401);
    const buckets = await db
      .prepare("SELECT COUNT(*) AS total FROM rate_buckets")
      .first<{ total: number }>();
    assert(Number(buckets!.total) > 0);
  } finally {
    await mf.dispose();
  }
});
