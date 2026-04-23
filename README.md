# Cloud-System

## Demo



https://github.com/user-attachments/assets/41c0ec57-80fc-452f-ab19-d53d2a29c953



## Services

This project ships with a Docker Compose setup for:

- PostgreSQL 16
- Redis 7
- Node.js API

Start both services with:

```bash
cp .env.example .env
docker compose up -d
```

Run the API locally with:

```bash
npm install
npm start
```

`npm start` automatically loads values from `.env`.

Open `http://localhost:3000/` for the browser search interface and `http://localhost:3000/logs` for the logs viewer.

PostgreSQL runs [postgres/init.sql](/Users/nicolasarsenault/Desktop/projects/Cloud-System/postgres/init.sql) on first boot only, when the `postgres_data` volume is empty.

If you need to re-run the init script from scratch, remove the Postgres volume first:

```bash
docker compose down -v
docker compose up -d
```

## PostgreSQL Schema

The init SQL creates:

- `logs`
- `search_runs`
- `history`

If you already initialized PostgreSQL before `logs.worker_id` became nullable, the API now runs a compatibility `ALTER TABLE` on startup to drop the old `NOT NULL` constraint.

## API

The backend exposes these endpoints:

```http
GET /
GET /logs
GET /api/logs
GET /listings?retailer=<retailer>&zip=<zip>&query=<query>
GET /health
GET /ready
```

Behavior:

- Returns the static search page from `/`
- Returns the static logs page from `/logs`
- Returns recent PostgreSQL log rows from `/api/logs`
- Returns `200` with cached listings when the Redis cache contains the query result
- Returns `202` with `Processing please wait` and a `requestId` when the query is queued
- Returns the same `202` and existing `requestId` when the same retailer/zip/query is already in flight
- Returns `429` with `rate limited` when a retailer exceeds 5 uncached requests in 1 second
- Returns `429` with `too busy` when the global scrape guardrail is over threshold
- Returns `429` with `circuit open` when a retailer circuit is `OPEN`, or when a `HALF_OPEN` retailer already has a probe in flight
- Returns `400` JSON when `retailer`, `zip`, or `query` is missing or blank
- Returns `503` JSON if Redis is unavailable
- Returns `200` from `/health` when the process is alive
- Returns `200` from `/ready` only when Redis, PostgreSQL, and the startup compatibility check are ready

The browser UI submits searches to `GET /listings` from the same origin. When the API returns `202`, the page shows the `requestId` and automatically retries until cached results are available or an error is returned.
The logs viewer polls `GET /api/logs` on the same origin and renders the newest database log rows first.

API requests are also logged into PostgreSQL:

- every handled request writes a `debug` row into `logs`
- API logs use `worker_id = NULL`
- cache-hit responses also write a row into `history`
- `history.userid` is currently `0` for anonymous API traffic

Runtime tuning is env-configurable via:

- `LOCK_TTL_SECONDS`
- `RETAILER_RATE_LIMIT_PER_SECOND`
- `CIRCUIT_PROBE_TTL_SECONDS`
- `SCRAPE_HOUR_THRESHOLD`
- `LOGS_PAGE_SIZE`

## Worker

The worker also exposes health endpoints on its own HTTP port:

```http
GET /health
GET /ready
```

Behavior:

- `/health` returns `200` when the worker process is alive
- `/ready` returns `200` only when Redis is reachable, consumer groups were initialized, and the worker is not shutting down

Worker runtime is env-configurable via:

- `WORKER_PORT`
- `PGHOST`
- `POSTGRES_PORT`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`

`npm run worker` automatically loads values from `worker.env`.

Worker writes PostgreSQL rows too:

- every processing attempt writes worker logs into `logs`
- worker logs use `worker_id = <WORKER_ID>`
- successful and skipped attempts write `debug` terminal logs
- failed attempts write `error` terminal logs
- every attempt writes one `search_runs` row
- `search_runs.logid` points to the terminal worker log row for that attempt

## Redis Runtime Layout

Redis does not use tables. The expected runtime layout is:

- Queue streams: `queue:retailer:<retailer>`
- Listings cache keys: `cache:listings:<retailer>:<zip>:<normalized_query>`
- In-flight dedupe locks: `lock:listings:<retailer>:<zip>:<normalized_query>`
- Retailer rate-limit keys: `rate:<retailer>:<epoch_second>`
- Global scrape guardrail counter: `scrape_hour:number`
- Circuit state keys: `circuit:<retailer>`
- Circuit half-open probe locks: `circuit-probe:<retailer>`
- Consumer groups: `group:retailer:<retailer>`
- Cache keys with 20 minute TTL: `cache:<namespace>:<key>`
- Locks: `lock:<retailer>:<resource>`
- Spend guardrails by retailer/day: `spend:<retailer>:YYYYMMDD`
- Rate limits by retailer/second: `ratelimit:<retailer>:<window_epoch_second>`
- Circuit breaker counters: `cb:failures:<retailer>`
- Circuit breaker open state: `cb:open:<retailer>`

Cached listings are stored as a raw JSON array with a 20 minute TTL. Queue entries include `requestId`, `retailer`, `zip`, and `query`. In-flight listing locks store the active `requestId` for 5 minutes so duplicate requests reuse the same job instead of enqueueing twice. The API reads `scrape_hour:number` before locking and enqueueing, blocks only when that value is strictly greater than `SCRAPE_HOUR_THRESHOLD`, and leaves counter increments to the worker. Uncached requests also increment a retailer-scoped 1-second key and return `429` once the count is greater than 5.

More detailed Redis behavior is documented in [docs/redis.md](/Users/nicolasarsenault/Desktop/projects/Cloud-System/docs/redis.md).
