# URL Shortener

A Node.js and React application for creating, tracking, expiring, and revoking short links. PostgreSQL owns correctness; Redis accelerates destination reads and enforces write quotas. A second deployment adapter runs the same domain service with a persistent D1 database at the edge.

This is project **01 of 15** in a backend engineering portfolio. Its purpose is to make correctness, failure behavior, and architectural tradeoffs inspectable in running code.

## Implemented behavior

- Ten-character cryptographically random base62 codes, custom aliases, and bounded collision retries.
- Database-enforced alias uniqueness and owner-scoped idempotency. Retrying the same request returns the original link.
- Immutable destinations, optional expiry within 365 days, and permanent revocation. Codes are never recycled.
- Private browser workspaces using a random 256-bit HttpOnly cookie. Only its SHA-256 hash is stored.
- Owner-only lists and deletion, keyset pagination, and explicit loading and error states in React.
- Atomic fixed-window write limits: 60 writes per workspace per minute, and 20 new workspaces per client IP per minute.
- Optional destination caching, primary-authoritative state validation, asynchronous daily redirect counts, and graceful shutdown.
- Structured logs, request IDs, protected Prometheus counters/histograms, readiness checks, alert rules, and a reproducible load script.
- SQL migrations, Docker images, local and HTTPS deployment configurations, and automated CI.

**Boundaries:** This is a complete implementation of the behavior above. Browser workspace ownership is a capability model, not account login: losing the cookie or reaching its 30-day expiry loses management access. Redirect counts are best effort and may undercount. A public commercial service needs account recovery, destination moderation, abuse reporting, and administrator takedown before accepting arbitrary users.

## Run locally

Use Node.js 24 and Docker Compose v2.

```bash
docker compose up --build -d
```

Open <http://localhost:3000>. The migration service runs before the API starts. PostgreSQL data survives container replacement in a named volume. Redis holds disposable cache/rate state; it is not the source of truth for links.

For development outside the application container:

```bash
npm ci
cp .env.example .env
docker compose up -d postgres redis
npm run migrate
npm run build
npm start
```

For React hot reload, set `PUBLIC_BASE_URL=http://localhost:5173` in `.env`. Run `npm run dev:api` in one terminal and `npm run dev` in another. Vite proxies API and redirect requests to port 3000. Rebuild the client once before starting the API because the Node server also serves its compiled static assets.

The example monitoring token is for local development. Replace it before any external deployment.

## Architecture

```mermaid
flowchart TD
    Browser["React workspace"] --> Proxy["TLS reverse proxy"]
    Visitor["Link visitor"] --> Proxy
    Proxy --> API["Node.js / Fastify API"]
    API --> Domain["LinkService: lifecycle and invariants"]
    Domain --> SQL["PostgreSQL primary"]
    Domain --> Cache["Redis: immutable destinations"]
    API --> Quotas["Redis: atomic write quotas"]
    API --> Analytics["Bounded asynchronous analytics"]
    Analytics --> SQL
    API --> Logs["Structured logs and request IDs"]
    Monitor["Prometheus"] --> API
```

`server/domain.ts` has no HTTP, database-driver, or Redis-client dependency. It accepts repository and cache ports. `server/sql-repository.ts` contains parameterized SQL and maps stored rows to domain values. PostgreSQL and D1 adapters translate bindings without duplicating link lifecycle rules. The Node and edge HTTP adapters own validation, cookies, headers, response formatting, and rate-limit policy.

The design is a modular monolith: one deployable service with explicit boundaries. Separating link creation, redirects, and analytics into networked microservices would add deployment, consistency, and failure-management work before this workload justifies it.

### Redirect sequence

```mermaid
sequenceDiagram
    participant Visitor
    participant API
    participant Primary
    participant Cache
    Visitor->>API: GET /r/code
    API->>Primary: Read expiry and revocation state
    Primary-->>API: Current state
    alt Missing or inactive
        API-->>Visitor: 404 or 410, no-store
    else Active
        API->>Cache: Read immutable destination
        alt Cache miss or cache unavailable
            API->>Primary: Read destination payload
            Primary-->>API: HTTPS destination
            API->>Cache: Best-effort cache fill
        end
        API-->>Visitor: 302 Location, no-store
        API->>Primary: Asynchronous daily counter increment
    end
```

Every redirect first reads authoritative state from the primary. The cache stores only an immutable URL, never an active flag. Consequently, a cached destination cannot override expiry or revocation. Requests whose state read happened before revocation may still finish with a redirect; state reads after the committed revocation return `410`.

