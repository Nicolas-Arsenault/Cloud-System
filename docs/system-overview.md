# System Overview

## Purpose

This project is a small distributed scraping system built around three main goals:

- return cached listing results quickly when they already exist
- avoid duplicate scraping work when the same request arrives multiple times
- isolate retailer-specific failures so one bad integration does not take down the whole system

The system is intentionally simple: the API accepts requests and coordinates access control, Redis is used for short-lived runtime state and queues, PostgreSQL stores durable logs and history, and a separate worker process performs the actual scrape work.

## Main Components

### API

The API is a Node.js Express service started with `npm start`. It loads configuration from `.env`.

Responsibilities:

- serve the browser UI from `/`
- serve the logs UI from `/logs`
- expose `GET /listings`
- check Redis cache before doing anything expensive
- reject requests when retailer rate limits, global load protection, or circuit breaker rules say the system should not enqueue more work
- deduplicate uncached requests before queueing
- write API logs and cache-hit history into PostgreSQL
- expose `/health` and `/ready`

The API does not perform the scrape itself. On a cache miss it only decides whether the request is allowed to become a job.

### Worker

The worker is a separate Node.js process started with `npm run worker`. It loads configuration from `worker.env`.

Responsibilities:

- create and use one Redis consumer group per retailer stream
- limit concurrent work per retailer with configurable semaphores
- reclaim pending work that has been abandoned for more than 5 minutes
- check circuit state again before processing
- increment the global scrape counter when a scrape starts
- simulate retailer-specific scraping and return mock data
- write results into Redis cache
- clear dedupe locks when work reaches a terminal outcome
- acknowledge completed or skipped stream messages
- write worker logs and `search_runs` rows into PostgreSQL
- expose `/health` and `/ready`

### Redis

Redis is the runtime coordination layer. It stores:

- retailer job streams
- cached listing results
- in-flight dedupe locks
- retailer request rate-limit buckets
- a global scrape guardrail counter
- retailer failure counters
- circuit breaker state
- half-open probe locks
- retry metadata for pending worker messages

Redis data is mostly short-lived and operational. It is used to coordinate API and worker behavior in near real time.

### PostgreSQL

PostgreSQL is the durable system of record for observability and request history.

It stores:

- `logs`: API and worker log rows
- `search_runs`: one row per worker attempt
- `history`: API-level query/result history for cache hits

It is not currently used as the primary job queue or cache.

## End-to-End Request Lifecycle

### 1. User calls the API

The browser or any HTTP client sends:

```http
GET /listings?retailer=<retailer>&zip=<zip>&query=<query>
```

The API validates that all three query parameters are present and non-empty. Invalid requests return `400`.

### 2. API checks Redis cache

The API normalizes the request into a deterministic cache key:

```text
cache:listings:<retailer>:<zip>:<normalized_query>
```

If cached data exists:

- the API returns `200`
- the response includes the cached listings
- the API writes a `debug` log row into PostgreSQL
- the API writes a `history` row into PostgreSQL

This is the fast path. No queueing or worker activity is needed.

### 3. API applies retailer rate limiting

If the result is not cached, the API increments a one-second retailer bucket:

```text
rate:<retailer>:<epoch_second>
```

Behavior:

- requests `1` through the configured limit are allowed
- requests above the limit return `429 {"error":"rate limited"}`
- cached responses bypass this limiter entirely

The current default is `5` uncached requests per second per retailer, but this is configurable through `.env`.

### 4. API checks the global scrape guardrail

The API reads the global scrape counter:

```text
scrape_hour:number
```

This key is incremented by workers when they start scrape work. The API only reads it.

Behavior:

- if the value is greater than `SCRAPE_HOUR_THRESHOLD`, the API returns `429 {"error":"too busy"}`
- if the value is missing, it is treated as `0`
- cached responses bypass this guardrail because they do not create new work

### 5. API checks retailer circuit state

The API reads:

```text
circuit:<retailer>
```

Behavior:

- if the state is `OPEN`, the API returns `429 {"error":"circuit open"}`
- if the state is `HALF_OPEN`, the API allows only one probe request at a time by claiming `circuit-probe:<retailer>`
- if the state is missing or effectively closed, processing continues

