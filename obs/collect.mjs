// Collector (MONITORING-PLAN.md §3): pulls everything observable into obs.db, idempotently.
//   node obs/collect.mjs [--board <url>] [--quiet]
// 1. board snapshot (GET /state) -> snapshots row; diff vs the previous snapshot -> transition / settings / ledger / mail / run / heartbeat events
// 2. entities table rebuilt from the latest snapshot
// 3. local worker files: logs/runs.jsonl (ticks), logs/*.log (step lines), logs/outbox.jsonl, logs/claims/*.json, obs/raw/worker/*.jsonl (step 2 events)
// 4. board event chunks (obs endpoint, step 3 of the plan) when the endpoint exists
// 5. evidence files under applications/<slug>/ and obs/evidence/<trace>/
// 6. reconciliation + health checks + daily rollups + data dictionary
import fs from 'node:fs';
import path from 'node:path';
import { openDb, makeEvent, insertEvents, newLines, env, sha256File, nowIso, RAW_DIR, EVIDENCE_DIR, RUNNER_DIR, APPLICATIONS_DIR, BOARD_URL, seedDictionary } from './lib.mjs';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const quiet = args.includes('--quiet');
const say = m => { if (!quiet) console.log(m); };
const board = (flag('--board', BOARD_URL)).replace(/\/$/, '');
const E = env();
const db = openDb();
const runId = `collect-${nowIso().replace(/[-:T]/g, '').slice(0, 14)}`;
const COLLECTOR = 'pc:collector';
const totals = {};
const add = (k, n) => { totals[k] = (totals[k] || 0) + n; };
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'company';

// ---------------- 1. board snapshot + diff ----------------
async function pullSnapshot() {
  if (!E.PIPELINE_KEY) { say('no PIPELINE_KEY - skipping the board'); return null; }
  let doc;
  try { const r = await fetch(`${board}/.netlify/functions/state`, { headers: { 'x-key': E.PIPELINE_KEY } }); if (!r.ok) throw new Error(`GET state ${r.status}`); doc = await r.json(); }
  catch (e) { insertEvents(db, [makeEvent({ actor: COLLECTOR, run_id: runId, type: 'error', severity: 'error', error_class: 'board-unreachable', error_cause: e.message, error_handling: 'handled', payload: { board } })]); say(`board unreachable: ${e.message}`); return null; }
  const json = JSON.stringify(doc.state);
  const sha = crypto.createHash('sha256').update(json).digest('hex');
  const prev = db.prepare('SELECT rev, json FROM snapshots ORDER BY rev DESC LIMIT 1').get();
  if (prev && prev.rev === doc.rev) { say(`board rev ${doc.rev} unchanged`); return { st: doc.state, rev: doc.rev, prevState: null, fresh: false }; }
  db.prepare('INSERT OR REPLACE INTO snapshots (rev, ts, updated_at, sha256, bytes, json) VALUES (?, ?, ?, ?, ?, ?)').run(doc.rev, nowIso(), doc.state.updatedAt || null, sha, json.length, json);
  fs.mkdirSync(path.join(RAW_DIR, 'snapshots'), { recursive: true });
  fs.writeFileSync(path.join(RAW_DIR, 'snapshots', `state-${doc.rev}.json`), json);
  insertEvents(db, [makeEvent({ actor: COLLECTOR, run_id: runId, type: 'snapshot', entity_type: 'board', entity_id: String(doc.rev), payload: { rev: doc.rev, bytes: json.length, prevRev: prev ? prev.rev : null }, seq: doc.rev })]);
  say(`snapshot rev ${doc.rev} (${json.length} bytes)${prev ? ` after rev ${prev.rev}` : ' (first)'}`);
  return { st: doc.state, rev: doc.rev, prevState: prev ? JSON.parse(prev.json) : { companies: [], roles: [], hunt: {}, mail: {} }, fresh: true };
}

const byId = arr => Object.fromEntries((arr || []).map(x => [x.id, x]));
const gradeOf = c => { const g = c && c.research && c.research.fit && c.research.fit.grade; return Number.isInteger(g) ? g : null; };
const domainOf = c => { const h = c.hunt && c.hunt.domain; if (h) return h; try { return new URL(/^https?:/.test(c.links || '') ? c.links.split(/\s/)[0] : 'https://' + String(c.links || '').split(/\s/)[0]).hostname.replace(/^www\./, ''); } catch { return ''; } };