### Stored model

```mermaid
erDiagram
    LINKS ||--o{ CLICK_DAILY : counts
    LINKS {
        string code PK
        uuid owner_id
        string target_url
        string request_hash
        string idempotency_key
        bigint created_at
        bigint expires_at
        bigint revoked_at
    }
    CLICK_DAILY {
        string code PK,FK
        string day PK
        bigint clicks
    }
    SESSIONS {
        string token_hash PK
        uuid owner_id
        bigint expires_at
    }
```

`UNIQUE(owner_id, idempotency_key)` and the code primary key are the arbiters under concurrency. Sessions deliberately have no cascading foreign key to links: cleaning an expired session must not destroy a public link. All timestamps are UTC epoch milliseconds, within JavaScript's safe integer range. PostgreSQL codes use `C` collation so case-sensitive ordering agrees with SQLite/D1.

Indexes support owner pagination `(owner_id, created_at, code)`, session cleanup by expiry, and code state lookup. PostgreSQL adds an index including expiry/revocation fields so the state query can use an index-only scan when visibility permits. The extra index costs storage and mutation work; confirm its benefit with `EXPLAIN (ANALYZE, BUFFERS)` on realistic data.

## Architectural decisions and tradeoffs

| Decision                                   | Why this approach                                                                                                                                                                   | Alternatives and cost                                                                                                                                                                                      | Reconsider when                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Node.js 24 + Fastify                       | Familiar TypeScript stack, explicit request schemas, pooling, and a straightforward HTTP test harness.                                                                              | Spring Boot provides a strong ecosystem for transactional services; it is unnecessary to introduce a second server language here.                                                                          | Another service needs Java libraries or team ownership favors Java.       |
| PostgreSQL as primary                      | Uniqueness, durable idempotency, transactions, indexed ownership, and inspectable SQL fit the data model.                                                                           | A key-value store can scale code lookups but requires other ownership/idempotency access patterns and conditional-write design.                                                                            | Measured primary load remains excessive after indexing and pool tuning.   |
| Random base62 codes                        | Allocation is independent of a central sequence and does not reveal creation order. Rejection sampling discards bytes above 247 to avoid modulo bias.                               | Sequential IDs encoded in base62 simplify collision handling but leak sequence; Snowflake needs coordinated worker IDs and clock policy; hashing a destination conflates ownership, analytics, and expiry. | Write volume or shorter codes justify an ID allocation service.           |
| Ten characters                             | `62^10` is about `8.39 × 10^17` values, or 59.5 bits. At one million generated codes, the approximate probability of at least one collision is `n(n-1)/(2N) ≈ 5.96 × 10^-7`.        | Shorter codes are convenient but collide more often. Custom aliases are intentionally guessable and are not access credentials.                                                                            | Code length becomes a material product constraint.                        |
| Unique insert with conflict handling       | Database constraints remain correct across many API replicas. `INSERT ... ON CONFLICT DO NOTHING RETURNING` either creates a row or leads to an idempotency lookup/collision retry. | A process mutex does not coordinate replicas; checking availability before insertion races.                                                                                                                | A cross-region write design replaces the single primary.                  |
| Owner-scoped permanent idempotency         | One row atomically holds both the link and the request fingerprint. Lost responses can be retried safely without a second transactional table.                                      | A TTL idempotency table reduces retention but permits old retries to create duplicates and needs transactional coordination.                                                                               | A retention policy or bulk ingestion makes permanent keys expensive.      |
| Primary state read before cached payload   | Expiry and revocation stay authoritative even with cache loss, delayed invalidation, or stale fills.                                                                                | Caching complete records removes a database round trip but permits bounded stale revocation; invalidation alone races with concurrent fills.                                                               | The product explicitly accepts a documented stale-revocation window.      |
| Immutable targets and permanent tombstones | Old bookmarks cannot silently start pointing at a new destination or a new owner. Cache entries need no distributed invalidation.                                                   | Editable targets need versioned cache keys; recycling aliases risks redirect hijacking.                                                                                                                    | A product requirement justifies versioned edits with equivalent safety.   |
| Redis fixed-window quotas                  | One Lua script increments and expires a bucket atomically. Limits work across Node replicas.                                                                                        | Sliding windows/token buckets smooth bursts but have more state and operational complexity. Fixed windows allow up to two windows' quota near a boundary.                                                  | Boundary bursts become an observed problem.                               |
| Redis `noeviction`                         | Rate counters cannot disappear silently under cache eviction and accidentally admit extra writes. Cache failures fall back to SQL; unavailable quota storage rejects writes.        | An LRU policy improves cache occupancy but weakens quota enforcement when counters are evicted. Sharing cache and quotas also shares their memory budget.                                                  | Split cache and rate limiting into separate Redis deployments.            |
| Browser capability ownership               | No credentials are collected; an unguessable HttpOnly cookie and hashed server record protect owner operations.                                                                     | Account login adds recovery and cross-device access, but requires password/OIDC operations and a user model.                                                                                               | The service becomes public-facing or workspace recovery is required.      |
| Best-effort asynchronous analytics         | A failed counter write does not prevent a valid redirect, and pending work is bounded at 256 writes per process/isolate.                                                            | Synchronous writes couple redirect latency to analytics. A durable queue gives retry guarantees but introduces a broker and duplicate-event handling.                                                      | Counters become billing/audit data or hot links contend on one daily row. |
| Separate HTTP adapters at the edge         | Workers use Fetch and only a subset of Node APIs; a small adapter keeps the domain and repository shared without a server-framework compatibility dependency.                       | Forcing a full Node HTTP framework into the edge runtime creates unsupported-API failure paths. Two adapters require contract tests.                                                                       | The host gains complete framework support or the edge edition is retired. |
| D1 for the hosted edition                  | Durable SQL storage can be provisioned with the edge application without an external PostgreSQL account. Primary-pinned sessions preserve lifecycle semantics.                      | It is not PostgreSQL or Redis, and does not establish equivalent throughput or failover behavior.                                                                                                          | The deployed workload calls for the full PostgreSQL/Redis topology.       |

