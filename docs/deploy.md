# Local Deploy and Test

This runbook covers how to boot the current Cloud-System locally and verify the full flow:

- API receives a search
- Redis queues a retailer job
- worker processes the job
- cache is populated
- PostgreSQL receives logs and `search_runs`

## Prerequisites

- Docker and Docker Compose
- Node.js and npm

## 1. Install dependencies

From the repo root:

```bash
npm install
```

## 2. Prepare env files

API env:

```bash
cp .env.example .env
```

Worker env:

```bash
cp worker.env.example worker.env
```

The API automatically loads `.env` and the worker automatically loads `worker.env`.

## 3. Start Redis and PostgreSQL

```bash
docker compose up -d
```

Check containers:

```bash
docker compose ps
```

Expected services:

- `redis`
- `postgres`

## 4. Handle the common PostgreSQL port conflict

If host port `5432` is already in use, start PostgreSQL on `55432` instead:

```bash
POSTGRES_PORT=55432 docker compose up -d postgres
```

When using the alternate port, start both API and worker with:

```bash
POSTGRES_PORT=55432
```

## 5. Start the API

Default:

```bash
npm start
```

If PostgreSQL is on `55432`:

edit `.env` and set:

```env
POSTGRES_PORT=55432
```

Health checks:

```bash
curl -sS http://127.0.0.1:3000/health
curl -sS http://127.0.0.1:3000/ready
```

Expected:

- `/health` returns `200`
- `/ready` returns `200` when Redis and PostgreSQL are reachable

## 6. Start the worker

Default:

```bash
npm run worker
```

If PostgreSQL is on `55432`:

edit `worker.env` and set:

```env
POSTGRES_PORT=55432
```

Worker health checks:

```bash
curl -sS http://127.0.0.1:3001/health
curl -sS http://127.0.0.1:3001/ready
```

Expected:

- `/health` returns `200`
- `/ready` returns `200` when Redis is reachable, consumer groups were initialized, and PostgreSQL is reachable

## 7. Test the browser flow

Open:

```text
http://localhost:3000/
```

Submit a search such as:

- retailer: `walmart`
- zip: `90210`
- query: `milk`

Expected behavior:

- the first response may be queued
- the page shows a `requestId`
- the page retries automatically
- once the worker finishes, results appear from cache

You can also open the logs UI:

```text
http://localhost:3000/logs
```

Expected behavior:

- the page loads recent database log rows
- API-originated rows have empty or null `worker_id`
- worker-originated rows show the worker id, such as `worker-1`
- new API and worker activity appears as the page polls `/api/logs`

## 8. Test the raw HTTP flow

First request:

```bash
curl -i "http://127.0.0.1:3000/listings?retailer=walmart&zip=90210&query=milk"
```

Expected on first uncached request:

- HTTP `202`
- JSON with `message` and `requestId`

Run the same request again after the worker has had time to finish:

```bash
curl -i "http://127.0.0.1:3000/listings?retailer=walmart&zip=90210&query=milk"
```

Expected after worker completion:

- HTTP `200`
- JSON with `listings`

## 9. Verify Redis state

Check queue activity:

```bash
docker exec cloud-system-redis redis-cli XRANGE "queue:retailer:walmart" - + COUNT 10
```

Check cached result:

```bash
docker exec cloud-system-redis redis-cli GET "cache:listings:walmart:90210:milk"
```

Check lock cleared:

```bash
docker exec cloud-system-redis redis-cli EXISTS "lock:listings:walmart:90210:milk"
```

Expected:

- cache key exists after worker success
- lock key returns `0` after worker success

Check scrape counter:

```bash
docker exec cloud-system-redis redis-cli GET "scrape_hour:number"
```

Expected:

- value increments when worker starts scrape attempts

Check pending messages:

```bash
docker exec cloud-system-redis redis-cli XPENDING "queue:retailer:walmart" "group:retailer:walmart"
```

Expected after success:

- pending count is `0`

## 10. Verify PostgreSQL state

Show API and worker logs:

```bash
docker exec cloud-system-postgres psql -U postgres -d app -c "SELECT id, timestamp, level, msg, worker_id FROM logs ORDER BY id DESC LIMIT 20;"
```

Expected:

- API rows have `worker_id` as `NULL`
- worker rows have `worker_id` set, such as `worker-1`

You can cross-check the browser logs page at `http://localhost:3000/logs` against this query. The newest rows in the UI should match the newest rows from the `logs` table.

Show search runs:

```bash
docker exec cloud-system-postgres psql -U postgres -d app -c "SELECT id, status, duration, failure, logid, timestamp FROM search_runs ORDER BY id DESC LIMIT 20;"
```

Expected:

- one row per worker attempt
- `succeeded`, `failed`, or `skipped` statuses

Show history:

```bash
docker exec cloud-system-postgres psql -U postgres -d app -c "SELECT id, userid, query, result, timestamp FROM history ORDER BY id DESC LIMIT 20;"
```

Expected:

- cache-hit responses create history rows
- `userid` is currently `0`

## 11. Reset local state between tests

Clear Postgres runtime tables:

```bash
docker exec cloud-system-postgres psql -U postgres -d app -c "TRUNCATE TABLE history, search_runs, logs RESTART IDENTITY CASCADE;"
```

Clear Redis keys for one retailer:

```bash
docker exec cloud-system-redis redis-cli DEL \
  "queue:retailer:walmart" \
  "lock:listings:walmart:90210:milk" \
  "cache:listings:walmart:90210:milk" \
  "failures:walmart" \
  "circuit:walmart" \
  "circuit-probe:walmart" \
  "scrape_hour:number"
```

Clear retry keys:

```bash
docker exec cloud-system-redis sh -lc "redis-cli --scan --pattern 'retry:message:*' | xargs -r redis-cli DEL"
```

Full reset:

```bash
docker compose down -v
docker compose up -d
```

## 12. Troubleshooting

### PostgreSQL port `5432` is already in use

Use:

```bash
POSTGRES_PORT=55432 docker compose up -d postgres
```

Then set `POSTGRES_PORT=55432` in both `.env` and `worker.env` before starting the API and worker.

### API `/ready` returns `503`

Check:

- Redis is up
- PostgreSQL is up
- API is using the correct `POSTGRES_PORT`

### Worker `/ready` returns `503`

Check:

- Redis is up
- PostgreSQL is up
- worker is using the correct `POSTGRES_PORT`
- consumer groups were initialized during worker startup

### Search stays queued forever

Check:

- worker process is running
- worker `/ready` is `200`
- no open circuit is blocking the retailer
- worker logs in PostgreSQL show attempts

### Logs page looks empty

Check:

- API is running on `http://localhost:3000`
- `GET /api/logs` returns rows
- PostgreSQL is reachable from the API
- `LOGS_PAGE_SIZE` is not set too low in `.env`

### Cached results never appear

Check:

- worker wrote `cache:listings:<retailer>:<zip>:<normalized_query>`
- lock was cleared
- `search_runs` shows a `succeeded` attempt

### Old Redis state is affecting tests

Reset the retailer keys or run the full reset section above before testing again.