This prevents more work from being sent to a retailer that is currently unhealthy.

### 6. API deduplicates in-flight work

Before enqueueing, the API attempts to acquire a Redis lock:

```text
lock:listings:<retailer>:<zip>:<normalized_query>
```

The lock value is the active `requestId`.

Behavior:

- if the lock is created, this request owns the enqueue
- if the lock already exists, the API reuses the existing `requestId` and does not enqueue another job

This is the main protection against duplicate uncached requests.

### 7. API enqueues into the retailer stream

On a new cache miss that wins the dedupe lock, the API appends a message to:

```text
queue:retailer:<retailer>
```

The stream entry includes:

- `requestId`
- `retailer`
- `zip`
- `query`

The API returns:

```json
{
  "message": "Processing please wait",
  "requestId": "<requestId>"
}
```

with HTTP `202`.

## Worker Lifecycle

### Retailer isolation model

Each supported retailer has:

- its own Redis Stream
- its own Redis consumer group
- its own semaphore-controlled concurrency limit
- its own failure counter
- its own circuit breaker state

This is the main reason the system can isolate failure by retailer instead of treating all scrape work as one undifferentiated queue.

### Stream consumption

The worker only polls retailers that still have available semaphore capacity.

For each retailer, it first tries to reclaim pending messages that have been idle for more than 5 minutes. This covers cases where a worker crashed after claiming work but before finishing it.

If there is still capacity after reclaim attempts, the worker reads fresh messages from the consumer group using the normal `>` stream flow.

### Circuit check before processing

Even though the API checks the circuit breaker before queueing, the worker checks again before doing scrape work. This is important because circuit state can change after the message was already queued.

Behavior:

- if the circuit is `OPEN`, the worker skips the task
- if the circuit is `HALF_OPEN` and no probe lock exists, the worker also skips the task
- skipped tasks are acknowledged so they do not remain pending forever

### Scrape start bookkeeping

When a worker begins real processing, it increments:

```text
scrape_hour:number
```

The first increment also sets a TTL so the counter behaves like an hourly operational bucket rather than a permanent total.

### Mock scrape execution

The current worker uses mock retailer-specific handlers rather than a real external retailer integration.

Each retailer returns listing objects in the same shape:

- `id`
- `title`
- `price`
- `url`
- `retailer`

The worker also simulates timing and failure conditions so the retry and circuit logic can be exercised during local testing.

### Success path

On success, the worker:

1. writes the listing array to the Redis cache with a 20-minute TTL
2. clears the dedupe lock
3. closes the circuit and clears failure state if this was a successful half-open probe
4. acknowledges the stream entry
5. writes terminal worker logging and `search_runs` data to PostgreSQL

After this, the next API request for the same retailer/zip/query hits the cache and returns `200`.

### Failure path

On worker failure, the worker increments:

```text
failures:<retailer>
```

If the failure count becomes greater than the configured threshold within the TTL window, the worker opens:

```text
circuit:<retailer> = OPEN
```

for a cooldown period.

The failure path splits into two cases:

- retryable failure: the message remains pending and is retried after a bounded delay
- terminal failure: the lock is cleared and the message is acknowledged

The current retry delays are short and intentionally simple for local testing.

## Redis Coordination Model

The important Redis concepts are:

### Queue

- one stream per retailer: `queue:retailer:<retailer>`
- one consumer group per retailer: `group:retailer:<retailer>`

### Cache

- key pattern: `cache:listings:<retailer>:<zip>:<normalized_query>`
- value: JSON array of listings
- TTL: 20 minutes

### Dedupe lock

- key pattern: `lock:listings:<retailer>:<zip>:<normalized_query>`
- value: active `requestId`
- purpose: stop the same query from being enqueued twice while still in flight

### Retailer rate limit

- key pattern: `rate:<retailer>:<epoch_second>`
- purpose: fixed-window request limiting for uncached API requests
- default behavior: block the 6th uncached request in the same second for the same retailer

### Global scrape guardrail

