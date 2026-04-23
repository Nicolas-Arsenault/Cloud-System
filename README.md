# Cloud-System

## Services

This project ships with a Docker Compose setup for:

- PostgreSQL 16
- Redis 7

Start both services with:

```bash
cp .env.example .env
docker compose up -d
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

## Redis Runtime Layout

Redis does not use tables. The expected runtime layout is:

- Queue streams: `queue:retailer:<retailer>`
- Consumer groups: `group:retailer:<retailer>`
- Cache keys with 20 minute TTL: `cache:<namespace>:<key>`
- Locks: `lock:<retailer>:<resource>`
- Spend guardrails by retailer/day: `spend:<retailer>:YYYYMMDD`
- Rate limits by retailer/second: `ratelimit:<retailer>:<window_epoch_second>`
- Circuit breaker counters: `cb:failures:<retailer>`
- Circuit breaker open state: `cb:open:<retailer>`
