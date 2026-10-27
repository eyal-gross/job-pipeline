-- Stable views Claude queries (MONITORING-PLAN.md §4). Re-created on every open (DROP + CREATE) so changes here apply immediately.
DROP VIEW IF EXISTS v_attempts;
CREATE VIEW v_attempts AS
SELECT r.id AS trace_id, r.company_id, r.company, r.domain, r.name AS title, r.ats, r.source, r.grade, r.tier, r.cv,
       r.apply_status AS final_status, r.found_at, r.prepared_at, r.approved_at AS queued_at, r.started_at AS claimed_at,
       r.submitted_at, r.confirmed_at, r.unverified_at, r.blocked_at, r.failed_at, r.run_id AS worker_run, r.hunt_run_id AS night_run,
       r.reason, r.needs_human, r.screenshot, r.pdf, r.url,
       CASE WHEN r.apply_status = 'confirmed' THEN 1 ELSE 0 END AS verified,
       CASE WHEN r.apply_status = 'confirmed' THEN 'receipt' WHEN r.apply_status IN ('submitted','unverified') THEN 'dom_confirmation' ELSE NULL END AS verified_provenance,
       (SELECT json_extract(e.payload, '$.status') FROM events e WHERE e.trace_id = r.id AND e.type = 'submit.request' ORDER BY e.ts DESC LIMIT 1) AS submit_http_status,
       (SELECT json_extract(e.payload, '$.text') FROM events e WHERE e.trace_id = r.id AND e.type = 'submit.attempt' AND e.outcome = 'ok' ORDER BY e.ts DESC LIMIT 1) AS confirmation_text,
       (SELECT e.error_class FROM events e WHERE e.trace_id = r.id AND e.type = 'error' ORDER BY e.ts DESC LIMIT 1) AS last_error_class,
       (SELECT e.error_cause FROM events e WHERE e.trace_id = r.id AND e.type = 'error' ORDER BY e.ts DESC LIMIT 1) AS last_error_cause,
       (SELECT e.error_handling FROM events e WHERE e.trace_id = r.id AND e.type = 'error' ORDER BY e.ts DESC LIMIT 1) AS last_error_handling,
       (SELECT count(*) FROM evidence ev WHERE ev.trace_id = r.id) AS evidence_files
FROM entities r WHERE r.kind = 'role' AND r.apply_status IS NOT NULL;

DROP VIEW IF EXISTS v_form_fields;
CREATE VIEW v_form_fields AS
SELECT e.trace_id, e.run_id, e.ts, e.company,
       json_extract(e.payload, '$.field') AS field, json_extract(e.payload, '$.label') AS label,
       json_extract(e.payload, '$.value') AS value, json_extract(e.payload, '$.source') AS source,
       json_extract(e.payload, '$.selector') AS selector, json_extract(e.payload, '$.kind') AS control
FROM events e WHERE e.type = 'field.fill';

DROP VIEW IF EXISTS v_agent_decisions;
CREATE VIEW v_agent_decisions AS
SELECT e.ts, e.run_id, e.trace_id, e.actor AS agent, e.company,
       json_extract(e.payload, '$.item') AS item, json_extract(e.payload, '$.decision') AS decision,
       json_extract(e.payload, '$.reason') AS reason, json_extract(e.payload, '$.evidence') AS evidence,
       json_extract(e.payload, '$.confidence') AS confidence, json_extract(e.payload, '$.promptVersion') AS prompt_version,
       json_extract(e.payload, '$.startedAt') AS started_at, json_extract(e.payload, '$.finishedAt') AS finished_at, e.outcome
FROM events e WHERE e.type = 'decision' AND e.actor LIKE 'agent:%';

DROP VIEW IF EXISTS v_transitions;
CREATE VIEW v_transitions AS
SELECT e.ts, e.trace_id, e.company, e.entity_type, e.entity_id, e.actor, e.status_from AS status_from, e.status_to AS status_to,
       json_extract(e.payload, '$.field') AS field, json_extract(e.payload, '$.byHuman') AS by_human, e.reason, e.run_id, e.source_file
FROM events e WHERE e.type = 'transition';

DROP VIEW IF EXISTS v_errors;
CREATE VIEW v_errors AS
SELECT e.ts, e.actor, e.run_id, e.trace_id, e.company, e.error_class, e.error_cause, e.error_handling, e.severity, e.outcome,
       json_extract(e.payload, '$.message') AS message, json_extract(e.payload, '$.step') AS step, e.source_file
