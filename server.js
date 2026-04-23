const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");
const { createClient } = require("redis");

const app = express();
const publicDir = path.join(__dirname, "public");
const port = process.env.PORT || 3000;
const redisHost = process.env.REDIS_HOST || "127.0.0.1";
const redisPort = process.env.REDIS_PORT || 6379;
const postgresHost = process.env.PGHOST || "127.0.0.1";
const postgresPort = Number.parseInt(process.env.POSTGRES_PORT || "5432", 10);
const postgresDatabase = process.env.POSTGRES_DB || "app";
const postgresUser = process.env.POSTGRES_USER || "postgres";
const postgresPassword = process.env.POSTGRES_PASSWORD || "postgres";
const lockTtlSeconds = Number.parseInt(
  process.env.LOCK_TTL_SECONDS || "300",
  10
);
const retailerRateLimitPerSecond = Number.parseInt(
  process.env.RETAILER_RATE_LIMIT_PER_SECOND || "5",
  10
);
const circuitProbeTtlSeconds = Number.parseInt(
  process.env.CIRCUIT_PROBE_TTL_SECONDS || "60",
  10
);
const scrapeHourThreshold = Number.parseInt(
  process.env.SCRAPE_HOUR_THRESHOLD || "100",
  10
);
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
const startedAt = Date.now();
let postgresCompatibilityReady = false;

redisClient.on("error", (error) => {
  console.error("Redis client error", error);
});

postgresPool.on("error", (error) => {
  console.error("Postgres pool error", error);
});

async function ensureRedisConnection() {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
}

async function ensurePostgresCompatibility() {
  await postgresPool.query(
    "ALTER TABLE logs ALTER COLUMN worker_id DROP NOT NULL"
  );
  postgresCompatibilityReady = true;
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

async function checkPostgresReady() {
  try {
    await postgresPool.query("SELECT 1");
    return true;
  } catch (error) {
    return false;
  }
}

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "api",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000)
  });
});

app.get("/ready", async (req, res) => {
  const [redisReady, postgresReady] = await Promise.all([
    checkRedisReady(),
    checkPostgresReady()
  ]);
  const ready = postgresCompatibilityReady && redisReady && postgresReady;

  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not_ready",
    service: "api",
    checks: {
      startup: {
        postgresCompatibilityReady
      },
      redis: {
        ready: redisReady
      },
      postgres: {
        ready: postgresReady
      }
    }
  });
});

app.use(express.static(publicDir));

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

function normalizeValue(value) {
  return value.trim();
}

function buildCacheKey(retailer, zip, query) {
  return `cache:listings:${retailer.toLowerCase()}:${zip}:${normalizeQuery(query)}`;
}

function buildLockKey(retailer, zip, query) {
  return `lock:listings:${retailer.toLowerCase()}:${zip}:${normalizeQuery(query)}`;
}

function buildQueueKey(retailer) {
  return `queue:retailer:${retailer.toLowerCase()}`;
}

function buildRateLimitKey(retailer) {
  const currentSecond = Math.floor(Date.now() / 1000);
  return `rate:${retailer.toLowerCase()}:${currentSecond}`;
}

function buildCircuitKey(retailer) {
  return `circuit:${retailer.toLowerCase()}`;
}

function buildCircuitProbeKey(retailer) {
  return `circuit-probe:${retailer.toLowerCase()}`;
}

