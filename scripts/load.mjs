import { performance } from "node:perf_hooks";
const [url, totalText = "1000", concurrencyText = "10"] = process.argv.slice(2);
if (!url || !new URL(url).pathname.startsWith("/r/"))
  throw new Error(
    "Usage: npm run load -- http://localhost:3000/r/CODE [requests] [concurrency]",
  );
const total = Number(totalText),
  concurrency = Number(concurrencyText);
if (
  !Number.isInteger(total) ||
  total < 1 ||
  total > 100000 ||
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 100
)
  throw new Error("Use 1–100000 requests and 1–100 concurrency.");
const latency = [];
const statuses = {};
let next = 0;
const started = performance.now();
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next++ < total) {
      const start = performance.now();
      try {
        const response = await fetch(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
        });
        await response.arrayBuffer();
        statuses[response.status] = (statuses[response.status] ?? 0) + 1;
      } catch {
        statuses.network_error = (statuses.network_error ?? 0) + 1;
      }
      latency.push(performance.now() - start);
    }
  }),
);
latency.sort((a, b) => a - b);
const percentile = (p) =>
  Number(
    latency[
      Math.min(latency.length - 1, Math.floor(latency.length * p))
    ].toFixed(2),
  );
console.log(
  JSON.stringify(
    {
      requests: total,
      concurrency,
      elapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(2)),
      latencyMs: {
        p50: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
      },
      statuses,
    },
    null,
    2,
  ),
);
