CREATE TABLE IF NOT EXISTS upstream_health (
  endpoint_key TEXT PRIMARY KEY NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  outcome_sequence INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  available INTEGER,
  checked_at INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  consecutive_timeouts INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  auth_latched INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_latency INTEGER NOT NULL DEFAULT 0,
  lifetime_failures INTEGER NOT NULL DEFAULT 0,
  lifetime_successes INTEGER NOT NULL DEFAULT 0,
  target_failures INTEGER NOT NULL DEFAULT 0,
  probe_token TEXT,
  probe_until INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS upstream_failures (
  incident_key TEXT PRIMARY KEY NOT NULL,
  endpoint_key TEXT NOT NULL REFERENCES upstream_health(endpoint_key),
  scope TEXT NOT NULL,
  category TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  http_status INTEGER,
  evidence_json TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS upstream_failure_recent ON upstream_failures(endpoint_key, last_seen);
