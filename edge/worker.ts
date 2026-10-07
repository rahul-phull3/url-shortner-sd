import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  AppError,
  LinkService,
  sha256,
  decodeCursor,
  encodeCursor,
} from "../server/domain.ts";
import type { CreateInput } from "../server/domain.ts";
import { Metrics, Analytics } from "../server/observability.ts";
import { edgeAdapters } from "./adapters.ts";
import { assets } from "./generated-assets.ts";

type Env = { DB: D1Database; PUBLIC_BASE_URL?: string; METRICS_TOKEN: string };
let runtime: ReturnType<typeof initialize> | undefined;
let lastCleanup = 0;
function initialize(env: Env, baseUrl: string) {
  const metrics = new Metrics();
  const adapters = edgeAdapters(env.DB, metrics);
  return {
    ...adapters,
    metrics,
    service: new LinkService(adapters.repo, adapters.cache, baseUrl),
    analytics: new Analytics(adapters.repo, metrics),
  };
}
const json = (body: unknown, status = 200, headers?: Headers) => {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json; charset=utf-8");
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: h,
  });
};
async function body(request: Request): Promise<CreateInput> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    throw new AppError(400, "INVALID_REQUEST", "Send a JSON request.");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader)
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 8192) {
        await reader.cancel();
        throw new AppError(
          413,
          "BODY_TOO_LARGE",
          "The request body is too large.",
        );
      }
      chunks.push(value);
    }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError(400, "INVALID_REQUEST", "Send a valid JSON object.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AppError(400, "INVALID_REQUEST", "Send a JSON object.");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (k) => !["targetUrl", "alias", "expiresAt"].includes(k),
    ) ||
    typeof input.targetUrl !== "string" ||
    input.targetUrl.length < 8 ||
    input.targetUrl.length > 2048 ||
    (input.alias !== undefined && typeof input.alias !== "string") ||
    (input.expiresAt !== undefined &&
      (typeof input.expiresAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          input.expiresAt,
        )))
  )
    throw new AppError(
      400,
      "INVALID_REQUEST",
      "Check the request fields and try again.",
    );
  return input as CreateInput;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const baseUrl = env.PUBLIC_BASE_URL ?? url.origin;
    const requestId = randomUUID();
    const started = performance.now();
    const headers = new Headers({
      "X-Request-Id": requestId,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
    if (baseUrl.startsWith("https:"))
      headers.set("Strict-Transport-Security", "max-age=31536000");
    if (url.pathname === "/" || url.pathname.startsWith("/assets/")) {
      if (!["GET", "HEAD"].includes(request.method))
        return json({ error: { code: "METHOD_NOT_ALLOWED" } }, 405, headers);
      const asset = assets[url.pathname];
      if (!asset) return json({ error: { code: "NOT_FOUND" } }, 404, headers);
      headers.set("Content-Type", asset.type);
      headers.set(
        "Cache-Control",
        url.pathname === "/"
          ? "no-cache"
          : "public, max-age=31536000, immutable",
      );
      return new Response(request.method === "HEAD" ? null : asset.body, {
        headers,
      });
    }
    if (!env.METRICS_TOKEN || env.METRICS_TOKEN.length < 32)
      return json(
        {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "The service is not configured.",
            requestId,
          },
        },
        503,
        headers,
      );
    runtime ??= initialize(env, baseUrl);
    const r = runtime;
    let route = "unmatched";
    let response: Response;
    const token = request.headers
      .get("Cookie")
      ?.match(/(?:^|;\s*)sl_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    const getSession = () =>
      token
        ? r.repo.getSession(sha256(token), Date.now())
        : Promise.resolve(null);
    async function owner() {
      const s = await getSession();
      if (!s)
        throw new AppError(
          401,
          "WORKSPACE_REQUIRED",
          "Start or reopen your workspace.",
        );
      return s.ownerId;
    }
    function checkOrigin() {
      if (
        request.headers.get("X-Requested-With") !== "shortlink" ||
        (request.headers.has("Origin") &&
          request.headers.get("Origin") !== baseUrl)
      )
        throw new AppError(
          403,
          "ORIGIN_REJECTED",
          "The request must come from this workspace.",
        );
    }
    async function rate(key: string, limit: number) {
      let result;
      try {
        result = await r.limiter.consume(key, limit, 60);
      } catch {
        throw new AppError(
          503,
          "RATE_LIMITER_UNAVAILABLE",
          "Writes are temporarily unavailable. Retry later.",
        );
      }
      headers.set("RateLimit-Limit", String(limit));
      headers.set("RateLimit-Remaining", String(result.remaining));
      if (!result.allowed) {
        r.metrics.event("rate_limited");
        headers.set("Retry-After", String(result.retryAfter));
        throw new AppError(
          429,
          "RATE_LIMITED",
          "Too many requests. Wait before trying again.",
        );
      }
    }
    try {
      const path = url.pathname;
      const method = request.method;
      if (path === "/health/live" && method === "GET") {
        route = path;
        response = json({ status: "alive" }, 200, headers);
      } else if (path === "/health/ready" && method === "GET") {
        route = path;
        const checks = await Promise.allSettled([
          r.repo.ping(),
          r.limiter.ping(),
        ]);
        const ready = checks.every((c) => c.status === "fulfilled");
        response = json(
          { status: ready ? "ready" : "unavailable" },
          ready ? 200 : 503,
          headers,
        );
      } else if (path === "/internal/metrics" && method === "GET") {
        route = path;
        if (
          !timingSafeEqual(
            Buffer.from(sha256(request.headers.get("Authorization") ?? "")),
            Buffer.from(sha256(`Bearer ${env.METRICS_TOKEN}`)),
          )
        )
          throw new AppError(
            401,
            "UNAUTHORIZED",
            "A monitoring token is required.",
          );
        headers.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
        response = new Response(r.metrics.render(), { headers });
      } else if (path === "/api/v1/session" && method === "GET") {
        route = path;
        response = json({ active: !!(await getSession()) }, 200, headers);
      } else if (path === "/api/v1/session" && method === "POST") {
        route = path;
        checkOrigin();
        const current = await getSession();
        if (current)
          response = json(
            {
              active: true,
              expiresAt: new Date(current.expiresAt).toISOString(),
            },
            200,
            headers,
          );
        else {
          await rate(
            `session:${sha256(request.headers.get("cf-connecting-ip") ?? "127.0.0.1")}`,
            20,
          );
          const sessionToken = Buffer.from(randomBytes(32)).toString("hex");
          const s = {
            ownerId: randomUUID(),
            expiresAt: Date.now() + 30 * 86400000,
          };
          await r.repo.putSession(sha256(sessionToken), s);
          headers.set(
            "Set-Cookie",
            `sl_session=${sessionToken}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict${baseUrl.startsWith("https:") ? "; Secure" : ""}`,
          );
          response = json(
            { active: true, expiresAt: new Date(s.expiresAt).toISOString() },
            201,
            headers,
          );
        }
      } else if (path === "/api/v1/links" && method === "POST") {
        route = path;
        checkOrigin();
        const ownerId = await owner();
        await rate(`write:${ownerId}`, 60);
        const key = request.headers.get("Idempotency-Key");
        if (!key)
          throw new AppError(
            400,
            "INVALID_IDEMPOTENCY_KEY",
            "Supply an Idempotency-Key.",
          );
        const result = await r.service.create(
          ownerId,
          await body(request),
          key,
        );
        headers.set("Idempotent-Replayed", String(result.replayed));
        response = json(
          r.service.view(result.link),
          result.replayed ? 200 : 201,
          headers,
        );
      } else if (path === "/api/v1/links" && method === "GET") {
        route = path;
        const ownerId = await owner();
        if (
          [...url.searchParams.keys()].some(
            (k) => !["limit", "cursor"].includes(k),
          )
        )
          throw new AppError(
            400,
            "INVALID_REQUEST",
            "Unknown query parameter.",
          );
        const limit = Number(url.searchParams.get("limit") ?? "20");
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
          throw new AppError(
            400,
            "INVALID_REQUEST",
            "Use a page size between 1 and 100.",
          );
        const links = await r.repo.listLinks(
          ownerId,
          limit + 1,
          decodeCursor(url.searchParams.get("cursor") ?? undefined),
        );
        const page = links.slice(0, limit);
        const totals = await r.repo.clickTotals(
          ownerId,
          page.map((l) => l.code),
        );
        response = json(
          {
            items: page.map((l) => ({
              ...r.service.view(l),
              clicks: totals[l.code] ?? 0,
            })),
            nextCursor:
              links.length > limit ? encodeCursor(page[page.length - 1]) : null,
          },
          200,
          headers,
        );
      } else if (path.startsWith("/api/v1/links/") && method === "DELETE") {
        route = "/api/v1/links/:code";
        checkOrigin();
        const ownerId = await owner();
        await rate(`write:${ownerId}`, 60);
        const code = decodeURIComponent(path.slice("/api/v1/links/".length));
        if (!/^[a-zA-Z0-9_-]{4,32}$/.test(code))
          throw new AppError(400, "INVALID_REQUEST", "The code is invalid.");
        if (!(await r.repo.revoke(ownerId, code, Date.now())))
          throw new AppError(
            404,
            "LINK_NOT_FOUND",
            "This link is not in your workspace.",
          );
        response = json(null, 204, headers);
      } else if (path.startsWith("/r/") && ["GET", "HEAD"].includes(method)) {
        route = "/r/:code";
        const code = decodeURIComponent(path.slice(3));
        if (!/^[a-zA-Z0-9_-]{4,32}$/.test(code))
          throw new AppError(400, "INVALID_REQUEST", "The code is invalid.");
        const target = await r.service.resolve(code);
        headers.set("Location", target);
        response = new Response(null, { status: 302, headers });
        if (method === "GET") r.analytics.record(code, Date.now());
      } else throw new AppError(404, "NOT_FOUND", "This route does not exist.");
    } catch (error) {
      const domain = error instanceof AppError;
      const status = domain ? error.status : 503;
      if (status >= 500) {
        r.metrics.event("storage_error");
        console.error(
          JSON.stringify({
            requestId,
            errorType: error instanceof Error ? error.name : "UnknownError",
          }),
        );
      }
      response = json(
        {
          error: {
            code: domain ? error.code : "STORAGE_UNAVAILABLE",
            message: domain
              ? error.message
              : "The service is temporarily unavailable. Retry later.",
            requestId,
          },
        },
        status,
        headers,
      );
    }
    r.metrics.observe(
      route,
      response.status,
      (performance.now() - started) / 1000,
    );
    if (!route.startsWith("/health") && route !== "/internal/metrics")
      console.log(
        JSON.stringify({
          requestId,
          method: request.method,
          route,
          status: response.status,
          durationMs: Math.round(performance.now() - started),
        }),
      );
    ctx.waitUntil(r.analytics.drain());
    if (Date.now() - lastCleanup > 15 * 60000) {
      lastCleanup = Date.now();
      ctx.waitUntil(
        r
          .cleanup()
          .catch(() => console.warn("Expired workspace cleanup failed")),
      );
    }
    return response;
  },
};
