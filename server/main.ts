import staticFiles from "@fastify/static";
import { resolve } from "node:path";
import { readConfig } from "./config.ts";
import { connectPostgres } from "./postgres.ts";
import { connectRedis } from "./redis.ts";
import { buildApp } from "./app.ts";
import { Metrics } from "./observability.ts";

const config = readConfig();
if (!process.env.DATABASE_URL || !process.env.REDIS_URL)
  throw new Error("Set DATABASE_URL and REDIS_URL.");
const metrics = new Metrics();
const db = connectPostgres(process.env.DATABASE_URL);
const redis = connectRedis(process.env.REDIS_URL, metrics);
const { app, analytics } = buildApp(
  { repo: db.repo, cache: redis.cache, limiter: redis.limiter, metrics },
  config,
);
db.pool.on("error", () => app.log.error("Idle database connection failed"));
await redis.client.connect();
await db.repo.ping();
await app.register(staticFiles, {
  root: resolve("dist/client"),
  prefix: "/assets/",
  decorateReply: true,
  wildcard: true,
  serve: false,
});
app.get("/", (_request, reply) => reply.sendFile("index.html"));
app.get("/assets/*", (request, reply) =>
  reply
    .header("Cache-Control", "public, max-age=31536000, immutable")
    .sendFile(
      (request.params as { "*": string })["*"],
      resolve("dist/client/assets"),
    ),
);

const cleanupTimer = setInterval(() => {
  void db.repo
    .cleanup(Date.now())
    .catch(() => app.log.warn("Session cleanup failed"));
}, 15 * 60000);
cleanupTimer.unref();
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  clearInterval(cleanupTimer);
  await app.close();
  await analytics.drain();
  await redis.client.close();
  await db.pool.end();
  clearTimeout(deadline);
}
process.once("SIGTERM", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown();
});
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3000) });
