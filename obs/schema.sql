-- obs.db schema (MONITORING-PLAN.md §1 and §3). Append-only event log + derived tables. Applied idempotently by lib.mjs on every open.
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL, note TEXT);

CREATE TABLE IF NOT EXISTS events (
  event_id        TEXT PRIMARY KEY,          -- sha1(actor|run_id|trace_id|type|seq): idempotent INSERT OR IGNORE
  ts              TEXT NOT NULL,             -- ISO UTC
  run_id          TEXT,                      -- hunt-2026-10-20 | worker-2026-10-20-091500 | mail-... | page | collect-...
  trace_id        TEXT,                      -- one company/role attempt = the role id (minted by the board; roleId until the finder mints trace ids)
  span_id         TEXT,
  parent_span_id  TEXT,
  actor           TEXT NOT NULL,             -- netlify:hunt | netlify:hunt-find | netlify:mail | netlify:state | agent:sorter | agent:grader | agent:preparer | agent:mail-clerk | pc:worker | pc:collector | page:human | claude-code
  type            TEXT NOT NULL,             -- step.start | step.end | decision | guard.refused | transition | error | fire | claim | submit.attempt | submit.request | receipt | reconcile | settings | snapshot | heartbeat | question | run | field.fill | form.snapshot | ledger | mail | health | backup | log
  severity        TEXT NOT NULL DEFAULT 'info',
  entity_type     TEXT,                      -- company | role | run | worker | board
  entity_id       TEXT,
  outcome         TEXT,                      -- ok | fail | skipped | refused | unverified | released | blocked
  duration_ms     INTEGER,
  error_class     TEXT,
  error_cause     TEXT,
  error_handling  TEXT,                      -- handled | retried | parked | forfeited | needs-human | unhandled | released
  payload         TEXT NOT NULL DEFAULT '{}',-- JSON
  schema_version  INTEGER NOT NULL DEFAULT 1,
  ingested_at     TEXT NOT NULL,
  source_file     TEXT,
  company         TEXT GENERATED ALWAYS AS (json_extract(payload, '$.company')) VIRTUAL,
  ats             TEXT GENERATED ALWAYS AS (json_extract(payload, '$.ats')) VIRTUAL,
  status_from     TEXT GENERATED ALWAYS AS (json_extract(payload, '$.from')) VIRTUAL,
  status_to       TEXT GENERATED ALWAYS AS (json_extract(payload, '$.to')) VIRTUAL,
  reason          TEXT GENERATED ALWAYS AS (json_extract(payload, '$.reason')) VIRTUAL
);
CREATE INDEX IF NOT EXISTS ix_events_trace ON events (trace_id, ts);
CREATE INDEX IF NOT EXISTS ix_events_type ON events (type, ts);
CREATE INDEX IF NOT EXISTS ix_events_actor ON events (actor, ts);
CREATE INDEX IF NOT EXISTS ix_events_entity ON events (entity_type, entity_id, ts);
CREATE INDEX IF NOT EXISTS ix_events_run ON events (run_id, ts);
CREATE INDEX IF NOT EXISTS ix_events_ts ON events (ts);

CREATE TABLE IF NOT EXISTS snapshots (
  rev         INTEGER PRIMARY KEY,           -- the board's revision number
  ts          TEXT NOT NULL,                 -- when the collector pulled it
  updated_at  TEXT,                          -- state.updatedAt
  sha256      TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  json        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (                 -- current view, rebuilt from the latest snapshot on every collect
  kind          TEXT NOT NULL,               -- company | role
  id            TEXT NOT NULL,
  name          TEXT,                        -- company name / role title
  company_id    TEXT,
  company       TEXT,
  domain        TEXT,
  tier          TEXT,
  grade         INTEGER,
  stage         TEXT,
  hunt_status   TEXT,
  apply_status  TEXT,
  ats           TEXT,
  source        TEXT,
  cv            TEXT,
  url           TEXT,
  found_at      TEXT, prepared_at TEXT, approved_at TEXT, started_at TEXT, submitted_at TEXT, confirmed_at TEXT, unverified_at TEXT, blocked_at TEXT, failed_at TEXT,
  run_id        TEXT,                        -- apply.runId (worker run) for roles
  hunt_run_id   TEXT,                        -- company.hunt.runId (night)
  reason        TEXT,
  needs_human    INTEGER,
  screenshot    TEXT,
  pdf           TEXT,
  json          TEXT NOT NULL,               -- the full object
  PRIMARY KEY (kind, id)
);

CREATE TABLE IF NOT EXISTS evidence (
  trace_id    TEXT NOT NULL,
  run_id      TEXT,
  kind        TEXT NOT NULL,                 -- screenshot.filled | screenshot.confirmed | screenshot.blocked | screenshot.failed | confirmation.txt | form.json | request.json | trace.zip | cv.pdf | log
  path        TEXT NOT NULL,
  sha256      TEXT,
  bytes       INTEGER,
  created_at  TEXT,
  PRIMARY KEY (path)
);

CREATE TABLE IF NOT EXISTS rollups_daily (
  date        TEXT NOT NULL,
  metric      TEXT NOT NULL,
  value       REAL NOT NULL,
  provenance  TEXT NOT NULL,                 -- which table/view and rule produced it
  computed_at TEXT NOT NULL,
  PRIMARY KEY (date, metric)
);

CREATE TABLE IF NOT EXISTS data_dictionary (
  object      TEXT NOT NULL,                 -- table or view name
  column      TEXT NOT NULL,                 -- '' for the object itself
  meaning     TEXT NOT NULL,
  source      TEXT,
  since       TEXT,
  PRIMARY KEY (object, column)
);

CREATE TABLE IF NOT EXISTS question_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  question    TEXT NOT NULL,
  sql         TEXT,
  rows        INTEGER,
  answered_by TEXT,                          -- claude-code | human | template:<name>
  verified    INTEGER DEFAULT 0,             -- 1 when the answer was checked against raw data / the board
  note        TEXT
);

CREATE TABLE IF NOT EXISTS ingest_log (                -- which raw files/chunks were ingested and how far (offset), so re-runs are cheap and idempotent
  source      TEXT PRIMARY KEY,              -- file path or blob key
  bytes       INTEGER NOT NULL,
  lines       INTEGER NOT NULL,
  sha256      TEXT,
  ingested_at TEXT NOT NULL
);
