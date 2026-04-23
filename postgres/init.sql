CREATE TABLE IF NOT EXISTS logs (
    id BIGSERIAL PRIMARY KEY,
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    level TEXT NOT NULL,
    msg TEXT NOT NULL,
    worker_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS search_runs (
    id BIGSERIAL PRIMARY KEY,
    status TEXT NOT NULL,
    duration INTEGER NOT NULL,
    failure BOOLEAN NOT NULL DEFAULT FALSE,
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    logid BIGINT REFERENCES logs(id)
);

CREATE TABLE IF NOT EXISTS history (
    id BIGSERIAL PRIMARY KEY,
    userid BIGINT NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    query TEXT NOT NULL,
    result JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_runs_timestamp ON search_runs ("timestamp");
CREATE INDEX IF NOT EXISTS idx_search_runs_status ON search_runs (status);
CREATE INDEX IF NOT EXISTS idx_search_runs_logid ON search_runs (logid);

CREATE INDEX IF NOT EXISTS idx_history_userid_timestamp ON history (userid, "timestamp");
CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history ("timestamp");

CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs ("timestamp");
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs (level);
CREATE INDEX IF NOT EXISTS idx_logs_worker_id ON logs (worker_id);
