// obs CLI, the one interface for questions about the apply loop (MONITORING-PLAN.md §5).
//   node obs/obs.mjs collect                      pull everything new into obs.db (board snapshot + diff, worker logs, evidence, health, rollups)
//   node obs/obs.mjs query "<sql>" [--json|--md]  run SQL (views: v_attempts, v_form_fields, v_agent_decisions, v_transitions, v_errors, v_worker_ticks, v_night_runs, v_health, v_mail, v_settings_history, v_forfeits, v_funnel_daily, v_questions)
//   node obs/obs.mjs ask "<question>" [--sql "<sql>"] [--by claude-code] [--verified]   log a question (and the SQL that answered it), run the SQL if given
//   node obs/obs.mjs trace <trace_id|company>     the whole story of one attempt: card, transitions, steps, fields, errors, evidence
//   node obs/obs.mjs brief [--since 24h|7d]       health, funnel, errors with cause/handling, submissions with verification, forfeits, worker ticks
//   node obs/obs.mjs verify                       recount from raw sources and compare with the board (provenance for every number)
//   node obs/obs.mjs backup                       online backup to obs/backups/obs-<date>.db (keeps 14)
//   node obs/obs.mjs dict [object]                data dictionary
//   node obs/obs.mjs open-trace <trace_id>        open the Playwright trace viewer for the attempt (needs a trace.zip in evidence)
//   node obs/obs.mjs questions                    the question templates in obs/questions.json with their SQL (run one: questions <n>)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDb, DB_PATH, BACKUP_DIR, OBS_DIR, nowIso } from './lib.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n, d) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d; };
const has = n => rest.includes(n);
const arg0 = rest.find(a => !a.startsWith('--') && rest[rest.indexOf(a) - 1] !== '--sql' && rest[rest.indexOf(a) - 1] !== '--since' && rest[rest.indexOf(a) - 1] !== '--by') || '';

function table(rows, { md = false } = {}) {
  if (!rows.length) return '(no rows)';
  const cols = Object.keys(rows[0]);
  const cell = v => v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const w = cols.map(c => Math.min(60, Math.max(c.length, ...rows.map(r => cell(r[c]).length))));
  const line = r => cols.map((c, i) => cell(r[c]).slice(0, 60).padEnd(w[i])).join(md ? ' | ' : '  ');
  const head = cols.map((c, i) => c.padEnd(w[i])).join(md ? ' | ' : '  ');
  const sep = md ? cols.map((c, i) => '-'.repeat(w[i])).join(' | ') : '-'.repeat(head.length);
  return [md ? `| ${head} |` : head, md ? `| ${sep} |` : sep, ...rows.map(r => md ? `| ${line(r)} |` : line(r))].join('\n');
}
const since = s => { const m = String(s || '24h').match(/^(\d+)([hd])$/); const ms = m ? parseInt(m[1], 10) * (m[2] === 'h' ? 3600000 : 86400000) : 86400000; return new Date(Date.now() - ms).toISOString(); };

function runQuery(db, sql, { json = false, md = false, limit = 200 } = {}) {
  const rows = db.prepare(sql).all().slice(0, limit);
  if (json) return JSON.stringify(rows, null, 1);
  return table(rows, { md });
}
function logQuestion(db, question, sql, rows, by, verified, note) {
  db.prepare('INSERT INTO question_log (ts, question, sql, rows, answered_by, verified, note) VALUES (?, ?, ?, ?, ?, ?, ?)').run(nowIso(), question, sql || null, rows ?? null, by || 'claude-code', verified ? 1 : 0, note || null);
}