### Creation under retries

The service normalizes the request and hashes its target/alias/absolute expiry. It checks for a prior owner/key pair, then attempts a unique insert. If another request wins the insert, a subsequent primary query finds the committed row and compares its fingerprint. Same key and same payload returns `200` with `Idempotent-Replayed: true`; same key and a different payload returns `409`. A random-code collision retries up to five times; an alias collision returns `409` immediately. A replay is checked before expiry validation, so a legitimate retry after the original link expires still returns the original row.

Creation is **not** global URL deduplication. Two owners or two distinct idempotency keys may legitimately create different links for the same destination.

## API contract

| Method and path                         | Ownership                          | Result                                                         |
| --------------------------------------- | ---------------------------------- | -------------------------------------------------------------- |
| `POST /api/v1/session`                  | New or existing browser            | Workspace cookie; `201` new, `200` reused.                     |
| `GET /api/v1/session`                   | Optional cookie                    | Whether the cookie resolves to an active workspace.            |
| `POST /api/v1/links`                    | Workspace cookie + idempotency key | `201` creation, `200` replay.                                  |
| `GET /api/v1/links?limit=20&cursor=...` | Workspace cookie                   | Owned links, counts, and next cursor. Limit 1–100.             |
| `DELETE /api/v1/links/:code`            | Workspace cookie                   | Permanent revocation; repeated owned revocation returns `204`. |
| `GET /r/:code`                          | Public at the application layer    | `302`; `404` unknown; `410` expired/revoked.                   |
| `HEAD /r/:code`                         | Public at the application layer    | Same destination/status, without a click increment.            |
| `GET /health/live`                      | Internal deployment access         | Process liveness.                                              |
| `GET /health/ready`                     | Internal deployment access         | `200` ready or `503` when required dependencies fail.          |
| `GET /internal/metrics`                 | Separate monitoring bearer token   | Prometheus exposition.                                         |

Cookie-authenticated mutations require `X-Requested-With: shortlink`. When `Origin` exists it must equal the configured `PUBLIC_BASE_URL`. No permissive CORS headers are sent. Session cookies are HttpOnly, SameSite=Strict, and Secure on HTTPS. The configured public origin, rather than an untrusted Host header, builds short URLs.

```bash
curl -sS -c /tmp/shortlink.cookies \
  -H 'X-Requested-With: shortlink' \
  -X POST http://localhost:3000/api/v1/session

curl -sS -b /tmp/shortlink.cookies \
  -H 'X-Requested-With: shortlink' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-request-0001' \
  -d '{"targetUrl":"https://example.com/guide","alias":"my-guide"}' \
  http://localhost:3000/api/v1/links

curl -i http://localhost:3000/r/my-guide
```

