import Fastify, { LogController } from "fastify";
import cookie from "@fastify/cookie";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  AppError,
  LinkService,
  decodeCursor,
  encodeCursor,
  sha256,
} from "./domain.ts";
import type { CreateInput } from "./domain.ts";
import type { Repository, RateLimiter, TargetCache, Session } from "./ports.ts";
import type { Config } from "./config.ts";
import { Analytics, Metrics } from "./observability.ts";
import type { FastifyRequest, FastifyReply } from "fastify";

const codeParams = {
  type: "object",
  required: ["code"],
  properties: { code: { type: "string", pattern: "^[a-zA-Z0-9_-]{4,32}$" } },
};
export function buildApp(
  deps: {
    repo: Repository;
    cache: TargetCache;
    limiter: RateLimiter;
    metrics?: Metrics;
    now?: () => number;
    code?: () => string;
  },
  config: Config,
) {
  const app = Fastify({
    logger: config.logLevel === "silent" ? false : { level: config.logLevel },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 8192,
    requestTimeout: 10000,
    connectionTimeout: 15000,
    keepAliveTimeout: 5000,
    trustProxy:
      config.trustProxyHops === 0
        ? false
        : (_address: string, hop: number) => hop < config.trustProxyHops,
    genReqId: () => randomUUID(),
  });
  const now = deps.now ?? Date.now;
  const metrics = deps.metrics ?? new Metrics();
  const service = new LinkService(
    deps.repo,
    deps.cache,
    config.baseUrl,
    now,
    deps.code,
  );
  const analytics = new Analytics(deps.repo, metrics);
  const resolvedSessions = new WeakMap<FastifyRequest, Session>();
  app.register(cookie);

  async function session(request: FastifyRequest) {
    const cached = resolvedSessions.get(request);
    if (cached) return cached;
    const token = request.cookies.sl_session;
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const s = await deps.repo.getSession(sha256(token), now());
    if (s) resolvedSessions.set(request, s);
    return s;
  }
  async function owner(request: FastifyRequest) {
    const s = await session(request);
    if (!s)
      throw new AppError(
        401,
        "WORKSPACE_REQUIRED",
        "Start or reopen your workspace.",
      );
    return s.ownerId;
  }
  function checkWriteOrigin(request: FastifyRequest) {
    if (
      request.headers["x-requested-with"] !== "shortlink" ||
      (request.headers.origin !== undefined &&
        request.headers.origin !== config.baseUrl)
    )
      throw new AppError(
        403,
        "ORIGIN_REJECTED",
        "The request must come from this workspace.",
      );
  }
  async function rate(key: string, limit: number, reply: FastifyReply) {
    let result;
    try {
      result = await deps.limiter.consume(key, limit, 60);
    } catch {
      throw new AppError(
        503,
        "RATE_LIMITER_UNAVAILABLE",
        "Writes are temporarily unavailable. Retry later.",
      );
    }
    reply
      .header("RateLimit-Limit", String(limit))
      .header("RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      metrics.event("rate_limited");
      reply.header("Retry-After", String(result.retryAfter));
      throw new AppError(
        429,
        "RATE_LIMITED",
        "Too many requests. Wait before trying again.",
      );
    }
  }

  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("X-Request-Id", request.id)
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY")
      .header("Cache-Control", "no-store")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      )
      .header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (config.baseUrl.startsWith("https:"))
      reply.header("Strict-Transport-Security", "max-age=31536000");
  });
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? "unmatched";
    metrics.observe(route, reply.statusCode, reply.elapsedTime / 1000);
    if (!route.startsWith("/health") && route !== "/internal/metrics")
      app.log.info(
        {
          requestId: request.id,
          method: request.method,
          route,
          status: reply.statusCode,
          durationMs: Math.round(reply.elapsedTime),
        },
        "request completed",
      );
    if (
      route === "/r/:code" &&
      request.method === "GET" &&
      reply.statusCode === 302
    )
      analytics.record((request.params as { code: string }).code, now());
  });
  app.setErrorHandler((error, request, reply) => {
    const isDomain = error instanceof AppError;
    const validation = !!(error as { validation?: unknown }).validation;
    const frameworkStatus = (error as { statusCode?: number }).statusCode;
    const status = isDomain
      ? error.status
      : validation
        ? 400
        : frameworkStatus && frameworkStatus >= 400 && frameworkStatus < 500
          ? frameworkStatus
          : 503;
    const code = isDomain
      ? error.code
      : status === 413
        ? "BODY_TOO_LARGE"
        : status < 500
          ? "INVALID_REQUEST"
          : "STORAGE_UNAVAILABLE";
    const message = isDomain
      ? error.message
      : status === 413
        ? "The request body is too large."
        : status < 500
          ? "Check the request fields and try again."
          : "The service is temporarily unavailable. Retry later.";
    if (status >= 500) {
      metrics.event("storage_error");
      app.log.error(
        {
          requestId: request.id,
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "request failed",
      );
    }
    reply
      .code(status)
      .send({ error: { code, message, requestId: request.id } });
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: "This route does not exist.",
        requestId: request.id,
      },
    }),
  );

  app.get("/health/live", async () => ({ status: "alive" }));
  app.get("/health/ready", async (_request, reply) => {
    const checks = await Promise.allSettled([
      deps.repo.ping(),
      deps.limiter.ping(),
    ]);
    const ready = checks.every((c) => c.status === "fulfilled");
    return reply
      .code(ready ? 200 : 503)
      .send({ status: ready ? "ready" : "unavailable" });
  });
  app.get("/internal/metrics", async (request, reply) => {
    const provided = request.headers.authorization ?? "";
    if (
      !timingSafeEqual(
        Buffer.from(sha256(provided)),
        Buffer.from(sha256(`Bearer ${config.metricsToken}`)),
      )
    )
      throw new AppError(
        401,
        "UNAUTHORIZED",
        "A monitoring token is required.",
      );
    return reply
      .type("text/plain; version=0.0.4; charset=utf-8")
      .send(metrics.render());
  });
  app.get("/api/v1/session", async (request) => ({
    active: !!(await session(request)),
  }));
  app.post("/api/v1/session", async (request, reply) => {
    checkWriteOrigin(request);
    const current = await session(request);
    if (current)
      return {
        active: true,
        expiresAt: new Date(current.expiresAt).toISOString(),
      };
    await rate(`session:${sha256(request.ip)}`, 20, reply);
    const token = Buffer.from(randomBytes(32)).toString("hex");
    const s = { ownerId: randomUUID(), expiresAt: now() + 30 * 86400000 };
    await deps.repo.putSession(sha256(token), s);
    reply.setCookie("sl_session", token, {
      httpOnly: true,
      secure: config.baseUrl.startsWith("https:"),
      sameSite: "strict",
      path: "/",
      maxAge: 30 * 86400,
    });
    return reply
      .code(201)
      .send({ active: true, expiresAt: new Date(s.expiresAt).toISOString() });
  });
  app.post<{ Body: CreateInput }>(
    "/api/v1/links",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["targetUrl"],
          properties: {
            targetUrl: { type: "string", minLength: 8, maxLength: 2048 },
            alias: { type: "string", minLength: 4, maxLength: 32 },
            expiresAt: { type: "string", format: "date-time" },
          },
        },
      },
    },
    async (request, reply) => {
      checkWriteOrigin(request);
      const ownerId = await owner(request);
      await rate(`write:${ownerId}`, 60, reply);
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string")
        throw new AppError(
          400,
          "INVALID_IDEMPOTENCY_KEY",
          "Supply an Idempotency-Key.",
        );
      const result = await service.create(ownerId, request.body, key);
      reply.header("Idempotent-Replayed", String(result.replayed));
      return reply
        .code(result.replayed ? 200 : 201)
        .send(service.view(result.link));
    },
  );
  app.get<{ Querystring: { limit?: number; cursor?: string } }>(
    "/api/v1/links",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100 },
            cursor: { type: "string", maxLength: 160 },
          },
        },
      },
    },
    async (request) => {
      const ownerId = await owner(request);
      const limit = request.query.limit ?? 20;
      const rows = await deps.repo.listLinks(
        ownerId,
        limit + 1,
        decodeCursor(request.query.cursor),
      );
      const more = rows.length > limit;
      const page = rows.slice(0, limit);
      const totals = await deps.repo.clickTotals(
        ownerId,
        page.map((l) => l.code),
      );
      return {
        items: page.map((l) => ({
          ...service.view(l),
          clicks: totals[l.code] ?? 0,
        })),
        nextCursor:
          more && page.length ? encodeCursor(page[page.length - 1]) : null,
      };
    },
  );
  app.delete<{ Params: { code: string } }>(
    "/api/v1/links/:code",
    { schema: { params: codeParams } },
    async (request, reply) => {
      checkWriteOrigin(request);
      const ownerId = await owner(request);
      await rate(`write:${ownerId}`, 60, reply);
      if (!(await deps.repo.revoke(ownerId, request.params.code, now())))
        throw new AppError(
          404,
          "LINK_NOT_FOUND",
          "This link is not in your workspace.",
        );
      return reply.code(204).send();
    },
  );
  app.get<{ Params: { code: string } }>(
    "/r/:code",
    { schema: { params: codeParams } },
    async (request, reply) => {
      const target = await service.resolve(request.params.code);
      return reply.header("Location", target).code(302).send();
    },
  );
  return { app, analytics, metrics };
}