if (!cmd || cmd === 'help') { console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n')); process.exit(0); }

if (cmd === 'collect') { const r = spawnSync(process.execPath, [path.join(OBS_DIR, 'collect.mjs'), ...rest], { stdio: 'inherit' }); process.exit(r.status || 0); }

const db = openDb();
try {
  if (cmd === 'query') {
    const sql = arg0; if (!sql) throw new Error('query needs SQL');
    const out = runQuery(db, sql, { json: has('--json'), md: has('--md'), limit: parseInt(flag('--limit', '200'), 10) });
    console.log(out);
    if (has('--log')) logQuestion(db, flag('--log', ''), sql, null, flag('--by', 'claude-code'), has('--verified'));
  } else if (cmd === 'ask') {
    const q = arg0; if (!q) throw new Error('ask needs a question');
    const sql = flag('--sql', '');
    let rows = null, out = '';
    if (sql) { const all = db.prepare(sql).all(); rows = all.length; out = table(all.slice(0, 200), { md: has('--md') }); }
    logQuestion(db, q, sql, rows, flag('--by', 'claude-code'), has('--verified'), flag('--note', ''));
    if (out) console.log(out); else { console.log('logged. Dictionary hints:'); console.log(table(db.prepare("SELECT object, meaning FROM data_dictionary WHERE column = '' ORDER BY object").all())); }
  } else if (cmd === 'trace') {
    const key = arg0; if (!key) throw new Error('trace needs a trace id or a company name');
    let role = db.prepare("SELECT * FROM entities WHERE kind = 'role' AND (id = ? OR lower(company) LIKE lower(?)) ORDER BY submitted_at DESC LIMIT 1").get(key, `%${key}%`);
    if (!role) {   // not on the live board (a localhost test card, or removed): tell the story from the events alone
      const any = db.prepare('SELECT trace_id, company FROM events WHERE trace_id = ? OR lower(company) LIKE lower(?) ORDER BY ts DESC LIMIT 1').get(key, `%${key}%`);
      if (!any) { console.log('no role or events match'); process.exit(1); }
      role = { id: any.trace_id, company: any.company, name: '', ats: '', grade: null, apply_status: '(not on the live board)', url: '', cv: '', pdf: '', json: '{}' };
    }
    const a = JSON.parse(role.json).apply || {};
    console.log(`== ${role.company} - ${role.name} [${role.id}] ${role.ats || ''} grade ${role.grade ?? '?'} status ${role.apply_status}`);
    console.log(`url ${role.url}\ncv ${role.cv} ${role.pdf || ''}\ntimeline: ${['found_at', 'prepared_at', 'approved_at', 'started_at', 'submitted_at', 'confirmed_at', 'unverified_at', 'blocked_at', 'failed_at'].filter(k => role[k]).map(k => `${k.replace(/_at$/, '')} ${role[k]}`).join(' · ')}`);
    if (role.reason) console.log(`reason: ${role.reason}`);
    if (a.screeners && a.screeners.length) { console.log('\n-- screeners on the card -> answers'); for (const s of a.screeners) console.log(`  ${s.q.slice(0, 90)} -> ${(a.answers || {})[s.q] || '(none)'}`); }
    console.log('\n-- events'); console.log(table(db.prepare('SELECT ts, actor, type, outcome, substr(coalesce(error_class, json_extract(payload, \'$.step\'), \'\'),1,20) AS step, substr(coalesce(error_cause, json_extract(payload, \'$.message\'), json_extract(payload, \'$.reason\'), json_extract(payload, \'$.to\'), \'\'),1,90) AS what FROM events WHERE trace_id = ? ORDER BY ts').all(role.id)));
    const fields = db.prepare('SELECT ts, field, label, value, source FROM v_form_fields WHERE trace_id = ? ORDER BY ts').all(role.id); if (fields.length) { console.log('\n-- form fields'); console.log(table(fields)); }
    const ev = db.prepare('SELECT kind, path, bytes, created_at FROM evidence WHERE trace_id = ? ORDER BY created_at').all(role.id); if (ev.length) { console.log('\n-- evidence'); console.log(table(ev)); }
    if (a.log) { console.log('\n-- runner log on the card'); console.log(a.log.slice(0, 2000)); }
  } else if (cmd === 'brief') {
    const s = since(flag('--since', '24h'));
    const health = db.prepare('SELECT check_name, outcome, value, detail FROM v_health WHERE ts = (SELECT max(ts) FROM v_health) ORDER BY outcome, check_name').all();
    console.log(`== health (latest collect)`); console.log(table(health));
    console.log(`\n== submissions since ${s.slice(0, 16)}`); console.log(table(db.prepare('SELECT company, title, ats, final_status, verified, verified_provenance, submitted_at, substr(confirmation_text,1,50) AS confirmation, evidence_files FROM v_attempts WHERE submitted_at > ? OR unverified_at > ? ORDER BY submitted_at DESC').all(s, s)));
    console.log(`\n== queue now`); console.log(table(db.prepare("SELECT company, title, ats, final_status, queued_at, claimed_at, reason FROM v_attempts WHERE final_status IN ('approved','submitting','prepared') ORDER BY queued_at").all()));
    console.log(`\n== errors since ${s.slice(0, 16)} (class / cause / handling)`); console.log(table(db.prepare('SELECT ts, actor, company, error_class, substr(error_cause,1,70) AS cause, error_handling FROM v_errors WHERE ts > ? ORDER BY ts DESC LIMIT 40').all(s)));
    console.log(`\n== forfeited since ${s.slice(0, 16)}`); console.log(table(db.prepare('SELECT ts, company, why, substr(coalesce(detail, reason),1,70) AS detail FROM v_forfeits WHERE ts > ? ORDER BY ts DESC').all(s)));
    console.log(`\n== night runs`); console.log(table(db.prepare('SELECT run_id, seen, candidates, queued, forfeited, prepared, real_leads, substr(brief,1,80) AS brief FROM v_night_runs ORDER BY ts DESC LIMIT 7').all()));
    console.log(`\n== worker ticks since ${s.slice(0, 16)}`); console.log(table(db.prepare('SELECT ts, run_id, chrome, submitted, failed, blocked, unverified, released, error, duration_ms FROM v_worker_ticks WHERE ts > ? ORDER BY ts DESC LIMIT 30').all(s)));
    console.log(`\n== mail since ${s.slice(0, 16)}`); console.log(table(db.prepare('SELECT ts, company, kind, substr(subject,1,50) AS subject FROM v_mail WHERE ts > ? ORDER BY ts DESC').all(s)));
  } else if (cmd === 'verify') {
    const snap = db.prepare('SELECT rev, json FROM snapshots ORDER BY rev DESC LIMIT 1').get(); if (!snap) throw new Error('no snapshot yet - run collect');
    const st = JSON.parse(snap.json); const roles = st.roles.filter(r => r.apply);
    const board = {}; for (const r of roles) board[r.apply.status] = (board[r.apply.status] || 0) + 1;
    const ent = Object.fromEntries(db.prepare("SELECT apply_status s, count(*) n FROM entities WHERE kind='role' AND apply_status IS NOT NULL GROUP BY s").all().map(r => [r.s, r.n]));
    const sentFromLogs = db.prepare("SELECT count(DISTINCT trace_id) n FROM events WHERE type='submit.attempt' AND outcome='ok' AND json_extract(payload,'$.dry') IS NOT 1").get().n;
    const ledger = (st.hunt.applied || []).length;
    const proofs = db.prepare("SELECT count(DISTINCT trace_id) n FROM evidence WHERE kind='screenshot.confirmed'").get().n;
    console.log(table([
      { number: 'sent (submitted+confirmed+unverified)', board: (board.submitted || 0) + (board.confirmed || 0) + (board.unverified || 0), entities: (ent.submitted || 0) + (ent.confirmed || 0) + (ent.unverified || 0), runner_logs: sentFromLogs, ledger, confirmed_screenshots: proofs },
      { number: 'verified (confirmed by receipt)', board: board.confirmed || 0, entities: ent.confirmed || 0, runner_logs: '', ledger: '', confirmed_screenshots: '' },
      { number: 'queued (approved)', board: board.approved || 0, entities: ent.approved || 0, runner_logs: '', ledger: '', confirmed_screenshots: '' },
      { number: 'forfeited/skipped', board: board.skipped || 0, entities: ent.skipped || 0, runner_logs: '', ledger: '', confirmed_screenshots: '' },
    ]));
    console.log(`board rev ${snap.rev}. A number is verified only when the columns agree; the runner_logs column counts confirmed attempts in the PC logs, ledger = never-twice entries, confirmed_screenshots = distinct attempts with a confirmed screenshot.`);
    logQuestion(db, 'verify: do the board, entities, runner logs, ledger and screenshots agree on the submission counts?', 'obs.mjs verify', 4, 'claude-code', 1);
  } else if (cmd === 'backup') {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const out = path.join(BACKUP_DIR, `obs-${nowIso().slice(0, 10)}.db`);
    db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    const keep = fs.readdirSync(BACKUP_DIR).filter(f => /^obs-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort(); for (const f of keep.slice(0, Math.max(0, keep.length - 14))) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
    db.prepare("INSERT OR IGNORE INTO events (event_id, ts, actor, type, severity, entity_type, entity_id, outcome, payload, schema_version, ingested_at) VALUES (?, ?, 'pc:collector', 'backup', 'info', 'board', 'obs.db', 'ok', ?, 1, ?)").run(`backup-${out}-${nowIso()}`, nowIso(), JSON.stringify({ path: out, bytes: fs.statSync(out).size }), nowIso());
    console.log(`backup written: ${out} (${fs.statSync(out).size} bytes); ${Math.min(keep.length, 14)} kept`);
  } else if (cmd === 'dict') {
    const obj = arg0; console.log(table(db.prepare(obj ? 'SELECT object, column, meaning, source FROM data_dictionary WHERE object = ? ORDER BY column' : "SELECT object, column, meaning FROM data_dictionary ORDER BY object, column").all(...(obj ? [obj] : []))));
  } else if (cmd === 'open-trace') {
    const t = arg0; const z = db.prepare("SELECT path FROM evidence WHERE trace_id = ? AND kind = 'trace.zip' ORDER BY created_at DESC LIMIT 1").get(t);
    if (!z) throw new Error('no trace.zip for that attempt');
    spawnSync('npx', ['playwright', 'show-trace', z.path], { stdio: 'inherit', shell: true });
  } else if (cmd === 'questions') {
    const qs = JSON.parse(fs.readFileSync(path.join(OBS_DIR, 'questions.json'), 'utf8'));
    const n = parseInt(arg0, 10);
    if (Number.isInteger(n)) { const q = qs[n - 1]; if (!q) throw new Error('no such question'); console.log(`# ${n}. ${q.q}\n${q.sql}\n`); const all = db.prepare(q.sql).all(); console.log(table(all.slice(0, 100), { md: has('--md') })); logQuestion(db, q.q, q.sql, all.length, 'template:' + n, 0); }
    else qs.forEach((q, i) => console.log(`${String(i + 1).padStart(2)}. ${q.q}${q.note ? `   [${q.note}]` : ''}`));
  } else throw new Error(`unknown command ${cmd}`);
} catch (e) { console.error('error:', e.message); process.exitCode = 1; }
finally { db.close(); }
