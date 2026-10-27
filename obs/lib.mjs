// obs library: open the SQLite store (node:sqlite, built into Node 22), apply schema + views, idempotent event insert, config, hashing.
// MONITORING-PLAN.md §1 (event shape) and §3 (storage). Never logs secrets.
// node:sqlite prints an ExperimentalWarning on import; it is stable enough for us, keep the console clean (the import is dynamic so the override runs first)
const _warn = process.emitWarning; process.emitWarning = (w, ...a) => { if (String(w).includes('SQLite') || (a[0] && String(a[0]).includes('Experimental'))) return; return _warn.call(process, w, ...a); };
const { DatabaseSync } = await import('node:sqlite');
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const OBS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(OBS_DIR, '..');                      // the repo root
export const DB_PATH = process.env.OBS_DB ? path.resolve(process.env.OBS_DB) : path.join(OBS_DIR, 'obs.db');   // OBS_DB=<path> points tests at a scratch store
export const RAW_DIR = process.env.OBS_DB ? path.join(path.dirname(path.resolve(process.env.OBS_DB)), path.basename(process.env.OBS_DB).replace(/\.db$/, '') + '-raw') : path.join(OBS_DIR, 'raw');   // a scratch store keeps its raw files beside it
export const EVIDENCE_DIR = path.join(OBS_DIR, 'evidence');
export const BACKUP_DIR = path.join(OBS_DIR, 'backups');
export const RUNNER_DIR = path.join(ROOT, 'worker');
export const APPLICATIONS_DIR = path.join(ROOT, 'applications');
export const BOARD_DIR = process.env.BOARD_DIR || path.join(ROOT, 'board');
// the live board URL comes from worker/config.json boardLive (board moved to a second Netlify account on 25 Oct 2026; the old URL is frozen with its kill switch on)
export const BOARD_URL = (() => { try { return JSON.parse(fs.readFileSync(path.join(RUNNER_DIR, 'config.json'), 'utf8')).boardLive || 'http://localhost:8899'; } catch { return 'http://localhost:8899'; } })();
export const SCHEMA_VERSION = 1;

export const sha1 = s => crypto.createHash('sha1').update(String(s)).digest('hex');
export const sha256File = p => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };
export const nowIso = () => new Date().toISOString();

export function env() {
  const out = {};
  for (const f of [path.join(BOARD_DIR, '.env'), path.join(BOARD_DIR, '..', '.env')]) {
    try { for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/)) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && out[m[1]] === undefined) out[m[1]] = m[2].trim().replace(/^"|"$/g, ''); } } catch { /* optional */ }
  }
  return out;
}

export function openDb({ readonly = false } = {}) {
  for (const d of [RAW_DIR, EVIDENCE_DIR, BACKUP_DIR]) fs.mkdirSync(d, { recursive: true });
  const db = new DatabaseSync(DB_PATH, { readOnly: readonly });
  try { db.exec('PRAGMA busy_timeout = 5000'); } catch { /* fine */ }   // the worker tick and a session may collect at the same time
  if (!readonly) {
    db.exec(fs.readFileSync(path.join(OBS_DIR, 'schema.sql'), 'utf8'));
    db.exec(fs.readFileSync(path.join(OBS_DIR, 'views.sql'), 'utf8'));
    const has = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(SCHEMA_VERSION);
    if (!has) db.prepare('INSERT INTO schema_migrations (version, applied_at, note) VALUES (?, ?, ?)').run(SCHEMA_VERSION, nowIso(), 'initial schema');
  }
  return db;
}