FROM events e WHERE e.type = 'error' OR e.severity = 'error';

DROP VIEW IF EXISTS v_worker_ticks;
-- one row per tick: the worker emits a 'run' event at start (empty payload) and at the end, and runs.jsonl adds a third; fold them (21 Oct 2026)
CREATE VIEW v_worker_ticks AS
SELECT min(e.ts) AS ts, e.run_id, max(json_extract(e.payload, '$.machine')) AS machine, max(json_extract(e.payload, '$.chrome')) AS chrome,
       max(json_extract(e.payload, '$.dry')) AS dry, max(json_extract(e.payload, '$.submitted')) AS submitted, max(json_extract(e.payload, '$.failed')) AS failed,
       max(json_extract(e.payload, '$.blocked')) AS blocked, max(json_extract(e.payload, '$.unverified')) AS unverified, max(json_extract(e.payload, '$.released')) AS released,
       max(json_extract(e.payload, '$.error')) AS error, max(e.duration_ms) AS duration_ms, max(e.outcome) AS outcome, max(json_extract(e.payload, '$.claimed')) AS claimed, max(json_extract(e.payload, '$.board')) AS board
FROM events e WHERE e.type = 'run' AND e.actor = 'pc:worker' GROUP BY e.run_id;

DROP VIEW IF EXISTS v_night_runs;
CREATE VIEW v_night_runs AS
SELECT e.ts, e.run_id, json_extract(e.payload, '$.found') AS seen, json_extract(e.payload, '$.candidates') AS candidates,
       json_extract(e.payload, '$.queued') AS queued, json_extract(e.payload, '$.forfeited') AS forfeited, json_extract(e.payload, '$.prepared') AS prepared,
       json_extract(e.payload, '$.realLeads') AS real_leads, json_extract(e.payload, '$.manualOnly') AS manual_only, json_extract(e.payload, '$.dropped') AS dropped,
       json_extract(e.payload, '$.refused') AS refused, json_extract(e.payload, '$.errors') AS errors, json_extract(e.payload, '$.brief') AS brief, e.outcome
FROM events e WHERE e.type = 'run' AND e.actor = 'netlify:hunt';

DROP VIEW IF EXISTS v_health;
CREATE VIEW v_health AS
SELECT e.ts, json_extract(e.payload, '$.check') AS check_name, e.outcome, json_extract(e.payload, '$.value') AS value, json_extract(e.payload, '$.detail') AS detail
FROM events e WHERE e.type = 'health';

DROP VIEW IF EXISTS v_mail;
CREATE VIEW v_mail AS
SELECT e.ts, e.trace_id, e.company, json_extract(e.payload, '$.kind') AS kind, json_extract(e.payload, '$.subject') AS subject,
       json_extract(e.payload, '$.from') AS sender, json_extract(e.payload, '$.date') AS mail_date, json_extract(e.payload, '$.summary') AS summary, json_extract(e.payload, '$.link') AS link
FROM events e WHERE e.type = 'mail';

DROP VIEW IF EXISTS v_settings_history;
CREATE VIEW v_settings_history AS
SELECT e.ts, e.actor, json_extract(e.payload, '$.field') AS field, json_extract(e.payload, '$.from') AS old_value, json_extract(e.payload, '$.to') AS new_value, e.source_file
FROM events e WHERE e.type = 'settings';

DROP VIEW IF EXISTS v_questions;
CREATE VIEW v_questions AS SELECT id, ts, question, sql, rows, answered_by, verified, note FROM question_log;

DROP VIEW IF EXISTS v_funnel_daily;
CREATE VIEW v_funnel_daily AS
SELECT date, metric, value, provenance FROM rollups_daily;

DROP VIEW IF EXISTS v_forfeits;
CREATE VIEW v_forfeits AS
SELECT e.ts, e.trace_id, e.company, e.reason, json_extract(e.payload, '$.why') AS why, json_extract(e.payload, '$.detail') AS detail, e.run_id
FROM events e WHERE e.type = 'transition' AND e.status_to = 'skipped' AND (e.reason LIKE 'forfeited%' OR json_extract(e.payload, '$.why') IS NOT NULL);
