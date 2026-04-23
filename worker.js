const http = require("http");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "worker.env") });
const { Pool } = require("pg");
const { createClient } = require("redis");

const redisHost = process.env.REDIS_HOST || "127.0.0.1";
const redisPort = process.env.REDIS_PORT || "6379";
const postgresHost = process.env.PGHOST || "127.0.0.1";
const postgresPort = Number.parseInt(process.env.POSTGRES_PORT || "5432", 10);
const postgresDatabase = process.env.POSTGRES_DB || "app";
const postgresUser = process.env.POSTGRES_USER || "postgres";
const postgresPassword = process.env.POSTGRES_PASSWORD || "postgres";
const workerPort = Number.parseInt(process.env.WORKER_PORT || "3001", 10);
const workerId = process.env.WORKER_ID || "worker-1";
const pollIntervalMs = Number.parseInt(
  process.env.WORKER_POLL_INTERVAL_MS || "500",
  10
);
const idleClaimMs = Number.parseInt(
  process.env.WORKER_IDLE_CLAIM_MS || "300000",
  10
);
const groupNamePrefix = process.env.WORKER_GROUP_NAME_PREFIX || "group:retailer:";
const cacheTtlSeconds = Number.parseInt(
  process.env.CACHE_TTL_SECONDS || "1200",
  10
);
const lockTtlSeconds = Number.parseInt(
  process.env.LOCK_TTL_SECONDS || "300",
  10
);
const scrapeHourTtlSeconds = Number.parseInt(
  process.env.SCRAPE_HOUR_TTL_SECONDS || "3600",
  10
);
const circuitFailureThreshold = Number.parseInt(
  process.env.CIRCUIT_FAILURE_THRESHOLD || "5",
  10
);
const circuitFailureTtlSeconds = Number.parseInt(
  process.env.CIRCUIT_FAILURE_TTL_SECONDS || "60",
  10
);
const circuitOpenTtlSeconds = Number.parseInt(
  process.env.CIRCUIT_OPEN_TTL_SECONDS || "60",
  10
);
const circuitProbeTtlSeconds = Number.parseInt(
  process.env.CIRCUIT_PROBE_TTL_SECONDS || "60",
  10
);
const retryDelaysMs = [
  Number.parseInt(process.env.RETRY_DELAY_1_MS || "10000", 10),
  Number.parseInt(process.env.RETRY_DELAY_2_MS || "20000", 10),
  Number.parseInt(process.env.RETRY_DELAY_3_MS || "30000", 10)
];

const retailers = [
  {
    name: "walmart",
    concurrency: Number.parseInt(process.env.WALMART_CONCURRENCY || "2", 10)
  },
  {
    name: "target",
    concurrency: Number.parseInt(process.env.TARGET_CONCURRENCY || "2", 10)
  },
  {
    name: "kroger",
    concurrency: Number.parseInt(process.env.KROGER_CONCURRENCY || "1", 10)
  },
  {
    name: "ralphs",
    concurrency: Number.parseInt(process.env.RALPHS_CONCURRENCY || "1", 10)
  },
  {
    name: "safeway",
    concurrency: Number.parseInt(process.env.SAFEWAY_CONCURRENCY || "1", 10)
  },
  {
    name: "aldi",
    concurrency: Number.parseInt(process.env.ALDI_CONCURRENCY || "1", 10)
  }
];

const redisClient = createClient({
  url: `redis://${redisHost}:${redisPort}`
});
const postgresPool = new Pool({
  host: postgresHost,
  port: postgresPort,
  database: postgresDatabase,
  user: postgresUser,
  password: postgresPassword
});

const activeCounts = new Map();
const retryTimeouts = new Map();
const halfOpenTimers = new Map();
let shuttingDown = false;
let consumerGroupsReady = false;
let postgresCompatibilityReady = false;
const startedAt = Date.now();
let healthServer;