For expiring links add an absolute RFC 3339 `expiresAt`, such as a future timestamp within 365 days. Retried creates must keep the original body and key. The React client retains both after a network failure; changing form inputs starts a new command.

Errors use `{"error":{"code":"...","message":"...","requestId":"..."}}`. Expected errors include `INVALID_REQUEST`, `INVALID_TARGET`, `INVALID_ALIAS`, `INVALID_EXPIRY`, `ALIAS_TAKEN`, `IDEMPOTENCY_CONFLICT`, `WORKSPACE_REQUIRED`, `ORIGIN_REJECTED`, `RATE_LIMITED`, `LINK_NOT_FOUND`, and `LINK_GONE`. Transient dependency errors return `503`; rate rejections return `429` plus `Retry-After`. Neither response grants permission to bypass ownership checks.

## Failure behavior

| Failure                                           | Implemented outcome                                                                                           | Recovery                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Client times out after an insert commits          | Retry with the same body/key returns the committed link.                                                      | Reuse the key, rather than starting an ambiguous new command.                  |
| Concurrent alias claim                            | One committed winner, other requests `409`.                                                                   | Choose another alias.                                                          |
| Destination cache unavailable                     | Read destination from the primary; Node cache timeout is 200 ms with a 5-second circuit pause.                | Restore Redis; no link data reconstruction is needed.                          |
| Redis unavailable or quota storage full           | Node mutations reject with `503`; redirects still use PostgreSQL. Readiness is `503`.                         | Restore capacity/connectivity. Rate history may reset after Redis replacement. |
| Primary database unavailable                      | Redirects reject even if a destination is cached.                                                             | Restore the primary; accepting stale state would weaken revocation.            |
| Analytics write fails or pending limit is reached | Redirect succeeds; a loss counter increments.                                                                 | Inspect analytics loss alerts; counts cannot be reconstructed exactly.         |
| Link expires or is revoked                        | Subsequent primary state reads return `410`, with `no-store`.                                                 | This lifecycle change is permanent.                                            |
| Process restarts                                  | Links and workspace hashes remain in durable SQL; caches repopulate.                                          | Restore service against the same database.                                     |
| Shutdown                                          | Node stops accepting requests, drains pending analytics, closes pools; a ten-second deadline bounds shutdown. | Use container grace periods above that deadline.                               |
| Cookies cleared or workspace expires              | A new workspace has no ownership of old links. Existing redirects continue according to link lifecycle.       | Account recovery is outside this edition.                                      |

The service never fetches destination URLs, so it does not operate a server-side URL preview/SSRF endpoint. HTTPS, credential, loop, local-hostname, and private IPv4 literal checks reduce obvious misuse. DNS reputation and content safety are not established by URL syntax. Literal IPv6 destinations are deliberately unsupported in this edition.

## Observability

Logs contain generated request IDs, methods, route templates, status codes, and durations. They exclude request bodies, cookies, destination URLs, raw IPs, and credentials. Error logs record error classes without printing driver connection strings or SQL details. Route templates, not short codes or owner IDs, label metrics.

- `shortlink_http_requests_total{route,status_class}`
- `shortlink_http_duration_seconds_{bucket,sum,count}{route,status_class}`
- `shortlink_events_total{event}` for cache hits/misses/errors, rate rejections, analytics drops/errors, and service errors.

`deploy/alerts.yml` includes API availability, 5xx ratio, slow successful redirects, and analytics-loss alerts. Proposed targets are 99.9% successful redirect availability and a 250 ms p95 under an agreed workload; these are design targets, not claimed measurements. Prometheus `up` checks the scrape endpoint rather than database readiness, so add an external synthetic readiness/redirect probe for operational coverage. Alert delivery requires connecting Prometheus to an Alertmanager; rules alone do not send notifications.

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:3000/internal/metrics
npm run load -- http://localhost:3000/r/my-guide 1000 10
```

The load script does not follow redirects to the destination. It reports status counts and p50/p95/p99 response time; it does not certify a throughput limit. Compare cold/warm cache, database failure, and Redis failure with the same data and hardware before drawing capacity conclusions.

## Deployment

### Full Node.js, PostgreSQL, and Redis edition

The production Compose file runs Caddy for HTTPS, exposes only ports 80/443, and keeps database/Redis/API ports inside the container network. This is a **single-host deployment**, not high availability.

1. Provision a Linux host with Docker Engine and Compose v2. Point a domain's DNS to the host and allow 80/443.
2. Put real values in the ignored `.env`: `PUBLIC_HOST`, `PUBLIC_BASE_URL=https://your-domain`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, and `METRICS_TOKEN`. Generate hexadecimal passwords/tokens with `openssl rand -hex 32` so connection URLs need no password escaping. Set restrictive file permissions.
3. Build, migrate, and start:

