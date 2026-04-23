# Redis Behavior

This document defines the Redis contract used by the API today and the worker behavior expected next.

## API Read/Write Order

For `GET /listings?retailer=<retailer>&zip=<zip>&query=<query>`:

1. Check cache.
2. If cached, return immediately.
3. If not cached, apply retailer rate limiting.
4. Apply the global scrape guardrail.
5. Check the retailer circuit breaker.
6. Acquire the in-flight dedupe lock.
7. Enqueue the job to the retailer stream.

Cached hits bypass rate limiting, spend guardrails, and circuit-breaker blocking.

## Listings Cache

- Key: `cache:listings:<retailer>:<zip>:<normalized_query>`
- Type: string containing a JSON array of listing objects
- TTL: 20 minutes
- Write owner: worker
- Read owner: API

The normalized query is lowercase, trimmed, and collapses repeated whitespace to one space.

## Retailer Queue

- Key: `queue:retailer:<retailer>`
- Type: Redis stream
- Write owner: API
- Read owner: worker consumer group

Stream fields written by the API:

- `requestId`
- `retailer`
- `zip`
- `query`

## In-Flight Lock

- Key: `lock:listings:<retailer>:<zip>:<normalized_query>`
- Type: string
- Value: active `requestId`
- TTL: 5 minutes
- Write owner: API
- Delete owner: worker on completion

This prevents duplicate enqueue of the same retailer/zip/query while work is already in flight.

## Retailer Rate Limit

- Key: `rate:<retailer>:<epoch_second>`
- Type: integer counter
- TTL: 1 second
- Write owner: API

Behavior:

- Every uncached request increments the retailer counter for the current second.
- Requests 1 through 5 are allowed.
- Request 6 and above in the same second return `429 {"error":"rate limited"}`.

## Global Spend Guardrail

- Key: `scrape_hour:number`
- Type: integer counter
- Read owner: API
- Increment owner: worker

Behavior:

- The API reads this key after retailer rate limiting.
- If the value is greater than `SCRAPE_HOUR_THRESHOLD`, the API returns `429 {"error":"too busy"}`.
- Missing key is treated as `0`.

## Circuit Breaker

### Failure Counter

- Key: `failures:<retailer>`
- Type: integer counter
- TTL: 60 seconds
- Increment owner: worker

Behavior:

- On each retailer failure, the worker increments `failures:<retailer>`.
- When the first failure creates the key, the worker sets a 60-second TTL.
- If the counter becomes greater than 5 within that 60-second window, the worker opens the circuit.

### Circuit State

- Key: `circuit:<retailer>`
- Type: string
- Allowed values: `OPEN`, `HALF_OPEN`, `CLOSED`

Behavior:

- When failures exceed 5 in one minute, set `circuit:<retailer>` to `OPEN`.
- The `OPEN` state should have a 60-second TTL.
- When the open window expires, the retailer should move to `HALF_OPEN`.
- A successful probe closes the circuit by setting `circuit:<retailer>` to `CLOSED` or deleting the key.
- A failed probe reopens the circuit by setting `circuit:<retailer>` back to `OPEN` with a fresh 60-second TTL.
- Missing `circuit:<retailer>` should be treated as effectively closed by the API.

### Half-Open Probe Lock

- Key: `circuit-probe:<retailer>`
- Type: string
- Value: simple marker
- TTL: 60 seconds
- Write owner: API when it allows a half-open probe request

Behavior:

- If `circuit:<retailer>` is `OPEN`, the API returns `429 {"error":"circuit open"}` for uncached requests.
- If `circuit:<retailer>` is `HALF_OPEN`, the API allows exactly one normal request through by atomically creating `circuit-probe:<retailer>`.
- While that probe key exists, all other half-open requests return `429 {"error":"circuit open"}`.
- The worker should clear the probe key once the probe succeeds or fails.

## Consumer Groups

- Key: `group:retailer:<retailer>`
- Type: Redis consumer group name convention
- Owner: worker setup/runtime

Each retailer stream should have its own consumer group so work stays retailer-scoped.