const mockRetailerData = {
  walmart: [
    { id: "wm-1", title: "Great Value Milk 2L", price: "4.99", url: "https://example.com/walmart/milk", retailer: "walmart" },
    { id: "wm-2", title: "Walmart Bananas 1kg", price: "1.49", url: "https://example.com/walmart/bananas", retailer: "walmart" }
  ],
  target: [
    { id: "tg-1", title: "Good & Gather Eggs 12ct", price: "3.79", url: "https://example.com/target/eggs", retailer: "target" },
    { id: "tg-2", title: "Target Greek Yogurt", price: "5.49", url: "https://example.com/target/yogurt", retailer: "target" }
  ],
  kroger: [
    { id: "kr-1", title: "Kroger Orange Juice", price: "4.29", url: "https://example.com/kroger/oj", retailer: "kroger" },
    { id: "kr-2", title: "Kroger Whole Wheat Bread", price: "2.99", url: "https://example.com/kroger/bread", retailer: "kroger" }
  ],
  ralphs: [
    { id: "rf-1", title: "Ralphs Strawberries", price: "5.99", url: "https://example.com/ralphs/strawberries", retailer: "ralphs" },
    { id: "rf-2", title: "Ralphs Chicken Breast", price: "12.49", url: "https://example.com/ralphs/chicken", retailer: "ralphs" }
  ],
  safeway: [
    { id: "sf-1", title: "Safeway Avocados", price: "3.99", url: "https://example.com/safeway/avocados", retailer: "safeway" },
    { id: "sf-2", title: "Safeway Sparkling Water", price: "6.99", url: "https://example.com/safeway/water", retailer: "safeway" }
  ],
  aldi: [
    { id: "ad-1", title: "Aldi Organic Spinach", price: "3.49", url: "https://example.com/aldi/spinach", retailer: "aldi" },
    { id: "ad-2", title: "Aldi Sourdough Loaf", price: "4.19", url: "https://example.com/aldi/sourdough", retailer: "aldi" }
  ]
};

redisClient.on("error", (error) => {
  console.error("Worker Redis client error", error);
});

postgresPool.on("error", (error) => {
  console.error("Worker Postgres pool error", error);
});

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeQuery(query) {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildQueueKey(retailer) {
  return `queue:retailer:${retailer}`;
}

function buildGroupName(retailer) {
  return `${groupNamePrefix}${retailer}`;
}

function buildCacheKey(retailer, zip, query) {
  return `cache:listings:${retailer}:${zip}:${normalizeQuery(query)}`;
}

function buildLockKey(retailer, zip, query) {
  return `lock:listings:${retailer}:${zip}:${normalizeQuery(query)}`;
}

function buildFailureKey(retailer) {
  return `failures:${retailer}`;
}

function buildCircuitKey(retailer) {
  return `circuit:${retailer}`;
}

function buildCircuitProbeKey(retailer) {
  return `circuit-probe:${retailer}`;
}

function buildRetryMetaKey(retailer, messageId) {
  return `retry:message:${retailer}:${messageId}`;
}

function getRetailerConfig(retailer) {
  return retailers.find((entry) => entry.name === retailer);
}

function getActiveCount(retailer) {
  return activeCounts.get(retailer) || 0;
}

function hasCapacity(retailer) {
  const config = getRetailerConfig(retailer);
  if (!config) {
    return false;
  }

  return getActiveCount(retailer) < config.concurrency;
}

function acquirePermit(retailer) {
  activeCounts.set(retailer, getActiveCount(retailer) + 1);
}

function releasePermit(retailer) {
  activeCounts.set(retailer, Math.max(0, getActiveCount(retailer) - 1));
}

function flattenFieldsToObject(fields) {
  const result = {};

  for (let index = 0; index < fields.length; index += 2) {
    result[fields[index]] = fields[index + 1];
  }

  return result;
}

function parseStreamEntry(entry) {
  return {
    id: entry[0],
    fields: flattenFieldsToObject(entry[1])
  };
}

async function writeWorkerLog(level, message) {
  try {
    const result = await postgresPool.query(
      "INSERT INTO logs (level, msg, worker_id) VALUES ($1, $2, $3) RETURNING id",
      [level, message, workerId]
    );
    return result.rows[0].id;
  } catch (error) {
    console.error("Failed to write worker log", error);
    return null;
  }
}

async function writeSearchRun(status, durationMs, failure, logId) {
  try {
    await postgresPool.query(
      "INSERT INTO search_runs (status, duration, failure, logid) VALUES ($1, $2, $3, $4)",
      [status, durationMs, failure, logId]
    );
  } catch (error) {
    console.error("Failed to write search run", error);
  }
}

async function ensureRedisConnection() {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
}

async function checkRedisReady() {
  try {
    await ensureRedisConnection();
    await redisClient.ping();
    return true;
  } catch (error) {
    return false;
  }
}

async function ensurePostgresCompatibility() {
  await postgresPool.query(
    "ALTER TABLE logs ALTER COLUMN worker_id DROP NOT NULL"
  );
  postgresCompatibilityReady = true;
}

async function checkPostgresReady() {
  try {
    await postgresPool.query("SELECT 1");
    return true;
  } catch (error) {
    return false;
  }
}

function createHealthServer() {
  return http.createServer(async (req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        service: "worker",
        workerId,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000)
      }));
      return;
    }

    if (req.url === "/ready") {
      const [redisReady, postgresReady] = await Promise.all([
        checkRedisReady(),
        checkPostgresReady()
      ]);
      const ready = consumerGroupsReady &&
        postgresCompatibilityReady &&
        redisReady &&
        postgresReady &&
        !shuttingDown;

      res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: ready ? "ready" : "not_ready",
        service: "worker",
        workerId,
        checks: {
          redis: {
            ready: redisReady
          },
          postgres: {
            ready: postgresReady
          },
          startup: {
            consumerGroupsReady,
            postgresCompatibilityReady
          },
          process: {
            shuttingDown
          }
        }
      }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
}