```bash
docker compose --env-file .env -f deploy/compose.production.yaml up --build -d
docker compose --env-file .env -f deploy/compose.production.yaml ps
```

4. Verify the HTTPS page, create a link, check the redirect without following it, revoke it, and check `410`. Confirm persisted ownership by reloading the browser.
5. To enable monitoring, create ignored `secrets/metrics-token` containing exactly `METRICS_TOKEN`, then start with `--profile monitoring`. Prometheus is exposed only on host loopback port 9090. Connect over an SSH tunnel.
6. Schedule PostgreSQL backups off the host and rehearse restore. Redis cache/rate state is disposable; PostgreSQL contains the links, ownership hashes, and recorded counts.

Example backup:

```bash
mkdir -p backups
docker compose --env-file .env -f deploy/compose.production.yaml \
  exec -T postgres pg_dump -U shortlink -d shortlink -Fc > backups/shortlink.dump
```

Restore into a separate empty PostgreSQL database with `pg_restore`, run migrations, and verify active/expired/revoked links and cookie ownership before switching traffic. Backups include private destinations and session hashes; restrict access. Named volumes and backup files on the same host do not protect against host loss.

Migrations use an advisory lock and one transaction per file, record a checksum, and reject edits to applied files. Append new migrations. On a migration failure fix the unapplied migration and retry; application replicas should not independently change schemas. Prefer additive compatible changes before rolling application versions back, because application rollback does not undo a committed database migration.

For higher availability, use managed PostgreSQL with tested failover/PITR, managed Redis, multiple API replicas behind a trusted load balancer, external metrics/log storage, and deployment health gates. Set `TRUST_PROXY_HOPS` to the actual controlled proxy topology; never expose the API directly while trusting arbitrary forwarding headers.

### Persistent hosted edge edition

The edge build is `npm run build:edge`; output is `dist/server/index.js`. Bind a persistent D1 database as `DB`, configure `PUBLIC_BASE_URL` and a secret `METRICS_TOKEN`, and enable Node compatibility for the crypto/net APIs. Apply the generated `drizzle/*.sql` migrations before activating a version. The migrations are schema-only; the service does not create tables during requests.

| Concern            | Full Node edition                | Hosted edge edition                                         |
| ------------------ | -------------------------------- | ----------------------------------------------------------- |
| HTTP               | Fastify on Node.js 24            | Fetch adapter in Workers                                    |
| Durable database   | PostgreSQL                       | SQLite-compatible D1                                        |
| Write quotas       | Redis Lua                        | D1 atomic UPSERT buckets                                    |
| Destination cache  | Redis, one-hour TTL              | Bounded 128-entry isolate cache, one-hour TTL               |
| Primary state      | PostgreSQL primary connection    | D1 `first-primary` sessions                                 |
| Analytics lifetime | Drained during graceful shutdown | Retained with `waitUntil`                                   |
| Metrics            | Per process, scrape replicas     | Per isolate, not an aggregate global counter                |
| Access             | Application redirects are public | The host's access policy may additionally restrict visitors |

The hosted edition is a functioning persistent deployment, not a frontend mock. It demonstrates lifecycle correctness, but does not demonstrate Redis operations, PostgreSQL failover, or throughput equivalence. The current hosted access policy is private; making it public also requires deciding how to handle the abuse/account-recovery boundaries described above. Deployment-specific hosting metadata is kept outside this repository.

## Verification

```bash
npm run format:check
npm run check
npm run test:edge
npx playwright install chromium
npm run test:ui
```

`npm test` executes real PostgreSQL SQL in PGlite for the Node API tests, rather than mocking repository behavior. It covers concurrent idempotency, alias contention, bounded collision retries, expiry, revocation with a stale cache, cross-owner denial, keyset ties, quota responses, CSRF, session expiry, HEAD semantics, and server restart. Domain tests cover unsafe destinations, code format, cursor bounds, configuration, metrics, and bounded analytics failure handling.

`test:edge` starts a real local Worker/D1 runtime, applies generated migrations, and checks the React assets plus the API lifecycle. Playwright checks browser creation, reload persistence, validation that preserves input, permanent revocation, runtime errors, and desktop/mobile overflow.