function normalizeQuery(query) {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseCounterValue(value) {
  const parsed = Number.parseInt(value || "0", 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function writeApiLog(outcome, retailer, zip, query, extra = "") {
  const msg = `listings ${outcome} retailer=${retailer} zip=${zip} query="${query}"${extra}`;

  try {
    await postgresPool.query(
      "INSERT INTO logs (level, msg, worker_id) VALUES ($1, $2, $3)",
      ["debug", msg, null]
    );
  } catch (error) {
    console.error("Failed to write API log", error);
  }
}

async function writeHistory(query, listings) {
  try {
    await postgresPool.query(
      "INSERT INTO history (userid, query, result) VALUES ($1, $2, $3::jsonb)",
      [0, query, JSON.stringify(listings)]
    );
  } catch (error) {
    console.error("Failed to write history row", error);
  }
}

app.get("/listings", async (req, res) => {
  const requiredParams = ["retailer", "zip", "query"];
  const missingParams = requiredParams.filter((param) => {
    const value = req.query[param];
    return typeof value !== "string" || value.trim() === "";
  });

  const retailer = typeof req.query.retailer === "string"
    ? normalizeValue(req.query.retailer)
    : "unknown";
  const zip = typeof req.query.zip === "string"
    ? normalizeValue(req.query.zip)
    : "unknown";
  const query = typeof req.query.query === "string"
    ? normalizeValue(req.query.query)
    : "unknown";

  if (missingParams.length > 0) {
    await writeApiLog(
      "invalid",
      retailer,
      zip,
      query,
      ` missing=${missingParams.join(",")}`
    );

    return res.status(400).json({
      error: "Missing or empty required query parameters.",
      missing: missingParams
    });
  }

  const cacheKey = buildCacheKey(retailer, zip, query);
  const lockKey = buildLockKey(retailer, zip, query);
  const streamKey = buildQueueKey(retailer);
  const circuitKey = buildCircuitKey(retailer);
  const circuitProbeKey = buildCircuitProbeKey(retailer);

  try {
    await ensureRedisConnection();

    const cachedListings = await redisClient.get(cacheKey);
    if (cachedListings) {
      const listings = JSON.parse(cachedListings);
      await writeApiLog("cache_hit", retailer, zip, query);
      await writeHistory(query, listings);

      return res.status(200).json({
        retailer,
        zip,
        query,
        listings
      });
    }

    const rateLimitKey = buildRateLimitKey(retailer);
    const retailerRequestCount = await redisClient.incr(rateLimitKey);
    if (retailerRequestCount === 1) {
      await redisClient.expire(rateLimitKey, 1);
    }

    if (retailerRequestCount > retailerRateLimitPerSecond) {
      await writeApiLog("rate_limited", retailer, zip, query);

      return res.status(429).json({
        error: "rate limited"
      });
    }

    const scrapeHourCount = parseCounterValue(
      await redisClient.get("scrape_hour:number")
    );

    if (scrapeHourCount > scrapeHourThreshold) {
      await writeApiLog("too_busy", retailer, zip, query);

      return res.status(429).json({
        error: "too busy"
      });
    }

    const circuitState = await redisClient.get(circuitKey);
    if (circuitState === "OPEN") {
      await writeApiLog("circuit_open", retailer, zip, query);

      return res.status(429).json({
        error: "circuit open"
      });
    }

    if (circuitState === "HALF_OPEN") {
      const probeClaimed = await redisClient.set(circuitProbeKey, "1", {
        NX: true,
        EX: circuitProbeTtlSeconds
      });

      if (!probeClaimed) {
        await writeApiLog("circuit_open", retailer, zip, query);

        return res.status(429).json({
          error: "circuit open"
        });
      }
    }

    const requestId = crypto.randomUUID();
    const lockWasSet = await redisClient.set(lockKey, requestId, {
      NX: true,
      EX: lockTtlSeconds
    });

    if (lockWasSet) {
      await redisClient.xAdd(streamKey, "*", {
        requestId,
        retailer,
        zip,
        query
      });
      await writeApiLog("queued", retailer, zip, query, ` requestId=${requestId}`);

      return res.status(202).json({
        message: "Processing please wait",
        requestId
      });
    }

    const existingRequestId = await redisClient.get(lockKey);
    await writeApiLog(
      "queued_existing",
      retailer,
      zip,
      query,
      ` requestId=${existingRequestId || requestId}`
    );

    return res.status(202).json({
      message: "Processing please wait",
      requestId: existingRequestId || requestId
    });
  } catch (error) {
    await writeApiLog("service_unavailable", retailer, zip, query);

    return res.status(503).json({
      error: "Listings service unavailable."
    });
  }
});

ensurePostgresCompatibility()
  .then(() => {
    console.log("Postgres compatibility check complete");
  })
  .catch((error) => {
    console.error("Postgres compatibility check failed", error);
  })
  .finally(() => {
    app.listen(port, () => {
      console.log(`API listening on port ${port}`);
      console.log(`Redis connection configured for ${redisHost}:${redisPort}`);
      console.log(`Postgres connection configured for ${postgresHost}:${postgresPort}`);
      console.log(`Lock TTL set to ${lockTtlSeconds} seconds`);
      console.log(`Retailer rate limit set to ${retailerRateLimitPerSecond} requests/second`);
      console.log(`Circuit probe TTL set to ${circuitProbeTtlSeconds} seconds`);
      console.log(`Scrape hour threshold set to ${scrapeHourThreshold}`);
    });
  });
