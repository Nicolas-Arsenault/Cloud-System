## Job Flow

<img width="1098" height="806" alt="image" src="https://github.com/user-attachments/assets/1f9b4dda-8cfd-4429-a0fd-56c13b892074" />

The current request path starts at the API. For a `GET /listings` request, the API first checks Redis cache. If the result is already cached, it returns immediately and also writes API-level PostgreSQL logging and history rows. If the result is not cached, the API then applies retailer-scoped rate limiting, checks the global scrape guardrail, checks the retailer circuit breaker, acquires a dedupe lock for the normalized retailer/zip/query combination, and finally enqueues the job into the Redis Stream dedicated to that retailer.

The worker consumes from one stream per retailer through one consumer group per retailer. Because retailers are isolated into separate streams, the worker can apply a different semaphore per retailer and only pull work for retailers that still have available capacity. Before claiming fresh jobs, the worker also attempts to reclaim pending jobs that have been idle for more than 5 minutes, which covers crash recovery and abandoned work.

Once a worker starts processing a job, it checks the circuit breaker again, increments the global scrape counter, simulates the retailer scrape, writes the result into Redis cache, clears the Redis lock, and ACKs the stream entry. Retryable errors stay pending and are retried with short bounded backoff windows of 10 seconds, 20 seconds, and 30 seconds. Terminal failures clear the lock and ACK the message. If the retailer circuit is already open, the worker skips the task, clears the lock, and ACKs it instead of continuing to process it.

## Secret management strategy

In this project we use simple local env files for configuration and secrets. The API automatically loads values from `.env`, and the worker automatically loads values from `worker.env`. These files currently contain Redis connection settings, PostgreSQL credentials, runtime tuning values, and worker-specific concurrency settings.

This is acceptable for local development and a mini project, but in production we should replace file-based secret handling with a managed solution such as OpenBao, HashiCorp Vault, or a cloud provider secret manager like AWS Secrets Manager. In a production version we would also separate secret values from non-secret runtime tuning, rotate credentials, and avoid keeping operational passwords in local plaintext config files.

## Logging + monitoring approach

Here we use database-backed logging in PostgreSQL so that both the API and the worker can be inspected remotely through shared persistence. The API writes request-level rows into the `logs` table with `worker_id = NULL`, while the worker writes attempt-level rows into the same table with `worker_id` set to its configured worker identity. This lets us distinguish API events from worker events while keeping a single central log table. In practice, the log levels currently used by the code are mostly `debug` for normal lifecycle events and `error` for failed worker attempts.

We also persist execution metadata outside the generic log stream. The API writes cache-hit query history into the `history` table, and the worker writes one `search_runs` row per processing attempt. Each `search_runs` row stores a status such as `succeeded`, `failed`, or `skipped`, the processing duration in milliseconds, whether the attempt failed, and a `logid` reference to the terminal worker log row for that attempt. This gives us a structured operational view in addition to free-form log messages.

For lightweight monitoring, both the API and the worker expose `/health` and `/ready` endpoints. The API also exposes `/logs` and `/api/logs`, which provide a browser-facing view over the database log stream for quick inspection during development. At larger scale, this architecture would still need a dedicated log pipeline, metrics, alerting, and on-call notification integration, but for this project the database-centered approach is enough to debug flows end to end.

## Failure isolation strategy

In our architecture we have multiple layers of failure isolation, and they are shared across API and workers through Redis. At the request entry layer, the API uses a retailer-specific fixed-window rate limiter to stop a single retailer from being spammed, then checks a global scrape guardrail counter to stop enqueueing work when the platform is already too busy. We also use a dedupe lock keyed by retailer, zip, and normalized query so the same uncached request does not get enqueued twice while one job is already in flight.

At the worker layer, failures are isolated per retailer. Each retailer has its own Redis Stream, consumer group, and semaphore-controlled concurrency. Retryable worker failures use short exponential-style backoff windows, while still contributing to the retailer failure counter. The failure counter is shared across workers, and once it exceeds the threshold in a 60-second window, the worker opens a shared retailer circuit breaker. While the circuit is `OPEN`, the API blocks new uncached requests for that retailer and workers skip already claimed tasks for it. After the open period expires, the circuit moves to `HALF_OPEN`, where a single probe is allowed. A successful probe closes the circuit and clears failures; a failed probe reopens it for another cooldown window.

We also isolate failures caused by worker crashes by reclaiming pending stream messages that have been idle for more than 5 minutes. Because work remains in Redis Streams until ACKed, a different worker with available semaphore capacity can take over abandoned work instead of losing the job entirely. Lock clearing rules are also part of the isolation model: locks are cleared on success, on terminal failure, and on circuit-open skip, so bad states do not keep blocking future work longer than intended. In a more production-ready system we would still add a global exception handler, richer metrics, and stronger dead-letter or quarantine handling, but the current system already has several explicit protection layers.