Run full dependency integration against **disposable** services:

```bash
TEST_DATABASE_URL=postgresql://shortlink:test_password@localhost:5432/shortlink_test \
TEST_REDIS_URL=redis://localhost:6379 npm run test:integration
```

The integration test refuses a database whose name does not end in `_test`, creates an isolated schema, checks forty concurrent inserts through pooled PostgreSQL connections, and verifies one hundred concurrent Redis quota attempts admit exactly ten requests. It cleans up its schema and known cache keys; it does not flush Redis. CI provisions those services, runs all suites, and builds the container image.

PGlite is useful SQL-engine evidence; it does not establish socket/TLS behavior, database failover, Docker operation, or multi-host capacity. The PostgreSQL/Redis integration job and image build provide separate checks in an environment with those services. CI results must be inspected after repository publication rather than assumed from the workflow file.

## Scale and next decisions

For a sizing exercise, assume ten million stored links, one hundred creates/second, and ten thousand redirects/second. These are planning assumptions, not verified capacity. A destination may use up to 2 KiB before indexes, metadata, and analytics; measure actual row and index sizes with representative URLs before purchasing storage.

The strict redirect path still hits the primary on every request, even on a cache hit. The cache avoids a second destination-payload query, not the first state lookup. The PostgreSQL pool is bounded at ten connections per replica, with 2-second connection and 3-second statement deadlines. Increasing replicas also increases total database connections; size those budgets together.

Do not add sharding merely because shorteners are read-heavy. First measure query plans, cache hit rate, primary CPU/I/O, lock contention on daily counters, and pool wait time. If redirect reads dominate, decide whether the product accepts bounded stale revocation before using replica/full-record-cache reads. If analytics dominate, introduce a durable event queue, event IDs, idempotent consumers, batching, and a documented delivery guarantee. If storage remains the limiter, hash-partition by code and design a separate owner-list index and a global alias policy before migrating.

There is no claim of exactly-once analytics, globally linearizable active-active writes, public abuse protection, or automatic multi-region failover in this implementation.

## References

The original project reference was <https://lnkd.in/gbca-aHQ>. Its destination could not be retrieved during implementation; no content from that inaccessible page is claimed as reviewed. The following primary sources informed the chosen primitives:

- [PostgreSQL INSERT / ON CONFLICT](https://www.postgresql.org/docs/17/sql-insert.html)
- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html)
- [Redis INCR and atomic rate limiting](https://redis.io/docs/latest/commands/incr/)
- [Fastify testing](https://fastify.dev/docs/latest/Guides/Testing/)
- [Node.js release lifecycle](https://nodejs.org/en/about/previous-releases)
- [Workers Node API compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [D1 sessions and read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)

## Portfolio sequence

Projects are implemented, verified, and published one at a time. Work pauses after each publication for review.

| Project                     | Planned backend              | Frontend / main storage            |
| --------------------------- | ---------------------------- | ---------------------------------- |
| 01 URL Shortener            | Node.js / Fastify            | React / PostgreSQL, Redis          |
| 02 Distributed Chat         | Node.js                      | React / PostgreSQL, Redis          |
| 03 Content Delivery Network | Node.js                      | React / object storage, Redis      |
| 04 Ride Sharing             | Java / Spring Boot           | React / PostgreSQL with PostGIS    |
| 05 Online Marketplace       | Java / Spring Boot           | React / PostgreSQL                 |
| 06 Pathfinding Visualizer   | Node.js / TypeScript         | React / graph fixtures             |
| 07 Sorting Visualizer       | Node.js / TypeScript         | React / deterministic fixtures     |
| 08 Route Planning           | Java / Spring Boot           | React / PostgreSQL with PostGIS    |
| 09 Data Structure Library   | Java library and Spring demo | React / no database by default     |
| 10 Dynamic Programming Tool | Java / Spring Boot           | React / PostgreSQL for progress    |
| 11 Event-Driven Orders      | Java / Spring Boot           | React / PostgreSQL, Kafka          |
| 12 Hotel Booking            | Java / Spring Boot           | React / PostgreSQL                 |
| 13 Inventory Management     | Java / Spring Boot           | React / PostgreSQL                 |
| 14 E-commerce Backend       | Node.js / NestJS             | React / PostgreSQL, Redis          |
| 15 Blogging Platform        | Node.js / NestJS             | React / PostgreSQL, object storage |

The remaining rows are a plan, not shipped applications. Each project's final database and deployment choice will follow its own invariants and workload.