async function ensureConsumerGroups() {
  for (const retailer of retailers) {
    await ensureRetailerConsumerGroup(retailer.name);

    activeCounts.set(retailer.name, 0);
  }

  consumerGroupsReady = true;
}

async function ensureRetailerConsumerGroup(retailer) {
  const queueKey = buildQueueKey(retailer);
  const groupName = buildGroupName(retailer);

  try {
    await redisClient.sendCommand([
      "XGROUP",
      "CREATE",
      queueKey,
      groupName,
      "0",
      "MKSTREAM"
    ]);
  } catch (error) {
    if (!String(error.message).includes("BUSYGROUP")) {
      throw error;
    }
  }
}

async function incrementScrapeHourCounter() {
  const count = await redisClient.incr("scrape_hour:number");
  if (count === 1) {
    await redisClient.expire("scrape_hour:number", scrapeHourTtlSeconds);
  }
}

async function incrementFailures(retailer) {
  const failureKey = buildFailureKey(retailer);
  const failureCount = await redisClient.incr(failureKey);

  if (failureCount === 1) {
    await redisClient.expire(failureKey, circuitFailureTtlSeconds);
  }

  if (failureCount > circuitFailureThreshold) {
    await openCircuit(retailer);
  }

  return failureCount;
}

async function openCircuit(retailer) {
  const circuitKey = buildCircuitKey(retailer);
  const probeKey = buildCircuitProbeKey(retailer);
  await redisClient.del(probeKey);
  await redisClient.set(circuitKey, "OPEN", {
    EX: circuitOpenTtlSeconds
  });

  const existingTimer = halfOpenTimers.get(retailer);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(async () => {
    try {
      const currentState = await redisClient.get(circuitKey);
      if (currentState === null) {
        await redisClient.set(circuitKey, "HALF_OPEN");
      }
    } catch (error) {
      console.error(`Failed to transition ${retailer} circuit to HALF_OPEN`, error);
    }
  }, circuitOpenTtlSeconds * 1000);

  halfOpenTimers.set(retailer, timer);
}

async function closeCircuit(retailer) {
  await redisClient.del(
    buildCircuitKey(retailer),
    buildFailureKey(retailer),
    buildCircuitProbeKey(retailer)
  );
}

async function clearLock(retailer, zip, query) {
  await redisClient.del(buildLockKey(retailer, zip, query));
}

async function ackMessage(retailer, messageId) {
  await redisClient.sendCommand([
    "XACK",
    buildQueueKey(retailer),
    buildGroupName(retailer),
    messageId
  ]);
  await redisClient.del(buildRetryMetaKey(retailer, messageId));
}

async function cacheListings(retailer, zip, query, listings) {
  await redisClient.set(buildCacheKey(retailer, zip, query), JSON.stringify(listings), {
    EX: cacheTtlSeconds
  });
}

async function readRetryMeta(retailer, messageId) {
  const raw = await redisClient.get(buildRetryMetaKey(retailer, messageId));
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(`Invalid retry metadata for ${retailer}:${messageId}`, error);
    return null;
  }
}

async function writeRetryMeta(retailer, messageId, metadata) {
  await redisClient.set(
    buildRetryMetaKey(retailer, messageId),
    JSON.stringify(metadata),
    {
      EX: Math.max(circuitOpenTtlSeconds, lockTtlSeconds, 600)
    }
  );
}

function buildMockListings(retailer, zip, query) {
  const baseListings = mockRetailerData[retailer] || [];

  return baseListings.map((listing, index) => ({
    ...listing,
    id: `${listing.id}-${zip}-${index + 1}`,
    title: `${listing.title} for ${query}`
  }));
}