// Canonical event. `seq` makes the id unique within (actor, run, trace, type); callers pass something stable (a line number, an item id,
// a timestamp from the source) so re-ingesting the same source never duplicates.
export function makeEvent({ ts, run_id = null, trace_id = null, span_id = null, parent_span_id = null, actor, type, severity = 'info', entity_type = null, entity_id = null,
  outcome = null, duration_ms = null, error_class = null, error_cause = null, error_handling = null, payload = {}, seq = null, source_file = null }) {
  if (!actor || !type) throw new Error('event needs actor and type');
  const id = sha1([actor, run_id, trace_id, type, seq ?? JSON.stringify(payload).slice(0, 400)].join('|'));
  return { event_id: id, ts: ts || nowIso(), run_id, trace_id, span_id, parent_span_id, actor, type, severity, entity_type, entity_id, outcome, duration_ms, error_class, error_cause, error_handling,
    payload: JSON.stringify(payload), schema_version: SCHEMA_VERSION, source_file };
}

export function insertEvents(db, events) {
  if (!events.length) return 0;
  const stmt = db.prepare(`INSERT OR IGNORE INTO events (event_id, ts, run_id, trace_id, span_id, parent_span_id, actor, type, severity, entity_type, entity_id, outcome, duration_ms, error_class, error_cause, error_handling, payload, schema_version, ingested_at, source_file)
    VALUES (@event_id, @ts, @run_id, @trace_id, @span_id, @parent_span_id, @actor, @type, @severity, @entity_type, @entity_id, @outcome, @duration_ms, @error_class, @error_cause, @error_handling, @payload, @schema_version, @ingested_at, @source_file)`);
  let n = 0; const ingested_at = nowIso();
  db.exec('BEGIN');
  try { for (const e of events) { const r = stmt.run({ ...e, ingested_at }); n += r.changes; } db.exec('COMMIT'); }
  catch (err) { db.exec('ROLLBACK'); throw err; }
  return n;
}