function diffSnapshots(prevState, st, rev) {
  const ev = [];
  const pc = byId(prevState.companies), pr = byId(prevState.roles), cc = byId(st.companies), cr = byId(st.roles);
  const tsOf = (a, to) => (a && (a[`${to}At`] || a[{ approved: 'approvedAt', submitting: 'startedAt', submitted: 'submittedAt', prepared: 'preparedAt', candidate: 'foundAt' }[to]])) || nowIso();
  // roles: apply status, stage, new / removed
  for (const r of st.roles) {
    const c = cc[r.companyId] || {}; const a = r.apply || {}; const p = pr[r.id]; const pa = p && p.apply || {};
    const base = { trace_id: r.id, entity_type: 'role', entity_id: r.id, actor: 'netlify:state', run_id: a.runId || (c.hunt && c.hunt.runId) || null };
    if (!p) ev.push(makeEvent({ ...base, type: 'transition', ts: a.foundAt || r.createdAt || nowIso(), payload: { company: c.name, title: r.title, from: null, to: a.status || null, field: 'apply.status', ats: a.ats, source: c.hunt && c.hunt.source, grade: gradeOf(c), stage: r.stage, reason: a.reason || null, created: true }, seq: `created@${rev}` }));
    else {
      if ((pa.status || null) !== (a.status || null)) ev.push(makeEvent({ ...base, type: 'transition', ts: tsOf(a, a.status), payload: { company: c.name, title: r.title, from: pa.status || null, to: a.status || null, field: 'apply.status', ats: a.ats, reason: a.reason || null, byHuman: null, workerId: a.workerId || null, why: a.reason && /^forfeited: (\w+)/.test(a.reason) ? a.reason.match(/^forfeited: (\w+)/)[1] : null }, seq: `apply@${rev}` }));
      if ((p.stage || null) !== (r.stage || null)) ev.push(makeEvent({ ...base, type: 'transition', payload: { company: c.name, title: r.title, from: p.stage || null, to: r.stage || null, field: 'stage' }, seq: `stage@${rev}` }));
      if (JSON.stringify(pa.answers || {}) !== JSON.stringify(a.answers || {})) ev.push(makeEvent({ ...base, type: 'transition', actor: 'page:human', payload: { company: c.name, field: 'apply.answers', from: pa.answers || {}, to: a.answers || {}, needsHuman: a.needsHuman || [] }, seq: `answers@${rev}` }));
      if ((pa.needsHuman || []).length !== (a.needsHuman || []).length) ev.push(makeEvent({ ...base, type: 'transition', payload: { company: c.name, field: 'apply.needsHuman', from: (pa.needsHuman || []).length, to: (a.needsHuman || []).length, open: a.needsHuman || [] }, seq: `needs@${rev}` }));
      // mail filed on the role
      const seen = new Set((p.mail || []).map(m => m.id));
      for (const m of (r.mail || [])) if (!seen.has(m.id)) ev.push(makeEvent({ ...base, actor: 'agent:mail-clerk', type: 'mail', ts: m.date || nowIso(), payload: { company: c.name, kind: m.kind, subject: m.subject, from: m.from, date: m.date, summary: m.summary, link: m.link, gmailId: m.gmailId }, seq: m.id }));
    }
  }
  for (const p of prevState.roles) if (!cr[p.id]) ev.push(makeEvent({ trace_id: p.id, entity_type: 'role', entity_id: p.id, actor: 'netlify:state', type: 'transition', payload: { company: (pc[p.companyId] || {}).name, title: p.title, from: p.apply && p.apply.status || null, to: 'removed', field: 'apply.status', reason: 'card removed from the board (dropCandidate / leftover / cap)' }, seq: `removed@${rev}` }));
  // companies: tier, grade, hunt status
  for (const c of st.companies) {
    const p = pc[c.id]; const base = { entity_type: 'company', entity_id: c.id, actor: 'netlify:state', run_id: c.hunt && c.hunt.runId || null };
    if (!p) { ev.push(makeEvent({ ...base, type: 'transition', ts: c.hunt && c.hunt.foundAt || nowIso(), payload: { company: c.name, field: 'company', from: null, to: 'created', tier: c.tier, source: c.hunt && c.hunt.source, domain: domainOf(c) }, seq: `created@${rev}` })); continue; }
    if ((p.tier || null) !== (c.tier || null)) ev.push(makeEvent({ ...base, type: 'transition', payload: { company: c.name, field: 'tier', from: p.tier || null, to: c.tier || null, grade: gradeOf(c) }, seq: `tier@${rev}` }));
    if (gradeOf(p) !== gradeOf(c)) ev.push(makeEvent({ ...base, type: 'decision', actor: 'agent:grader', ts: c.hunt && c.hunt.gradedAt || nowIso(), payload: { company: c.name, item: c.id, decision: `grade ${gradeOf(c)}`, from: gradeOf(p), to: gradeOf(c), reason: (c.research && c.research.fit && (c.research.fit.reasons || []).join('; ')) || '', evidence: (c.research && c.research.sources) || [], promptVersion: c.research && c.research.depth || null }, seq: `grade@${rev}` }));
    const ph = p.hunt || {}, ch = c.hunt || {};
    if ((ph.status || null) !== (ch.status || null)) ev.push(makeEvent({ ...base, type: 'transition', payload: { company: c.name, field: 'hunt.status', from: ph.status || null, to: ch.status || null, attempts: ch.attempts, error: ch.error || null }, seq: `hunt@${rev}`, severity: ch.status === 'failed' ? 'error' : 'info', error_class: ch.status === 'failed' ? 'agent-did-not-return' : null, error_cause: ch.status === 'failed' ? ch.error || null : null, error_handling: ch.status === 'failed' ? 'forfeited' : null }));
  }
  // hunt settings
  const ph = prevState.hunt || {}, h = st.hunt || {};
  for (const k of ['killSwitch', 'autoQueue', 'concurrency', 'denyExtra', 'seeds', 'answerBankAt']) if (JSON.stringify(ph[k] ?? null) !== JSON.stringify(h[k] ?? null)) ev.push(makeEvent({ actor: 'page:human', entity_type: 'board', entity_id: 'hunt', type: 'settings', payload: { field: k, from: ph[k] ?? null, to: h[k] ?? null }, seq: `${k}@${rev}` }));
  for (const k of Object.keys({ ...(ph.caps || {}), ...(h.caps || {}) })) if ((ph.caps || {})[k] !== (h.caps || {})[k]) ev.push(makeEvent({ actor: 'page:human', entity_type: 'board', entity_id: 'hunt', type: 'settings', payload: { field: `caps.${k}`, from: (ph.caps || {})[k] ?? null, to: (h.caps || {})[k] ?? null }, seq: `caps.${k}@${rev}` }));
  // ledger
  const prevLedger = new Set((ph.applied || []).map(a => a.roleId || a.name));
  for (const a of (h.applied || [])) if (!prevLedger.has(a.roleId || a.name)) ev.push(makeEvent({ actor: 'netlify:hunt', type: 'ledger', trace_id: a.roleId || null, entity_type: 'company', entity_id: a.name, ts: a.at || nowIso(), payload: { company: a.name, domain: a.domain, roleId: a.roleId }, seq: a.roleId || a.name }));
  // night runs (hunt.runs) - every run record once, with its lists as decision events
  const prevRuns = new Set((ph.runs || []).map(r => r.runId + '|' + JSON.stringify(r.funnel || {}) + (r.pending ?? '')));
  for (const r of (h.runs || [])) {
    const key = r.runId + '|' + JSON.stringify(r.funnel || {}) + (r.pending ?? '');
    if (prevRuns.has(key)) continue;
    const f = r.funnel || {};
    ev.push(makeEvent({ actor: 'netlify:hunt', run_id: r.runId, entity_type: 'run', entity_id: r.runId, type: 'run', ts: r.at, outcome: r.ok ? 'ok' : 'fail', payload: { found: f.found, candidates: r.candidates, dropped: f.dropped || {}, refused: r.refused || {}, queued: (r.queued || []).length, forfeited: (r.forfeited || []).length, prepared: (r.prepared || []).length, realLeads: (r.realLeads || []).length, manualOnly: (r.manualOnly || []).length, droppedList: (r.dropped || []).length, pending: r.pending, errors: r.errors || [], brief: r.brief, noop: r.noop || null }, seq: `run@${rev}` }));
    for (const [list, decision] of [['queued', 'queued'], ['forfeited', 'forfeited'], ['prepared', 'prepared'], ['realLeads', 'real lead'], ['manualOnly', 'by hand'], ['dropped', 'dropped']]) {
      for (const it of (r[list] || [])) ev.push(makeEvent({ actor: 'netlify:hunt', run_id: r.runId, trace_id: it.roleId || null, entity_type: 'role', entity_id: it.roleId || null, type: 'decision', ts: r.at, outcome: decision === 'forfeited' || decision === 'dropped' ? 'skipped' : 'ok', payload: { company: it.company, title: it.title, item: it.roleId, decision, reason: it.why || it.sentence || '', detail: it.detail || '', ats: it.ats, grade: it.grade, cv: it.cv, status: it.status }, seq: `${list}:${it.roleId || it.company}` }));
    }
    for (const errText of (r.errors || [])) ev.push(makeEvent({ actor: 'netlify:hunt', run_id: r.runId, entity_type: 'run', entity_id: r.runId, type: 'error', severity: 'warn', ts: r.at, error_class: 'night-run-note', error_cause: errText, error_handling: 'handled', payload: { message: errText }, seq: errText.slice(0, 80) }));
  }
  // finder log lines (hunt.find) - the current run only (the board overwrites it nightly)
  const f = h.find || {};
  if (f.runId) {
    const pf = ph.find || {}; const prevLines = pf.runId === f.runId ? (pf.log || []).length : 0;
    (f.log || []).forEach((line, i) => { if (i >= prevLines) ev.push(makeEvent({ actor: 'netlify:hunt-find', run_id: f.runId, entity_type: 'run', entity_id: f.runId, type: 'step.end', ts: f.finishedAt || f.firedAt || f.startedAt || nowIso(), payload: { message: line, step: (line.split(':')[0] || '').slice(0, 30) }, seq: `log:${i}` })); });
    (f.errors || []).forEach((e, i) => { if (i >= (pf.runId === f.runId ? (pf.errors || []).length : 0)) ev.push(makeEvent({ actor: 'netlify:hunt-find', run_id: f.runId, entity_type: 'run', entity_id: f.runId, type: 'error', severity: 'warn', ts: f.finishedAt || nowIso(), error_class: 'finder-source', error_cause: e, error_handling: 'handled', payload: { message: e }, seq: `err:${i}` })); });
    if ((pf.status || null) !== (f.status || null)) ev.push(makeEvent({ actor: 'netlify:hunt-find', run_id: f.runId, entity_type: 'run', entity_id: f.runId, type: 'transition', payload: { field: 'find.status', from: pf.status || null, to: f.status, step: f.step, funnel: f.funnel || {} }, seq: `find@${rev}` }));
  }
  // worker heartbeat (hunt.worker.lastReport) - the board keeps one; our runs.jsonl has them all, this is the board's view
  const w = h.worker || {}; const pw = ph.worker || {};
  if (w.lastAt && w.lastAt !== pw.lastAt) ev.push(makeEvent({ actor: 'pc:worker', run_id: w.lastReport && w.lastReport.runId || null, entity_type: 'worker', entity_id: w.workerId || 'worker', type: 'heartbeat', ts: w.lastAt, payload: { machine: w.machine, chrome: w.chrome, lastError: w.lastError || null, today: w.today || null, report: w.lastReport || null }, seq: w.lastAt }));
  // mail clerk runs
  const m = st.mail || {}, pm = prevState.mail || {};
  if (m.lastRun && JSON.stringify(m.lastRun) !== JSON.stringify(pm.lastRun)) ev.push(makeEvent({ actor: 'agent:mail-clerk', run_id: `mail-${(m.lastRun.at || '').slice(0, 16)}`, entity_type: 'run', entity_id: 'mail', type: 'run', ts: m.lastRun.at, outcome: 'ok', payload: m.lastRun, seq: m.lastRun.at }));
  return ev;
}