async function performMockScrape(retailer, zip, query) {
  if (query.includes("network")) {
    const error = new Error("Simulated network error");
    error.code = "RETRYABLE_NETWORK";
    throw error;
  }

  if (query.includes("fail")) {
    const error = new Error("Simulated terminal retailer error");
    error.code = "TERMINAL_FAILURE";
    throw error;
  }

  const sleepByRetailer = {
    walmart: 900,
    target: 700,
    kroger: 1100,
    ralphs: 800,
    safeway: 1000,
    aldi: 600
  };

  await sleep(sleepByRetailer[retailer] || 750);
  return buildMockListings(retailer, zip, query);
}

function isRetryableError(error) {
  return error.code === "RETRYABLE_NETWORK";
}

async function scheduleRetry(retailer, message, retryCount) {
  const retryDelay = retryDelaysMs[retryCount];
  if (retryDelay === undefined) {
    return false;
  }

  const retryMeta = {
    retryCount: retryCount + 1,
    nextAttemptAt: Date.now() + retryDelay
  };

  await writeRetryMeta(retailer, message.id, retryMeta);

  const retryKey = `${retailer}:${message.id}`;
  if (retryTimeouts.has(retryKey)) {
    clearTimeout(retryTimeouts.get(retryKey));
  }

  const timeout = setTimeout(async () => {
    retryTimeouts.delete(retryKey);
    if (!hasCapacity(retailer) || shuttingDown) {
      return;
    }

    acquirePermit(retailer);
    try {
      await processMessage(retailer, message, "retry");
    } finally {
      releasePermit(retailer);
    }
  }, retryDelay);

  retryTimeouts.set(retryKey, timeout);
  return true;
}

function scheduleRetryFromMetadata(retailer, message, retryMeta) {
  const delayMs = retryMeta.nextAttemptAt - Date.now();
  if (delayMs <= 0) {
    return;
  }

  const retryKey = `${retailer}:${message.id}`;
  if (retryTimeouts.has(retryKey)) {
    return;
  }

  const timeout = setTimeout(async () => {
    retryTimeouts.delete(retryKey);
    if (!hasCapacity(retailer) || shuttingDown) {
      return;
    }

    acquirePermit(retailer);
    try {
      await processMessage(retailer, message, "retry");
    } finally {
      releasePermit(retailer);
    }
  }, delayMs);

  retryTimeouts.set(retryKey, timeout);
}

async function handleFailure(retailer, message, fields, error, retryMeta) {
  const durationMs = fields.__attemptStartedAt
    ? Date.now() - fields.__attemptStartedAt
    : 0;
  await incrementFailures(retailer);
  const failureLogId = await writeWorkerLog(
    "error",
    `worker ${workerId} failed retailer=${retailer} source=${fields.__attemptSource} requestId=${fields.requestId} messageId=${message.id} query="${fields.query}" error="${error.message}"`
  );
  await writeSearchRun("failed", durationMs, true, failureLogId);

  if (isRetryableError(error)) {
    const retryCount = retryMeta?.retryCount || 0;
    const scheduled = await scheduleRetry(retailer, message, retryCount);
    if (scheduled) {
      return;
    }
  }

  await clearLock(retailer, fields.zip, fields.query);
  await redisClient.del(buildCircuitProbeKey(retailer));
  await ackMessage(retailer, message.id);
}

async function processMessage(retailer, message, source) {
  const fields = message.fields;
  const retryMeta = await readRetryMeta(retailer, message.id);

  if (retryMeta && retryMeta.nextAttemptAt > Date.now()) {
    scheduleRetryFromMetadata(retailer, message, retryMeta);
    return;
  }

  fields.__attemptStartedAt = Date.now();
  fields.__attemptSource = source;
  await writeWorkerLog(
    "debug",
    `worker ${workerId} started retailer=${retailer} source=${source} requestId=${fields.requestId} messageId=${message.id} query="${fields.query}"`
  );

  const circuitKey = buildCircuitKey(retailer);
  const circuitState = await redisClient.get(circuitKey);

  if (circuitState === "OPEN") {
    const durationMs = Date.now() - fields.__attemptStartedAt;
    const skippedLogId = await writeWorkerLog(
      "debug",
      `worker ${workerId} skipped retailer=${retailer} source=${source} requestId=${fields.requestId} messageId=${message.id} reason="circuit_open"`
    );
    await writeSearchRun("skipped", durationMs, false, skippedLogId);
    await clearLock(retailer, fields.zip, fields.query);
    await ackMessage(retailer, message.id);
    return;
  }

  if (circuitState === "HALF_OPEN") {
    const probeExists = await redisClient.exists(buildCircuitProbeKey(retailer));
    if (!probeExists) {
      const durationMs = Date.now() - fields.__attemptStartedAt;
      const skippedLogId = await writeWorkerLog(
        "debug",
        `worker ${workerId} skipped retailer=${retailer} source=${source} requestId=${fields.requestId} messageId=${message.id} reason="half_open_probe_missing"`
      );
      await writeSearchRun("skipped", durationMs, false, skippedLogId);
      await clearLock(retailer, fields.zip, fields.query);
      await ackMessage(retailer, message.id);
      return;
    }
  }

  try {
    await incrementScrapeHourCounter();
    const listings = await performMockScrape(retailer, fields.zip, fields.query);
    await cacheListings(retailer, fields.zip, fields.query, listings);
    await clearLock(retailer, fields.zip, fields.query);

    if (circuitState === "HALF_OPEN") {
      await closeCircuit(retailer);
    }

    const durationMs = Date.now() - fields.__attemptStartedAt;
    const successLogId = await writeWorkerLog(
      "debug",
      `worker ${workerId} succeeded retailer=${retailer} source=${source} requestId=${fields.requestId} messageId=${message.id} query="${fields.query}" resultCount=${listings.length}`
    );
    await writeSearchRun("succeeded", durationMs, false, successLogId);
    await ackMessage(retailer, message.id);
    console.log(`[${workerId}] ${source} success ${retailer} ${message.id}`);
  } catch (error) {
    console.error(`[${workerId}] ${source} failure ${retailer} ${message.id}`, error.message);
    await handleFailure(retailer, message, fields, error, retryMeta);
  }
}

