import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeInput,
  randomCode,
  decodeCursor,
  encodeCursor,
  AppError,
} from "../server/domain.ts";
import type { Link } from "../server/domain.ts";
import { Metrics, Analytics } from "../server/observability.ts";
import type { Repository } from "../server/ports.ts";
import { readConfig } from "../server/config.ts";

test("generated codes are unbiased base62 strings with ten characters", () => {
  const codes = new Set(Array.from({ length: 10000 }, randomCode));
  assert.equal(codes.size, 10000);
  for (const code of codes) assert.match(code, /^[a-zA-Z0-9]{10}$/);
});
test("destination validation rejects dangerous schemes, credentials, private literals, and loops", () => {
  for (const targetUrl of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "http://example.com",
    "https://user:secret@example.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://2130706433",
    "https://10.1.2.3",
    "https://172.16.0.1",
    "https://192.168.1.1",
    "https://169.254.169.254",
    "https://[::1]",
    "https://example.internal",
    "https://short.example/r/aaaa",
  ])
    assert.throws(
      () => normalizeInput({ targetUrl }, "https://short.example"),
      AppError,
      targetUrl,
    );
  assert.equal(
    normalizeInput(
      { targetUrl: "https://EXAMPLE.COM/guide?q=one#section" },
      "https://short.example",
    ).targetUrl,
    "https://example.com/guide?q=one#section",
  );
});
test("cursor validation and encoding handle boundaries", () => {
  const link = { createdAt: 1760000000000, code: "alpha" } as Link;
  assert.deepEqual(decodeCursor(encodeCursor(link)), {
    createdAt: link.createdAt,
    code: link.code,
  });
  for (const bad of [
    "garbage",
    "x".repeat(161),
    Buffer.from('{"createdAt":-1,"code":"abcd"}').toString("base64url"),
  ])
    assert.throws(() => decodeCursor(bad), AppError);
});
test("configuration rejects weak monitoring credentials and insecure production origins", () => {
  assert.throws(() => readConfig({ METRICS_TOKEN: "short" }));
  assert.throws(() =>
    readConfig({
      METRICS_TOKEN: "x".repeat(32),
      NODE_ENV: "production",
      PUBLIC_BASE_URL: "http://example.com",
    }),
  );
  assert.throws(() =>
    readConfig({
      METRICS_TOKEN: "x".repeat(32),
      PUBLIC_BASE_URL: "https://example.com/path",
    }),
  );
});
test("metrics histogram is cumulative and excludes business identifiers", () => {
  const m = new Metrics();
  m.observe("/r/:code", 302, 0.05);
  m.observe("/r/:code", 410, 0.5);
  const output = m.render();
  assert.match(output, /route="\/r\/:code",status_class="3xx",le="0.05"} 1/);
  assert.match(output, /le="\+Inf"} 1/);
  assert.doesNotMatch(output, /owner|target_url/);
});
test("analytics failure is isolated from request success and bounded under pressure", async () => {
  const metrics = new Metrics();
  const analytics = new Analytics(
    {
      recordClick: async () => {
        throw new Error("offline");
      },
    } as unknown as Repository,
    metrics,
  );
  analytics.record("abcd", Date.now());
  await analytics.drain();
  assert.equal(metrics.events.get("analytics_error"), 1);
  const blockers = new Set<() => void>();
  const busy = new Analytics(
    {
      recordClick: () => new Promise<void>((resolve) => blockers.add(resolve)),
    } as unknown as Repository,
    metrics,
  );
  for (let i = 0; i < 300; i++) busy.record("abcd", Date.now());
  assert.equal(busy.pending.size, 256);
  assert.equal(metrics.events.get("analytics_drop"), 44);
  for (const resolve of blockers) resolve();
  await busy.drain();
  assert.equal(busy.pending.size, 0);
});