// ---------------- 2. entities ----------------
function rebuildEntities(st) {
  const cc = byId(st.companies);
  db.exec('BEGIN');
  db.exec('DELETE FROM entities');
  const ins = db.prepare(`INSERT INTO entities (kind, id, name, company_id, company, domain, tier, grade, stage, hunt_status, apply_status, ats, source, cv, url, found_at, prepared_at, approved_at, started_at, submitted_at, confirmed_at, unverified_at, blocked_at, failed_at, run_id, hunt_run_id, reason, needs_human, screenshot, pdf, json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const c of st.companies) ins.run('company', c.id, c.name, c.id, c.name, domainOf(c), c.tier || 'real', gradeOf(c), c.stage || null, c.hunt && c.hunt.status || null, null, null, c.hunt && c.hunt.source || null, null, c.links || null, c.hunt && c.hunt.foundAt || null, null, null, null, null, null, null, null, null, null, c.hunt && c.hunt.runId || null, c.hunt && c.hunt.error || null, null, null, null, JSON.stringify(c));
  for (const r of st.roles) { const c = cc[r.companyId] || {}; const a = r.apply || {};
    ins.run('role', r.id, r.title, r.companyId, c.name || null, domainOf(c), r.tier || c.tier || null, gradeOf(c), r.stage || null, c.hunt && c.hunt.status || null, a.status || null, a.ats || null, c.hunt && c.hunt.source || null, a.cv || null, a.url || null, a.foundAt || null, a.preparedAt || null, a.approvedAt || null, a.startedAt || null, a.submittedAt || null, a.confirmedAt || null, a.unverifiedAt || null, a.blockedAt || null, a.failedAt || null, a.runId || null, c.hunt && c.hunt.runId || null, a.reason || null, (a.needsHuman || []).length, a.screenshot || null, a.pdf || null, JSON.stringify(r)); }
  db.exec('COMMIT');
}

// ---------------- 3. local worker files ----------------
const LOGS = path.join(RUNNER_DIR, 'logs');
function ingestRunsJsonl() {
  const file = path.join(LOGS, 'runs.jsonl'); const nl = newLines(db, file); const ev = [];
  for (const line of nl.lines) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    const isWorker = /^worker-/.test(r.runId);
    ev.push(makeEvent({ actor: 'pc:worker', run_id: r.runId, entity_type: 'worker', entity_id: r.runId, type: 'run', ts: r.at, outcome: r.error ? 'fail' : 'ok', duration_ms: r.ms || null, error_class: r.error ? 'tick-error' : null, error_cause: r.error || null, error_handling: r.error ? 'handled' : null,
      payload: { board: r.board, dry: !!r.dry, chrome: r.chrome || null, machine: null, submitted: (r.submitted || []).length, failed: (r.failed || []).length, blocked: (r.blocked || []).length, unverified: (r.unverified || []).length, released: (r.released || []).length, skipped: (r.skipped || []).length, error: r.error || null, aborted: r.aborted || null, manual: !isWorker, lists: { submitted: r.submitted, failed: r.failed, blocked: r.blocked, unverified: r.unverified, released: r.released, skipped: r.skipped } }, seq: r.runId, source_file: file }));
    for (const [list, outcome] of [['submitted', 'ok'], ['failed', 'fail'], ['blocked', 'blocked'], ['unverified', 'unverified'], ['released', 'released'], ['skipped', 'skipped']]) for (const it of (r[list] || [])) {
      const trace = it.id || it.roleId || null;
      ev.push(makeEvent({ actor: 'pc:worker', run_id: r.runId, trace_id: trace, entity_type: 'role', entity_id: trace, type: 'submit.attempt', ts: r.at, outcome, error_class: outcome === 'fail' ? 'card-failed' : outcome === 'blocked' ? (it.reason || 'blocked') : null, error_cause: it.why || it.reason || null, error_handling: outcome === 'fail' ? 'forfeited' : outcome === 'blocked' ? 'forfeited' : outcome === 'released' ? 'released' : outcome === 'unverified' ? 'unverified' : null,
        payload: { company: it.company, title: it.title, screenshot: it.screenshot || null, reason: it.reason || it.why || null, dry: !!r.dry }, seq: `${list}:${trace || it.company}`, source_file: file }));
    }
  }
  if (nl.lines.length) nl.commit();
  return ev;
}
// per-run text logs: one event per line; a [slug/roleId] tag binds the line to a trace
function ingestRunLogs() {
  const ev = []; if (!fs.existsSync(LOGS)) return ev;
  for (const f of fs.readdirSync(LOGS).filter(n => /^(run|worker)-.*\.log$/.test(n))) {
    const file = path.join(LOGS, f); const nl = newLines(db, file); if (!nl.lines.length) continue;
    const rid = f.replace(/\.log$/, ''); const day = (rid.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || nowIso().slice(0, 10);
    // The file name carries the tick's ISRAEL date and time (worker-YYYY-MM-DD-HHMMSS); the lines carry UTC clock times. Between 00:00 and
    // 02:59 Israel the UTC date is the day before (found 21 Oct 2026: the 00:09 tick's lines were stamped 21:11 the NEXT day). Anchor on the
    // file's local time: a line more than 6 h after it belongs to the previous UTC day; a line that wraps past UTC midnight inside one run
    // gets the next day.
    const localHms = (rid.match(/-(\d\d)(\d\d)(\d\d)$/) || []).slice(1).join(':') || '00:00:00';
    const localAsUtc = Date.parse(`${day}T${localHms}Z`); let firstMs = null;
    const lineTs = hms => { let t = Date.parse(`${day}T${hms}Z`); if (t - localAsUtc > 6 * 3600e3) t -= 86400e3; if (firstMs === null) firstMs = t; else if (firstMs - t > 12 * 3600e3) t += 86400e3; return new Date(t).toISOString(); };
    nl.lines.forEach((line, i) => {
      const m = line.match(/^(\d\d:\d\d:\d\d) (?:\[([^\]]+)\] )?(.*)$/); if (!m) return;
      const [, hms, tag, msg] = m; const trace = tag ? tag.split('/').pop() : null;
      const isErr = /^(STOP|CRASH|FORM-ERROR|BLOCKED|CHANGED-FORM|NEEDS-HUMAN|UPLOAD|TIMEOUT|DIALOG|NO-RECIPE|CV|RELEASE):|failed|refused/i.test(msg);
      const step = /^start /.test(msg) ? 'start' : /^cv /.test(msg) ? 'cv' : /identity filled/.test(msg) ? 'fill' : /cv attached/.test(msg) ? 'attach' : /screener answered|picked the first/.test(msg) ? 'screeners' : /gate passed/.test(msg) ? 'gate' : /^screenshot/.test(msg) ? 'screenshot' : /submit clicked/.test(msg) ? 'submit' : /^CONFIRMED/.test(msg) ? 'confirm' : /released back/.test(msg) ? 'release' : /pausing/.test(msg) ? 'pause' : /claimed|nothing to do/.test(msg) ? 'claim' : /google:|logged in|NOT logged in/.test(msg) ? 'login' : /attached over CDP|no Chrome|starting the runner/.test(msg) ? 'chrome' : /recovered|outbox/.test(msg) ? 'recovery' : /DRY RUN/.test(msg) ? 'dry' : 'log';
      const kindM = msg.match(/^([A-Z-]+): /); const errClass = isErr ? (kindM ? kindM[1].toLowerCase() : 'log-error') : null;
      ev.push(makeEvent({ actor: 'pc:worker', run_id: rid, trace_id: trace, entity_type: trace ? 'role' : 'worker', entity_id: trace || rid, type: isErr ? 'error' : (step === 'submit' ? 'submit.attempt' : 'log'), severity: isErr ? 'error' : 'info', ts: lineTs(hms), outcome: step === 'confirm' ? 'ok' : step === 'submit' ? 'clicked' : null, error_class: errClass, error_cause: isErr ? msg.replace(/^[A-Z-]+: /, '').slice(0, 300) : null, error_handling: isErr ? (/released|RELEASE/.test(msg) ? 'released' : /BLOCKED/.test(msg) ? 'forfeited' : /refused|parked/.test(msg) ? 'parked' : 'forfeited') : null,
        payload: { message: msg.slice(0, 1000), step, line: nl.lineFrom + i + 1, text: step === 'confirm' ? msg.replace(/^CONFIRMED: /, '') : undefined }, seq: `line:${nl.lineFrom + i + 1}`, source_file: file }));
    });
    nl.commit();
  }
  return ev;
}
function ingestOutboxAndClaims() {
  const ev = [];
  const ob = path.join(LOGS, 'outbox.jsonl'); const nl = newLines(db, ob);
  nl.lines.forEach((line, i) => { let it; try { it = JSON.parse(line); } catch { return; } ev.push(makeEvent({ actor: 'pc:worker', trace_id: it.roleId, entity_type: 'role', entity_id: it.roleId, type: 'error', severity: 'warn', ts: it.at, error_class: 'board-patch-parked', error_cause: 'board unreachable when the result was ready', error_handling: 'parked', payload: { patch: it.patch, message: `parked ${it.patch && it.patch.status}` }, seq: `outbox:${nl.lineFrom + i + 1}`, source_file: ob })); });
  if (nl.lines.length) nl.commit();
  const dir = path.join(LOGS, 'claims'); if (!fs.existsSync(dir)) return ev;
  for (const f of fs.readdirSync(dir)) { let l; try { l = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    for (const c of (l.cards || [])) ev.push(makeEvent({ actor: 'pc:worker', run_id: l.runId, trace_id: c.roleId, entity_type: 'role', entity_id: c.roleId, type: 'claim', ts: l.at, outcome: c.state, payload: { company: c.company, state: c.state }, seq: `${c.roleId}:${c.state}`, source_file: path.join(dir, f) })); }
  return ev;
}
// step-2 events written by the worker itself (obs/raw/worker/<runId>.jsonl): already canonical, ingest as-is
function ingestWorkerJsonl() {
  const ev = []; const dir = path.join(RAW_DIR, 'worker'); if (!fs.existsSync(dir)) return ev;
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.jsonl'))) {
    const file = path.join(dir, f); const nl = newLines(db, file); if (!nl.lines.length) continue;
    nl.lines.forEach((line, i) => { let e; try { e = JSON.parse(line); } catch { return; } try { ev.push(makeEvent({ ...e, seq: e.seq ?? `l${nl.lineFrom + i + 1}`, source_file: file })); } catch { /* bad line */ } });
    nl.commit();
  }
  return ev;
}

// ---------------- 4. board event chunks (plan step 3): list, download, ingest, then delete on the board (the PC is the archive) ----------------
async function pullBoardChunks() {
  if (!E.PIPELINE_KEY) return [];
  const H = { 'x-key': E.PIPELINE_KEY };
  let list; try { const r = await fetch(`${board}/.netlify/functions/obs?list=1`, { headers: H }); if (r.status === 404) { say('board has no obs endpoint yet'); return []; } if (!r.ok) throw new Error(`obs list ${r.status}`); list = await r.json(); } catch (e) { say(`board chunks: ${e.message}`); insertEvents(db, [makeEvent({ actor: COLLECTOR, run_id: runId, type: 'error', severity: 'warn', error_class: 'chunks-unreachable', error_cause: e.message, error_handling: 'handled', payload: { board } })]); return []; }
  const ev = []; const dir = path.join(RAW_DIR, 'board'); fs.mkdirSync(dir, { recursive: true });
  const done = [], failed = [];
  for (const key of (list.keys || [])) {
    if (db.prepare('SELECT 1 FROM ingest_log WHERE source = ?').get(`blob:${key}`)) { done.push(key); continue; }   // ingested earlier but not yet deleted on the board
    let text;
    try { const r = await fetch(`${board}/.netlify/functions/obs?key=${encodeURIComponent(key)}`, { headers: H }); if (!r.ok) throw new Error(`chunk ${r.status}`); text = await r.text(); } catch (e) { failed.push(`${key}: ${e.message}`); continue; }
    fs.writeFileSync(path.join(dir, key.replace(/^events\//, '').replace(/[\/:]/g, '_')), text);
    const lines = text.split(/\r?\n/).filter(Boolean); let bad = 0;
    lines.forEach((line, i) => { let e; try { e = JSON.parse(line); } catch { bad++; return; } try { ev.push(makeEvent({ ...e, seq: e.seq ?? `${key}#${i}`, source_file: `blob:${key}` })); } catch { bad++; } });
    db.prepare('INSERT OR REPLACE INTO ingest_log (source, bytes, lines, sha256, ingested_at) VALUES (?, ?, ?, ?, ?)').run(`blob:${key}`, text.length, lines.length, crypto.createHash('sha256').update(text).digest('hex'), nowIso());
    if (bad) ev.push(makeEvent({ actor: COLLECTOR, run_id: runId, type: 'error', severity: 'warn', error_class: 'chunk-bad-lines', error_cause: `${bad} unreadable lines in ${key}`, error_handling: 'handled', payload: { key, bad }, seq: key }));
    done.push(key);
  }
  if (done.length && !args.includes('--keep-chunks')) {
    for (let i = 0; i < done.length; i += 100) {
      const batch = done.slice(i, i + 100);
      try { const r = await fetch(`${board}/.netlify/functions/obs`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', keys: batch }) }); if (!r.ok) throw new Error(`delete ${r.status}`); } catch (e) { failed.push(`delete: ${e.message}`); }
    }
  }
  if (failed.length) insertEvents(db, [makeEvent({ actor: COLLECTOR, run_id: runId, type: 'error', severity: 'warn', error_class: 'chunk-pull-failed', error_cause: failed.slice(0, 5).join('; '), error_handling: 'retried', payload: { failed }, seq: runId })]);
  say(`board chunks: ${done.length} pulled (${ev.length} events)${failed.length ? `, ${failed.length} failed` : ''}`);
  return ev;
}

// ---------------- 5. evidence ----------------
function scanEvidence(st) {
  const ins = db.prepare('INSERT OR REPLACE INTO evidence (trace_id, run_id, kind, path, sha256, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  let n = 0;
  const roleBySlug = {}; for (const r of st.roles) { const c = st.companies.find(x => x.id === r.companyId); if (c) (roleBySlug[slug(c.name)] = roleBySlug[slug(c.name)] || []).push(r); }
  if (fs.existsSync(APPLICATIONS_DIR)) for (const d of fs.readdirSync(APPLICATIONS_DIR, { withFileTypes: true }).filter(x => x.isDirectory())) {
    for (const f of fs.readdirSync(path.join(APPLICATIONS_DIR, d.name))) {
      const m = f.match(/^((?:run|worker)-[\d-]+)-(filled|confirmed|blocked|failed)\.(png|txt)$/); if (!m) continue;
      const p = path.join(APPLICATIONS_DIR, d.name, f); const st2 = fs.statSync(p);
      const roles = roleBySlug[d.name] || []; const role = roles.find(r => r.apply && r.apply.runId === m[1]) || roles.find(r => r.apply && r.apply.screenshot && r.apply.screenshot.includes(m[1])) || roles[0];
      ins.run(role ? role.id : `slug:${d.name}`, m[1], m[3] === 'txt' ? 'confirmation.txt' : `screenshot.${m[2]}`, p, sha256File(p), st2.size, st2.mtime.toISOString()); n++;
    }
  }
  if (fs.existsSync(EVIDENCE_DIR)) for (const t of fs.readdirSync(EVIDENCE_DIR, { withFileTypes: true }).filter(x => x.isDirectory())) for (const f of fs.readdirSync(path.join(EVIDENCE_DIR, t.name))) {
    const p = path.join(EVIDENCE_DIR, t.name, f); const st2 = fs.statSync(p); const kind = /^form/.test(f) ? 'form.json' : /^request/.test(f) ? 'request.json' : /trace\.zip$/.test(f) ? 'trace.zip' : /\.pdf$/.test(f) ? 'cv.pdf' : /\.png$/.test(f) ? `screenshot.${f.replace(/\.png$/, '').split('-').pop()}` : 'file';
    const rid = (f.match(/^((?:run|worker)-[\d-]+)/) || [])[1] || null;
    ins.run(t.name, rid, kind, p, sha256File(p), st2.size, st2.mtime.toISOString()); n++;
  }
  return n;
}

// ---------------- 6. reconciliation, health, rollups ----------------
function reconcileAndHealth(st) {
  const ev = []; const now = Date.now();
  const roles = st.roles.filter(r => r.apply);
  const cnt = s => roles.filter(r => r.apply.status === s).length;
  const counts = { submitted: cnt('submitted'), confirmed: cnt('confirmed'), unverified: cnt('unverified'), approved: cnt('approved'), submitting: cnt('submitting'), blocked: cnt('blocked'), failed: cnt('failed'), skipped: cnt('skipped'), prepared: cnt('prepared') };
  // submissions with no local proof (screenshot path missing on disk)
  const noProof = roles.filter(r => ['submitted', 'confirmed', 'unverified'].includes(r.apply.status) && r.apply.runId && !(r.apply.screenshot && fs.existsSync(path.join(path.dirname(APPLICATIONS_DIR), r.apply.screenshot))));
  ev.push(makeEvent({ actor: 'pc:collector', run_id: runId, type: 'reconcile', entity_type: 'board', entity_id: 'apply', outcome: noProof.length ? 'fail' : 'ok', payload: { counts, provenance: 'latest board snapshot + applications/ files', sentTotal: counts.submitted + counts.confirmed + counts.unverified, verified: counts.confirmed, unverifiedSubmissions: counts.unverified, missingProof: noProof.map(r => ({ roleId: r.id, status: r.apply.status, screenshot: r.apply.screenshot || null })) }, seq: runId }));
  // health checks
  const h = st.hunt || {}; const checks = [];
  const lastRunAt = h.lastRun && Date.parse(h.lastRun.at); checks.push({ check: 'night_run_freshness', ok: !!lastRunAt && now - lastRunAt < 26 * 3600000, value: lastRunAt ? Math.round((now - lastRunAt) / 3600000) + 'h' : 'never', detail: h.lastRun && h.lastRun.runId });
  const w = h.worker || {}; const wAt = w.lastAt && Date.parse(w.lastAt); checks.push({ check: 'worker_heartbeat', ok: !counts.approved || (!!wAt && now - wAt < 24 * 3600000), value: wAt ? Math.round((now - wAt) / 60000) + 'min' : 'never', detail: `queue ${counts.approved}, lastError ${w.lastError || '-'}` });
  checks.push({ check: 'worker_last_error', ok: !w.lastError, value: w.lastError || '', detail: w.lastAt });
  const stuck = roles.filter(r => r.apply.status === 'submitting' && r.apply.startedAt && now - Date.parse(r.apply.startedAt) > 30 * 60000); checks.push({ check: 'stuck_submitting', ok: !stuck.length, value: stuck.length, detail: stuck.map(r => r.id).join(',') });
  checks.push({ check: 'evidence_complete', ok: !noProof.length, value: noProof.length, detail: 'submissions without a local screenshot' });
  const errs24 = db.prepare("SELECT count(*) n FROM events WHERE type = 'error' AND severity = 'error' AND ts > ?").get(new Date(now - 86400000).toISOString()).n; checks.push({ check: 'errors_24h', ok: errs24 < 10, value: errs24, detail: '' });
  const lr = h.lastRun || {}; const f = lr.funnel || {}; checks.push({ check: 'funnel_completeness', ok: (f.found || 0) >= (lr.candidates || 0) && (lr.candidates || 0) >= Math.max((lr.queued || []).length + (lr.forfeited || []).length, (lr.prepared || []).length), value: `${f.found || 0} seen -> ${lr.candidates || 0} candidates -> ${(lr.queued || []).length} queued + ${(lr.forfeited || []).length} forfeited`, detail: lr.runId });
  checks.push({ check: 'outbox_empty', ok: !fs.existsSync(path.join(LOGS, 'outbox.jsonl')), value: fs.existsSync(path.join(LOGS, 'outbox.jsonl')) ? 'has parked patches' : 'empty', detail: '' });
  checks.push({ check: 'kill_switch', ok: !h.killSwitch, value: h.killSwitch ? 'ON' : 'off', detail: '' });
  for (const c of checks) ev.push(makeEvent({ actor: 'pc:collector', run_id: runId, type: 'health', entity_type: 'board', entity_id: c.check, outcome: c.ok ? 'ok' : 'fail', severity: c.ok ? 'info' : 'warn', payload: { check: c.check, value: c.value, detail: c.detail || '' }, seq: `${c.check}@${runId}` }));
  // daily rollups from entities timestamps (provenance: entities.<col>) and events
  const up = db.prepare('INSERT OR REPLACE INTO rollups_daily (date, metric, value, provenance, computed_at) VALUES (?, ?, ?, ?, ?)');
  const byDay = (col) => db.prepare(`SELECT substr(${col}, 1, 10) d, count(*) n FROM entities WHERE kind = 'role' AND ${col} IS NOT NULL GROUP BY d`).all();
  for (const [metric, col] of [['submitted', 'submitted_at'], ['confirmed', 'confirmed_at'], ['unverified', 'unverified_at'], ['queued', 'approved_at'], ['prepared', 'prepared_at'], ['found', 'found_at'], ['blocked', 'blocked_at'], ['failed', 'failed_at']]) for (const r of byDay(col)) up.run(r.d, metric, r.n, `entities.${col}`, nowIso());
  for (const r of db.prepare("SELECT substr(ts,1,10) d, count(*) n FROM events WHERE type='transition' AND status_to='skipped' AND reason LIKE 'forfeited%' GROUP BY d").all()) up.run(r.d, 'forfeited', r.n, 'events transition->skipped forfeited', nowIso());
  for (const r of db.prepare("SELECT substr(ts,1,10) d, count(*) n FROM events WHERE type='error' AND severity='error' GROUP BY d").all()) up.run(r.d, 'errors', r.n, 'events type=error severity=error', nowIso());
  for (const r of db.prepare("SELECT substr(ts,1,10) d, count(*) n FROM events WHERE type='run' AND actor='pc:worker' GROUP BY d").all()) up.run(r.d, 'worker_ticks', r.n, 'events run pc:worker', nowIso());
  for (const r of db.prepare("SELECT substr(ts,1,10) d, sum(json_extract(payload,'$.found')) n FROM events WHERE type='run' AND actor='netlify:hunt' GROUP BY d").all()) if (r.n != null) up.run(r.d, 'roles_seen', r.n, 'events run netlify:hunt found', nowIso());
  return { ev, checks, counts };
}

// ---------------- main ----------------
const t0 = Date.now();
const snap = await pullSnapshot();
let all = [];
if (snap) {
  if (snap.fresh) { const d = diffSnapshots(snap.prevState, snap.st, snap.rev); add('board.diff', insertEvents(db, d)); }
  rebuildEntities(snap.st);
}
add('runs.jsonl', insertEvents(db, ingestRunsJsonl()));
add('run.logs', insertEvents(db, ingestRunLogs()));
add('outbox+claims', insertEvents(db, ingestOutboxAndClaims()));
add('worker.jsonl', insertEvents(db, ingestWorkerJsonl()));
add('board.chunks', insertEvents(db, await pullBoardChunks()));
const stForScan = snap ? snap.st : JSON.parse((db.prepare('SELECT json FROM snapshots ORDER BY rev DESC LIMIT 1').get() || { json: '{"companies":[],"roles":[],"hunt":{}}' }).json);
add('evidence', scanEvidence(stForScan));
const rh = reconcileAndHealth(stForScan);
add('reconcile+health', insertEvents(db, rh.ev));
seedDictionary(db);
insertEvents(db, [makeEvent({ actor: 'pc:collector', run_id: runId, type: 'run', entity_type: 'worker', entity_id: 'collector', outcome: 'ok', duration_ms: Date.now() - t0, payload: { ...totals, board, rev: snap ? snap.rev : null }, seq: runId })]);
const failing = rh.checks.filter(c => !c.ok);
say(`collected in ${Date.now() - t0} ms: ${Object.entries(totals).map(([k, v]) => `${k} ${v}`).join(', ')}`);
say(`health: ${rh.checks.length - failing.length}/${rh.checks.length} ok${failing.length ? ' - ' + failing.map(c => `${c.check}=${c.value}`).join('; ') : ''}`);
db.close();
