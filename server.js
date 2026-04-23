const crypto = require("crypto");
const express = require("express");
const { createClient } = require("redis");

const app = express();
const port = process.env.PORT || 3000;
const redisHost = process.env.REDIS_HOST || "127.0.0.1";
const redisPort = process.env.REDIS_PORT || 6379;
const lockTtlSeconds = 5 * 60;
const redisClient = createClient({
  url: `redis://${redisHost}:${redisPort}`
});

redisClient.on("error", (error) => {
  console.error("Redis client error", error);
});

async function ensureRedisConnection() {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
}

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

function normalizeQuery(query) {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

app.get("/listings", async (req, res) => {
  const requiredParams = ["retailer", "zip", "query"];
  const missingParams = requiredParams.filter((param) => {
    const value = req.query[param];
    return typeof value !== "string" || value.trim() === "";
  });

  if (missingParams.length > 0) {
    return res.status(400).json({
      error: "Missing or empty required query parameters.",
      missing: missingParams
    });
  }

  const retailer = normalizeValue(req.query.retailer);
  const zip = normalizeValue(req.query.zip);
  const query = normalizeValue(req.query.query);
  const cacheKey = buildCacheKey(retailer, zip, query);
  const lockKey = buildLockKey(retailer, zip, query);
  const streamKey = buildQueueKey(retailer);

  try {
    await ensureRedisConnection();

    const cachedListings = await redisClient.get(cacheKey);
    if (cachedListings) {
      return res.status(200).json({
        retailer,
        zip,
        query,
        listings: JSON.parse(cachedListings)
      });
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

      return res.status(202).json({
        message: "Processing please wait",
        requestId
      });
    }

    const existingRequestId = await redisClient.get(lockKey);

    return res.status(202).json({
      message: "Processing please wait",
      requestId: existingRequestId || requestId
    });
  } catch (error) {
    return res.status(503).json({
      error: "Listings service unavailable."
    });
  }
});

app.listen(port, () => {
  console.log(`API listening on port ${port}`);
  console.log(`Redis connection configured for ${redisHost}:${redisPort}`);
});