- key: `scrape_hour:number`
- purpose: operational backpressure when too many scrapes are already running or recently started
- incremented by: worker
- read by: API

### Failure counters and circuit breaker

- failure key: `failures:<retailer>`
- circuit key: `circuit:<retailer>`
- probe key: `circuit-probe:<retailer>`

Circuit states:

- `CLOSED` or missing: normal behavior
- `OPEN`: API blocks uncached requests and workers skip queued work
- `HALF_OPEN`: one probe is allowed to test recovery

The full Redis contract, including TTLs and retry metadata, is documented in [redis.md](./redis.md).

## PostgreSQL Data Model

### `logs`

Purpose:

- central log stream shared by API and worker

Important columns:

- `id`
- `timestamp`
- `level`
- `msg`
- `worker_id`

Usage:

- API writes request-level logs with `worker_id = NULL`
- worker writes attempt-level logs with `worker_id = <WORKER_ID>`

### `history`

Purpose:

- record what users queried and what result they received from cache

Important columns:

- `userid`
- `timestamp`
- `query`
- `result`

Current behavior:

- written by the API on cache hits
- `userid` is currently `0` because there is no user identity system yet

### `search_runs`

Purpose:

- structured worker attempt tracking

Important columns:

- `status`
- `duration`
- `failure`
- `timestamp`
- `logid`

Current statuses used by the worker:

- `succeeded`
- `failed`
- `skipped`

`logid` points to the terminal worker log row for that attempt.

## Logging and Observability

### API logging

Every handled `GET /listings` request writes a PostgreSQL log row with level `debug`. The message captures the request outcome, for example:

- invalid request
- cache hit
- queued new job
- reused in-flight job
- rate limited
- too busy
- circuit open
- service unavailable

### Worker logging

The worker writes:

- a start `debug` log for every attempt
- a terminal `debug` log for success
- a terminal `debug` log for skipped work
- a terminal `error` log for failed work

Each attempt also gets a `search_runs` row so dashboards or later tooling can reason about outcomes without parsing free-form text logs.

### Health and readiness

Both API and worker expose:

- `/health`: process is alive
- `/ready`: dependencies and startup checks are ready

This separation matters because a process can be running but still not be ready to handle real traffic.

### Browser log viewer

The API serves a logs frontend from `/logs`. That page reads `/api/logs` and gives a quick browser view of database-backed log rows without needing to connect directly to PostgreSQL.

## Configuration Model

### API config

The API reads `.env` automatically at startup.

Important settings include:

- Redis connection
- PostgreSQL connection
- HTTP port
- lock TTL
- retailer rate limit
- circuit probe TTL
- global scrape threshold
- logs page size

### Worker config

The worker reads `worker.env` automatically at startup.

Important settings include:

- Redis connection
- PostgreSQL connection
- worker HTTP port
- worker ID
- poll interval
- reclaim idle threshold
- cache TTL
- scrape counter TTL
- circuit thresholds and TTLs
- retry delays
- per-retailer concurrency values

This split is intentional because the worker has operational knobs that do not belong in the API process.

## Local Development Flow

For local development:

1. start Redis and PostgreSQL with Docker Compose
2. create `.env` from `.env.example`
3. create `worker.env` from `worker.env.example`
4. run `npm start`
5. run `npm run worker`
6. use the browser UI or `curl` to exercise `/listings`

If PostgreSQL host port `5432` is already in use on the machine, set `POSTGRES_PORT=55432` in both env files so API and worker talk to the port actually exposed by Docker.

The detailed runbook lives in [deploy.md](./deploy.md).

## Current Constraints

This system is intentionally narrow in scope and still has several limits:

- worker scraping is mock-based, not a real retailer integration
- `history` is only written for cache hits, not for queued requests
- there is no authentication or user identity yet
- there is no dead-letter queue yet
- logs and history are sufficient for local debugging, but not a substitute for full production observability
- Redis is used as the queue and runtime state store, so its availability is critical to system behavior

These limits are acceptable for the current stage because the project is focused on queueing, caching, concurrency control, failure isolation, and worker coordination.
