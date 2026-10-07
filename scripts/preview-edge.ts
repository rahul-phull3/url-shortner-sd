import { Miniflare } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const mf = new Miniflare({
  modules: true,
  scriptPath: "dist/server/index.js",
  port: 4178,
  compatibilityDate: "2025-11-17",
  compatibilityFlags: ["nodejs_compat"],
  d1Databases: { DB: randomUUID() },
  d1Persist: false,
  bindings: {
    PUBLIC_BASE_URL: "http://localhost:4178",
    METRICS_TOKEN: "test-monitoring-token-32-characters",
  },
});
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
console.log("Browser test server ready on http://localhost:4178");
process.once("SIGTERM", () => {
  void mf.dispose();
});
process.once("SIGINT", () => {
  void mf.dispose();
});