// read a file incrementally: returns the new lines since the last ingest (by byte offset) and records the new size
export function newLines(db, file) {
  if (!fs.existsSync(file)) return { lines: [], from: 0 };
  const stat = fs.statSync(file);
  const prev = db.prepare('SELECT bytes, lines FROM ingest_log WHERE source = ?').get(file);
  const from = prev && prev.bytes <= stat.size ? prev.bytes : 0;
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(stat.size - from); fs.readSync(fd, buf, 0, buf.length, from); fs.closeSync(fd);
  const text = buf.toString('utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  return { lines, from, lineFrom: prev ? prev.lines : 0, size: stat.size, commit: () => db.prepare('INSERT OR REPLACE INTO ingest_log (source, bytes, lines, sha256, ingested_at) VALUES (?, ?, ?, NULL, ?)').run(file, stat.size, (prev ? prev.lines : 0) + lines.length, nowIso()) };
}

export const redact = obj => JSON.parse(JSON.stringify(obj, (k, v) => /password|token|secret|x-key|authorization/i.test(k) ? '[redacted]' : v));

// The data dictionary: every object + column Claude may query. Seeded on every collect (INSERT OR REPLACE).
export const DICTIONARY = [
  ['events', '', 'Append-only event log: one row per thing that happened anywhere in the loop. Never updated.', 'all actors', '2026-10-20'],
  ['events', 'event_id', 'sha1(actor|run_id|trace_id|type|seq); re-ingesting the same source is a no-op', '', ''],
  ['events', 'ts', 'When it happened (ISO UTC)', '', ''],
  ['events', 'run_id', 'Night run (hunt-YYYY-MM-DD), worker tick (worker-...), mail run, collector run', '', ''],
  ['events', 'trace_id', 'One company/role attempt = the board role id', '', ''],
  ['events', 'actor', 'Who emitted it: netlify:hunt | netlify:hunt-find | netlify:mail | agent:sorter|grader|preparer|mail-clerk | pc:worker | pc:collector | page:human | claude-code', '', ''],
  ['events', 'type', 'step.start | step.end | decision | guard.refused | transition | error | fire | claim | submit.attempt | submit.request | receipt | reconcile | settings | snapshot | heartbeat | question | run | field.fill | form.snapshot | ledger | mail | health | backup | log', '', ''],
  ['events', 'outcome', 'ok | fail | skipped | refused | unverified | released | blocked', '', ''],
  ['events', 'error_class / error_cause / error_handling', 'What went wrong / why / what the system did about it (handled | retried | parked | forfeited | needs-human | unhandled | released)', '', ''],
  ['events', 'payload', 'JSON with everything else; hot keys exposed as generated columns company, ats, status_from, status_to, reason', '', ''],
  ['snapshots', '', 'Full board state per collector pull, keyed by the board revision. The diff between consecutive snapshots yields transition events.', 'GET /state', '2026-10-20'],
  ['entities', '', 'Current companies and roles from the latest snapshot (rebuilt every collect). kind = company | role.', 'latest snapshot', '2026-10-20'],
  ['entities', 'apply_status', 'candidate | prepared | approved (= queued) | submitting | submitted | confirmed | unverified | blocked | failed | skipped (= forfeited or skipped by Eyal) | manual | real', '', ''],
  ['evidence', '', 'Files that prove or explain an attempt: screenshots, confirmation text, form snapshot, submit request, trace zip, CV copy', 'applications/<slug>/, obs/evidence/<trace>/', '2026-10-20'],
  ['rollups_daily', '', 'Precomputed daily metrics with provenance (which rule/table produced them)', 'collector', '2026-10-20'],
  ['question_log', '', 'Every question asked through obs.mjs ask/query with the SQL that answered it', 'obs.mjs', '2026-10-20'],
  ['v_attempts', '', 'One row per application attempt (role): timestamps per status, final status, verified flag + provenance, submit HTTP status, confirmation text, last error, evidence count', 'entities + events + evidence', '2026-10-20'],
  ['v_attempts', 'verified', '1 only when the mail clerk filed a receipt (status confirmed). submitted/unverified rows have provenance dom_confirmation (the page said thank you) and are NOT verified.', '', ''],
  ['v_form_fields', '', 'Every value the worker typed or picked in a form: field, label, value, source (profile | card.answers:<q> | default | recipe)', 'pc:worker field.fill events', '2026-10-20'],
  ['v_agent_decisions', '', 'Per-item decisions by the sorter / grader / preparer / mail clerk with reason, evidence, confidence, prompt version (from the agents trace blocks; before that from the board lists)', 'agent callbacks', '2026-10-20'],
  ['v_transitions', '', 'Every status change of a card (and company tier/grade changes), from the board diff or the function events', 'snapshot diff + netlify events', '2026-10-20'],
  ['v_errors', '', 'Every error from every actor with class, cause, handling', 'events', '2026-10-20'],
  ['v_worker_ticks', '', 'One row per PC worker tick: machine, chrome started/attached, counts, error, duration', 'worker/logs/runs.jsonl', '2026-10-20'],
  ['v_night_runs', '', 'One row per night run: seen, candidates, queued, forfeited, prepared, real leads, dropped reasons, errors, brief', 'board hunt.runs', '2026-10-20'],
  ['v_health', '', 'Health checks per collect: freshness, worker heartbeat, completeness, errors last 24h, dead letters', 'collector', '2026-10-20'],
  ['v_mail', '', 'Mail the clerk filed per role: kind (reply | rejected | update | ack | noise), subject, sender, date', 'board role.mail', '2026-10-20'],
  ['v_settings_history', '', 'Changes of caps, kill switch, autoQueue, concurrency, dreamlist, seeds, answer bank (old -> new)', 'snapshot diff', '2026-10-20'],
  ['v_forfeits', '', 'Cards the board forfeited (skipped with a forfeited: reason) or Eyal skipped', 'transitions', '2026-10-20'],
  ['v_funnel_daily', '', 'Daily funnel numbers (alias of rollups_daily)', 'collector', '2026-10-20'],
  ['v_questions', '', 'Alias of question_log', '', ''],
];
export function seedDictionary(db) {
  const stmt = db.prepare('INSERT OR REPLACE INTO data_dictionary (object, column, meaning, source, since) VALUES (?, ?, ?, ?, ?)');
  for (const row of DICTIONARY) stmt.run(...row);
}