async function claimPendingMessage(retailer) {
  const queueKey = buildQueueKey(retailer);
  const groupName = buildGroupName(retailer);
  const response = await redisClient.sendCommand([
    "XAUTOCLAIM",
    queueKey,
    groupName,
    workerId,
    `${idleClaimMs}`,
    "0-0",
    "COUNT",
    "1"
  ]);

  const claimedEntries = Array.isArray(response?.[1]) ? response[1] : [];
  if (claimedEntries.length === 0) {
    return null;
  }

  return parseStreamEntry(claimedEntries[0]);
}

async function readNewMessage(retailer) {
  const queueKey = buildQueueKey(retailer);
  const groupName = buildGroupName(retailer);
  const response = await redisClient.sendCommand([
    "XREADGROUP",
    "GROUP",
    groupName,
    workerId,
    "COUNT",
    "1",
    "STREAMS",
    queueKey,
    ">"
  ]);

  if (!response || response.length === 0) {
    return null;
  }

  const streamEntries = response[0][1];
  if (!streamEntries || streamEntries.length === 0) {
    return null;
  }

  return parseStreamEntry(streamEntries[0]);
}

async function pollRetailer(retailer) {
  if (!hasCapacity(retailer) || shuttingDown) {
    return;
  }

  acquirePermit(retailer);
  try {
    const reclaimed = await claimPendingMessage(retailer);
    if (reclaimed) {
      await processMessage(retailer, reclaimed, "reclaimed");
      return;
    }

    const fresh = await readNewMessage(retailer);
    if (fresh) {
      await processMessage(retailer, fresh, "new");
    }
  } catch (error) {
    if (String(error.message).includes("NOGROUP")) {
      await ensureRetailerConsumerGroup(retailer);
      return;
    }

    console.error(`[${workerId}] poll failure ${retailer}`, error);
  } finally {
    releasePermit(retailer);
  }
}

async function startWorker() {
  await ensureRedisConnection();
  await ensurePostgresCompatibility();
  await ensureConsumerGroups();
  healthServer = createHealthServer();
  healthServer.listen(workerPort);

  console.log(`[${workerId}] connected to redis ${redisHost}:${redisPort}`);
  console.log(`[${workerId}] connected to postgres ${postgresHost}:${postgresPort}`);
  console.log(`[${workerId}] retailers=${retailers.map((retailer) => `${retailer.name}:${retailer.concurrency}`).join(", ")}`);
  console.log(`[${workerId}] health listening on port ${workerPort}`);

  setInterval(() => {
    for (const retailer of retailers) {
      void pollRetailer(retailer.name);
    }
  }, pollIntervalMs);
}

async function shutdown() {
  shuttingDown = true;
  for (const timeout of retryTimeouts.values()) {
    clearTimeout(timeout);
  }
  for (const timer of halfOpenTimers.values()) {
    clearTimeout(timer);
  }

  if (healthServer) {
    await new Promise((resolve, reject) => {
      healthServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  if (redisClient.isOpen) {
    await redisClient.quit();
  }

  await postgresPool.end();

  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});

startWorker().catch((error) => {
  console.error(`[${workerId}] failed to start`, error);
  process.exit(1);
});
