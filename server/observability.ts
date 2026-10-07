import type { Repository } from "./ports.ts";

const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, Infinity];
type Measurement = { count: number; sum: number; buckets: number[] };
export class Metrics {
  readonly requests = new Map<string, Measurement>();
  readonly events = new Map<string, number>();
  observe(route: string, status: number, seconds: number) {
    const key = `route="${route}",status_class="${Math.floor(status / 100)}xx"`;
    const item = this.requests.get(key) ?? {
      count: 0,
      sum: 0,
      buckets: buckets.map(() => 0),
    };
    item.count++;
    item.sum += seconds;
    buckets.forEach((b, i) => {
      if (seconds <= b) item.buckets[i]++;
    });
    this.requests.set(key, item);
  }
  event(
    name:
      | "cache_hit"
      | "cache_miss"
      | "cache_error"
      | "analytics_drop"
      | "analytics_error"
      | "rate_limited"
      | "storage_error",
  ) {
    this.events.set(name, (this.events.get(name) ?? 0) + 1);
  }
  render() {
    const lines = [
      "# HELP shortlink_http_requests_total Completed HTTP requests.",
      "# TYPE shortlink_http_requests_total counter",
      "# HELP shortlink_http_duration_seconds End-to-end HTTP response duration.",
      "# TYPE shortlink_http_duration_seconds histogram",
    ];
    for (const [labels, m] of this.requests) {
      lines.push(`shortlink_http_requests_total{${labels}} ${m.count}`);
      buckets.forEach((b, i) =>
        lines.push(
          `shortlink_http_duration_seconds_bucket{${labels},le="${b === Infinity ? "+Inf" : b}"} ${m.buckets[i]}`,
        ),
      );
      lines.push(
        `shortlink_http_duration_seconds_sum{${labels}} ${m.sum}`,
        `shortlink_http_duration_seconds_count{${labels}} ${m.count}`,
      );
    }
    lines.push(
      "# HELP shortlink_events_total Bounded operational event counters.",
      "# TYPE shortlink_events_total counter",
    );
    for (const [event, value] of this.events)
      lines.push(`shortlink_events_total{event="${event}"} ${value}`);
    return lines.join("\n") + "\n";
  }
}

export class Analytics {
  readonly pending = new Set<Promise<void>>();
  readonly repo: Repository;
  readonly metrics: Metrics;
  constructor(repo: Repository, metrics: Metrics) {
    this.repo = repo;
    this.metrics = metrics;
  }
  record(code: string, now: number) {
    if (this.pending.size >= 256) {
      this.metrics.event("analytics_drop");
      return;
    }
    const work = this.repo
      .recordClick(code, new Date(now).toISOString().slice(0, 10))
      .catch(() => {
        this.metrics.event("analytics_error");
      })
      .finally(() => {
        this.pending.delete(work);
      });
    this.pending.add(work);
  }
  async drain() {
    await Promise.allSettled([...this.pending]);
  }
}
