# Cloud-System

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

## API

The backend exposes one endpoint:

```http
GET /listings?retailer=<retailer>&zip=<zip>&query=<query>
```

Behavior:

- Returns `200` with cached listings when the Redis cache contains the query result
- Returns `202` with `Processing please wait` and a `requestId` when the query is queued
- Returns the same `202` and existing `requestId` when the same retailer/zip/query is already in flight
- Returns `400` JSON when `retailer`, `zip`, or `query` is missing or blank
- Returns `503` JSON if Redis is unavailable

## Redis Runtime Layout

Redis does not use tables. The expected runtime layout is:

- Queue streams: `queue:retailer:<retailer>`
- Listings cache keys: `cache:listings:<retailer>:<zip>:<normalized_query>`
- In-flight dedupe locks: `lock:listings:<retailer>:<zip>:<normalized_query>`
- Consumer groups: `group:retailer:<retailer>`
- Cache keys with 20 minute TTL: `cache:<namespace>:<key>`
- Locks: `lock:<retailer>:<resource>`
- Spend guardrails by retailer/day: `spend:<retailer>:YYYYMMDD`
- Rate limits by retailer/second: `ratelimit:<retailer>:<window_epoch_second>`
- Circuit breaker counters: `cb:failures:<retailer>`
- Circuit breaker open state: `cb:open:<retailer>`

Cached listings are stored as a raw JSON array with a 20 minute TTL. Queue entries include `requestId`, `retailer`, `zip`, and `query`. In-flight listing locks store the active `requestId` for 5 minutes so duplicate requests reuse the same job instead of enqueueing twice.
