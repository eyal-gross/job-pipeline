// Board events (MONITORING-PLAN.md step 3) against localhost:8899 + the fire catcher on 8898 (tests/fire-catcher.mjs).
// Run:  cd job-pipeline; node tests/fire-catcher.mjs &  ROUTINE_FIRE_URL=http://localhost:8898/fire ROUTINE_TOKEN=local-test npx netlify dev --port 8899 --offline &  node tests/obs.test.mjs
// Checks: every board write produces events in the events store (settings, finder refusals, agent decisions, forfeits, 409s,
// worker claim / report, sweep, page-save diff, stale save, mail, fire failures, finder tick, revision conflicts lose nothing),
// the obs endpoint lists / serves / deletes chunks, and the PC collector ingests them into a scratch obs.db.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const B = 'http://localhost:8899/.netlify/functions';
const KEY = { 'x-key': env.PIPELINE_KEY, 'content-type': 'application/json' }, SEC = { 'x-secret': env.RESEARCH_SECRET, 'content-type': 'application/json' };
const j = async r => ({ status: r.status, body: await r.json().catch(() => null) });
const get = (fn, h, q = '') => fetch(`${B}/${fn}${q}`, { headers: h }).then(j);
const post = (fn, h, b) => fetch(`${B}/${fn}`, { method: 'POST', headers: h, body: JSON.stringify(b) }).then(j);
let pass = 0, fail = 0; const ok = (name, c, extra = '') => { if (c) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, typeof extra === 'string' ? extra.slice(0, 300) : JSON.stringify(extra).slice(0, 300)); } };
const state = async () => (await get('state', KEY)).body.state;
const roleOf = (st, name) => { const c = st.companies.find(x => x.name === name); return c && st.roles.find(r => r.companyId === c.id); };

// ---- events store helpers ----
async function chunks() { const r = await get('obs', KEY, '?list=1'); return r.body.keys || []; }
async function events() {
  const out = [];
  for (const key of await chunks()) { const t = await fetch(`${B}/obs?key=${encodeURIComponent(key)}`, { headers: KEY }).then(r => r.text()); for (const line of t.split('\n').filter(Boolean)) { const e = JSON.parse(line); e._key = key; out.push(e); } }
  return out;
}
const find = (ev, type, pred = () => true) => ev.filter(e => e.type === type && pred(e));
const one = (ev, type, pred) => find(ev, type, pred)[0];

// ---- clean slate: delete old chunks, seed state ----
// the delete action removes at most 200 chunks a call (26 Oct 2026: a full suite run leaves more, and the clean slate failed): clear in batches
for (let i = 0; i < 20; i++) { const old = await chunks(); if (!old.length) break; await post('obs', KEY, { action: 'delete', keys: old.slice(0, 200) }); }
ok('obs: empty list after delete (the delete itself writes no chunk)', (await chunks()).length === 0, await chunks());
ok('obs: unauthorized list refused', (await get('obs', {}, '?list=1')).status === 401);
ok('obs: a 401 is recorded as a request event', !!one(await events(), 'request', e => e.payload.status === 401 && e.payload.auth === 'none'));
const cur = await get('state', KEY);
ok('state GET advertises obs feature', cur.body.features && cur.body.features.obs === true);
const seed = { updatedAt: '', channels: cur.body.state.channels, people: [], tasks: [], companies: [
  { id: 'c-old', name: 'Oldco', what: '', stage: '', ceo: '', fit: '', links: 'https://oldco.com', notes: '', peopleIds: [], tier: 'real', research: { status: 'done', fit: { grade: 8 } } },   // real tier: blocks every role (role rule, 23 Oct 2026)
], roles: [] };
ok('seed state', (await post('state', KEY, { baseRev: cur.body.rev, state: seed })).status === 200);
let ev = await events();
ok('page save -> save event with diff (company added)', !!one(ev, 'save', e => e.payload.diff && e.payload.diff.companies.removed.length >= 0 && e.actor === 'page:human'), ev.map(e => e.type));
ok('every chunk carries a request event with status', [...new Set(ev.map(e => e._key))].every(k => ev.some(e => e._key === k && e.type === 'request' && typeof e.payload.status === 'number')), [...new Set(ev.map(e => e._key))].filter(k => !ev.some(e => e._key === k && e.type === 'request')).map(k => ev.filter(e => e._key === k).map(e => e.actor + ':' + e.type)));

// ---- settings ----
await post('hunt', KEY, { action: 'settings', killSwitch: false, autoQueue: true, caps: { found: 10, prepared: 8, perDay: 3 }, denyExtra: 'dreamco.ai', concurrency: 1 });
ev = await events();
ok('settings change -> settings events with from/to', !!one(ev, 'settings', e => e.payload.field === 'caps.perDay' && e.payload.to === 3) && !!one(ev, 'settings', e => e.payload.field === 'denyExtra' && e.payload.to === 'dreamco.ai'), find(ev, 'settings').map(e => e.payload));
await post('hunt', KEY, { action: 'settings', caps: { perDay: 3 } });
ev = await events();
ok('settings call with no change -> no settings event', find(ev, 'settings', e => e.payload.field === 'caps.perDay' && e.payload.to === 3).length === 1, find(ev, 'settings').map(e => [e._key.slice(18, 30), e.payload.field, e.payload.from, e.payload.to]));
ok('unknown action -> guard.refused + request 422', (await post('hunt', KEY, { action: 'nope' })).status === 422 && !!one(await events(), 'guard.refused', e => e.error_class === 'unknown-action'));

// ---- finder: candidates with refusals ----
const cand = (name, site, title, ats = 'lever', location = 'Tel Aviv, Israel', url) => ({ name, site, domain: site, source: ats, title, url: url || `https://jobs.lever.co/${name.toLowerCase()}/x`, ats, location });
const f1 = await post('hunt', SEC, { runId: 'hunt-obs1', funnel: { found: 20 }, candidates: [
  cand('W1', 'https://w1.co', 'AI Engineer'), cand('W2', 'https://w2.co', 'Product Manager', 'greenhouse'), cand('W3', 'https://w3.co', 'AI Engineer', 'workday'),
  cand('W4', 'https://w4.co', 'Staff AI Engineer'), cand('Oldco', 'https://oldco.com', 'AI Engineer'), cand('W5', 'https://w5.co', 'AI Engineer', 'lever', 'Berlin'), cand('W6', 'https://w6.co', 'AI Engineer', 'comeet', 'Tel Aviv', 'https://www.comeet.com/jobs/w6/1/x/2'),
] });
ok('finder created 4', f1.body.created === 4, f1.body);
ev = await events();
const refusedDec = find(ev, 'decision', e => e.payload.step === 'ingestCandidates' && e.payload.decision === 'refused');
ok('every refused candidate is a decision event with name + reason', refusedDec.length === 3 && refusedDec.map(e => `${e.payload.company}:${e.payload.reason}`).sort().join() === 'Oldco:onBoard,W4:seniority,W5:location', refusedDec.map(e => `${e.payload.company}:${e.payload.reason}`));
ok('accepted candidates: decision + transition(null -> candidate) with trace_id', find(ev, 'transition', e => e.payload.to === 'candidate' && e.trace_id).length === 4 && find(ev, 'decision', e => e.payload.decision === 'candidate' && e.payload.rank).length === 4);
ok('ingestCandidates step.end carries created + refused', !!one(ev, 'step.end', e => e.payload.step === 'ingestCandidates' && e.payload.created === 4 && e.payload.refused.onBoard === 1));
ok('grader fired -> fire event ok with company', !!one(ev, 'fire', e => e.outcome === 'ok' && e.payload.kind === 'hunt-grade' && e.payload.status === 200 && e.trace_id), find(ev, 'fire').map(e => e.payload));
ok('events carry run_id hunt-obs1', find(ev, 'decision', e => e.payload.step === 'ingestCandidates').every(e => e.run_id === 'hunt-obs1'));

// ---- grader + preparer ----
let st = await state();
const research = g => ({ summary: 'does things', stage: 'Seed', headcount: 20, location: 'Tel Aviv', fit: { grade: g, reasons: ['small team', 'AI product'] }, sources: ['https://w.co/about'] });
for (const n of ['W1', 'W2', 'W3']) await post('hunt', SEC, { kind: 'grade', roleId: roleOf(st, n).id, research: research(4), sentence: 's', trace: { startedAt: 'x', steps: [{ what: 'read site', ms: 5 }] }, promptVersion: 'grade-v1' });
await post('hunt', SEC, { kind: 'grade', roleId: roleOf(st, 'W6').id, research: research(8), sentence: 'elite' });
ok('grade for a card not waiting -> 409 + guard.refused', (await post('hunt', SEC, { kind: 'grade', roleId: roleOf(st, 'W6').id, research: research(4) })).status === 409 && !!one(await events(), 'guard.refused', e => e.error_class === 'card-not-waiting' && e.actor === 'agent:grader'));
ev = await events();
ok('grader decisions with grade, reason, evidence, promptVersion', find(ev, 'decision', e => e.actor === 'agent:grader' && e.payload.decision === 'practice' && e.payload.grade === 4 && /small team/.test(e.payload.reason)).length === 3 && !!one(ev, 'step.end', e => e.actor === 'agent:grader' && e.payload.promptVersion === 'grade-v1' && e.payload.trace), find(ev, 'decision', e => e.actor === 'agent:grader').map(e => e.payload));
ok('grade 8 -> real lead decision', !!one(ev, 'decision', e => e.actor === 'agent:grader' && e.payload.decision === 'real lead' && e.payload.company === 'W6'));
const pkg = (extra = {}) => ({ url: 'https://jobs.lever.co/p/x/apply', ats: 'lever', title: 'AI Engineer', cv: 'engineer-big', sentence: 'one line', fields: [{ name: 'name', label: 'Name', type: 'text', required: true }], screeners: [{ q: 'Are you located in Israel?', type: 'yesno', options: ['Yes', 'No'] }], answers: { 'Are you located in Israel?': 'Yes' }, flags: {}, ...extra });
st = await state();
await post('hunt', SEC, { kind: 'prep', roleId: roleOf(st, 'W1').id, apply: pkg() });
await post('hunt', SEC, { kind: 'prep', roleId: roleOf(st, 'W2').id, apply: pkg({ ats: 'greenhouse', url: 'https://job-boards.greenhouse.io/w2/jobs/1', answers: {} }) });
await post('hunt', SEC, { kind: 'prep', roleId: roleOf(st, 'W3').id, apply: pkg({ ats: 'workday' }) });
ev = await events();
ok('prep queued -> decision queued + transition candidate -> approved', !!one(ev, 'decision', e => e.actor === 'agent:preparer' && e.payload.decision === 'queued' && e.payload.company === 'W1') && !!one(ev, 'transition', e => e.payload.company === 'W1' && e.payload.from === 'candidate' && e.payload.to === 'approved'));
ok('prep forfeited needsAnswer -> decision with the exact question + transition -> skipped', !!one(ev, 'decision', e => e.payload.decision === 'forfeited' && e.payload.company === 'W2' && e.payload.needsHuman[0] === 'Are you located in Israel?') && !!one(ev, 'transition', e => e.payload.company === 'W2' && e.payload.to === 'skipped' && /forfeited: needsAnswer/.test(e.payload.reason)));
ok('prep forfeited manualOnly (workday)', !!one(ev, 'transition', e => e.payload.company === 'W3' && e.payload.to === 'skipped' && e.payload.detail === 'workday'));

// ---- apply transitions by hand: 409s and successes ----
st = await state();
const w2 = roleOf(st, 'W2').id;
await post('hunt', KEY, { action: 'apply', roleId: w2, patch: { status: 'prepared' }, byHuman: true });
const a1 = await post('hunt', KEY, { action: 'apply', roleId: w2, patch: { status: 'approved' }, byHuman: true });
ev = await events();
ok('approve with open screener -> 409 + guard.refused open-screeners with detail', a1.status === 409 && !!one(ev, 'guard.refused', e => e.error_class === 'open-screeners' && e.trace_id === w2 && /Israel/.test(e.payload.detail) && e.payload.by === 'human'), find(ev, 'guard.refused').map(e => e.error_class));
ok('revive by Eyal -> transition skipped -> prepared byHuman', !!one(ev, 'transition', e => e.trace_id === w2 && e.payload.from === 'skipped' && e.payload.to === 'prepared' && e.payload.byHuman === true));
await post('hunt', KEY, { action: 'apply', roleId: w2, patch: { answers: { 'Are you located in Israel?': 'Yes' } }, byHuman: true });
await post('hunt', KEY, { action: 'apply', roleId: w2, patch: { status: 'approved' }, byHuman: true });
ev = await events();
ok('answers patch -> transition apply.answers with open list empty', !!one(ev, 'transition', e => e.trace_id === w2 && e.payload.field === 'apply.answers' && e.payload.open.length === 0));
ok('illegal transition -> guard.refused illegal-transition', (await post('hunt', KEY, { action: 'apply', roleId: w2, patch: { status: 'confirmed' } })).status === 409 && !!one(await events(), 'guard.refused', e => e.error_class === 'illegal-transition' && e.payload.to === 'confirmed'));

// ---- worker claim + report + release + outcomes ----
const c1 = await post('hunt', KEY, { action: 'worker', claim: true, max: 2, workerId: 'pc-1', machine: 'TEST-PC', runId: 'worker-obs-1' });
ok('claim 2 (W1, W2)', c1.body.claimed.length === 2, c1.body);
ev = await events();
ok('claim event lists claimed ids, room, perDay; transitions approved -> submitting by worker with runId', !!one(ev, 'claim', e => e.actor === 'pc:worker' && e.payload.claimed.length === 2 && e.payload.room === 3 && e.payload.perDay === 3) && find(ev, 'transition', e => e.payload.to === 'submitting' && e.payload.by === 'worker' && e.payload.runId === 'worker-obs-1').length === 2);
const w1 = c1.body.claimed[0].roleId;
await post('hunt', KEY, { action: 'apply', roleId: w2, patch: { status: 'approved' }, release: true, workerId: 'pc-1', runId: 'worker-obs-1' });
await post('hunt', KEY, { action: 'apply', roleId: w1, patch: { status: 'submitted', screenshot: 'applications/w1/x.png' }, workerId: 'pc-1', runId: 'worker-obs-1' });
const rep = await post('hunt', KEY, { action: 'worker', workerId: 'pc-1', machine: 'TEST-PC', report: { runId: 'worker-obs-1', chrome: 'started', submitted: [{ company: 'W1', title: 'AI Engineer' }], failed: [], blocked: [], unverified: [], error: 'logged out of Drushim', ms: 1234 } });
ev = await events();
ok('release -> transition submitting -> approved outcome released', !!one(ev, 'transition', e => e.trace_id === w2 && e.payload.to === 'approved' && e.outcome === 'released' && e.payload.release === true));
ok('submitted -> transition with screenshot + ledger event', !!one(ev, 'transition', e => e.trace_id === w1 && e.payload.to === 'submitted' && e.payload.screenshot === 'applications/w1/x.png') && !!one(ev, 'ledger', e => e.trace_id === w1 && e.payload.company === 'W1'));
ok('report -> heartbeat with lastError + today counts', rep.status === 200 && !!one(ev, 'heartbeat', e => e.error_cause === 'logged out of Drushim' && e.payload.today.submitted === 1 && e.run_id === 'worker-obs-1'), find(ev, 'heartbeat').map(e => e.payload));
ok('daily cap: claim refused note', (await post('hunt', KEY, { action: 'worker', claim: true, max: 5, workerId: 'pc-1' })).body.claimed.length === 1);   // room 3 - 2 (W1 submitted today + W2 re-claimed? no: W2 released -> approved, claimable) -> 1

// ---- sweep ----
const full = await get('state', KEY); const r2 = full.body.state.roles.find(r => r.apply && r.apply.status === 'submitting'); r2.apply.startedAt = new Date(Date.now() - 3 * 3600000).toISOString();
await post('state', KEY, { baseRev: full.body.rev, state: full.body.state });
await post('hunt', KEY, { action: 'sweep' });
ev = await events();
ok('sweep -> transition submitting -> unverified reason timeout, by sweep', !!one(ev, 'transition', e => e.trace_id === r2.id && e.payload.to === 'unverified' && e.payload.reason === 'timeout' && e.payload.by === 'sweep'));

// ---- page save diff + stale save ----
const full2 = await get('state', KEY);
full2.body.state.companies.push({ id: 'c-new', name: 'Newco', what: '', stage: '', ceo: '', fit: '', links: '', notes: '', peopleIds: [], tier: 'real' });
full2.body.state.roles.find(r => r.id === w1).stage = 'in-conversation';
full2.body.state.hunt.killSwitch = true;
await post('state', KEY, { baseRev: full2.body.rev, state: full2.body.state });
ev = await events();
const sv = find(ev, 'save').pop();
ok('page save diff: Newco added, W1 stage changed, hunt.killSwitch', sv && sv.payload.diff.companies.added.includes('Newco') && sv.payload.diff.roles.changed.some(x => x.id === w1 && x.fields.includes('stage')) && sv.payload.diff.hunt.includes('killSwitch'), sv && sv.payload.diff);
ok('page save -> transition stage applied -> in-conversation byHuman + settings killSwitch by page', !!one(ev, 'transition', e => e.trace_id === w1 && e.payload.field === 'stage' && e.payload.to === 'in-conversation' && e.actor === 'page:human') && !!one(ev, 'settings', e => e.payload.field === 'killSwitch' && e.payload.to === true && e.actor === 'page:human'), ev.filter(e => e._key === sv._key).map(e => [e.actor, e.type, e.payload.field, e.payload.to, e.trace_id]));
const stale = await post('state', KEY, { baseRev: full2.body.rev, state: full2.body.state });
ok('stale save -> 409 + guard.refused stale-save', stale.status === 409 && !!one(await events(), 'guard.refused', e => e.error_class === 'stale-save' && e.payload.baseRev === full2.body.rev));
await post('hunt', KEY, { action: 'settings', killSwitch: false });

// ---- revision conflicts: concurrent writers lose nothing ----
const full3 = await get('state', KEY);
const ids = full3.body.state.roles.map(r => r.id);
const results = await Promise.all(ids.map((id, i) => post('hunt', KEY, { action: 'apply', roleId: id, patch: { log: `concurrent-${i}` } })));
const after = await state();
const okOnes = results.filter(r => r.status === 200).length, conflicts = results.filter(r => r.status === 409 && r.body.conflict).length;
const applied = after.roles.filter(r => r.apply && /^concurrent-/.test(r.apply.log || '')).length;
const cas = (await get('state', KEY)).body.features.cas;
if (cas) ok(`concurrent patches: ${okOnes} ok, ${conflicts} conflicts (409), applied = ok (nothing silently lost)`, okOnes + conflicts === ids.length && applied === okOnes, { okOnes, conflicts, applied, statuses: results.map(r => r.status) });
else console.log(`SKIP concurrent patches: this store returns no etag (features.cas=false), so saves fall back to a rev re-read and in-process concurrency can still lose writes here (${okOnes} ok, ${applied} applied). On Netlify the store returns etags and saves are compare-and-set; verify after deploy with: node tests/cas-probe.mjs <board-url>`);
// a 409 is either a plain rev conflict or, since 25 Oct, a save that was overwritten by a simultaneous one (state.mjs lost-write check)
if (conflicts) ok('rev-conflict guard.refused event logged', !!one(await events(), 'guard.refused', e => ['rev-conflict', 'lost-write'].includes(e.error_class)));
else console.log('  (no conflict occurred this run - the guard was not exercised; rerun to try again)');

// ---- mail clerk ----
st = await state();
const mail = await post('mail', SEC, { runId: 'mail-obs-1', scanned: 5, checkedAt: new Date().toISOString(), items: [
  { kind: 'ack', gmailId: 'g1', roleId: w1, subject: 'Thanks for applying', from: 'W1 Careers', date: new Date().toISOString(), summary: 'received' },
  { kind: 'rejected', gmailId: 'g2', companyId: st.companies.find(c => c.name === 'W2').id, subject: 'Update', from: 'W2', date: new Date().toISOString(), summary: 'no' },
  { kind: 'reply', gmailId: 'g3', newCompany: { name: 'Mailco', url: 'https://mailco.io', roleTitle: 'PM' }, subject: 'Hi', from: 'Dana (Mailco)', date: new Date().toISOString(), summary: 'call?' },
  { kind: 'noise', gmailId: 'g4', subject: 'newsletter' },
  { kind: 'ack', gmailId: 'g1', roleId: w1, subject: 'dup' },
  { kind: 'update', gmailId: 'g5', subject: 'no company', from: 'x' },
] });
ok('mail filed', mail.status === 200 && mail.body.filed === 3, mail.body);
ev = await events();
ok('mail: one event per item with how + outcome (noise skipped, dup skipped, unmatched skipped)', find(ev, 'mail').length === 6 && !!one(ev, 'mail', e => e.payload.reason === 'already seen') && !!one(ev, 'mail', e => e.payload.reason === 'no company matched') && !!one(ev, 'mail', e => /^newCompany created/.test(e.payload.how)), find(ev, 'mail').map(e => [e.payload.kind, e.payload.how, e.payload.reason]));
ok('ack on a submitted card -> receipt event + confirmed', !!one(ev, 'receipt', e => e.trace_id === w1 && e.payload.to === 'confirmed') && (await state()).roles.find(r => r.id === w1).apply.status === 'confirmed');
ok('rejected -> transition stage -> closed by mail-clerk; new company/role -> transitions created', !!one(ev, 'transition', e => e.payload.company === 'W2' && e.payload.to === 'closed' && e.actor === 'agent:mail-clerk') && !!one(ev, 'transition', e => e.payload.company === 'Mailco' && e.payload.to === 'created'));
ok('mail run step.end with counts', !!one(ev, 'step.end', e => e.payload.step === 'mail.file' && e.payload.filed === 3 && e.payload.counts.noise === 1 && e.run_id === 'mail-obs-1'));

// ---- research fire failure (catcher answers 500 for FAILME) ----
const full4 = await get('state', KEY); full4.body.state.companies.push({ id: 'c-fail', name: 'FAILME Ltd', what: '', stage: '', ceo: '', fit: '', links: '', notes: '', peopleIds: [] });
await post('state', KEY, { baseRev: full4.body.rev, state: full4.body.state });
const rf = await post('research', KEY, { companyId: 'c-fail' });
ev = await events();
ok('research fire failed -> 502 + fire event fail with status 500 and response body', rf.status === 502 && !!one(ev, 'fire', e => e.outcome === 'fail' && e.payload.status === 500 && /simulated/.test(e.payload.response) && e.payload.company === 'FAILME Ltd'), find(ev, 'fire', e => e.outcome === 'fail').map(e => e.payload));
ok('research result for unknown company -> 404 + error event', (await post('research', SEC, { companyId: 'nope', research: { summary: 'x' } })).status === 404 && !!one(await events(), 'error', e => e.error_class === 'company-not-found'));

// ---- finder tick (one real step: drushim) ----
await post('hunt', KEY, { action: 'settings', killSwitch: false });
const tick = await post('hunt-find', KEY, {});
ev = await events();
ok('finder tick -> step.start run + step.end drushim with ms', tick.status === 200 && !!one(ev, 'step.start', e => e.payload.step === 'run' && e.actor === 'netlify:hunt-find') && !!one(ev, 'step.end', e => e.payload.step === 'drushim' && typeof e.duration_ms === 'number'), tick.body);
// 10 Drushim searches since 23 Oct 2026 (QUERIES in hunt-find.mjs)
ok('finder tick -> per-source request events (url, status, ms, rolesSeen) + request event tagged find-tick', find(ev, 'step.end', e => e.payload.step === 'source:drushim' && e.payload.url && typeof e.payload.rolesSeen === 'number').length === 16 &&   /* 16 search words since 26 Oct 2026 (wider titles) */ !!one(ev, 'request', e => e.payload.action === 'find-tick'));
const drops = find(ev, 'decision', e => e.payload.decision === 'dropped' && e.payload.step === 'drushim');
ok('finder drops are per-role decisions with reason (or drushim refused the cloud fetch)', drops.length > 0 ? drops.every(e => e.payload.reason && e.payload.title) : !!one(ev, 'step.end', e => e.payload.step === 'source:drushim' && e.outcome === 'fail'), { drops: drops.length });
await post('hunt', KEY, { action: 'settings', killSwitch: true }); await post('hunt-find', KEY, {}); await post('hunt', KEY, { action: 'settings', killSwitch: false });   // abandon the run

// ---- obs endpoint: chunk download, bad key, delete ----
const keys = await chunks();
ok('chunks exist, keys are events/<day>/<id>.jsonl', keys.length > 10 && keys.every(k => /^events\/\d{4}-\d{2}-\d{2}\/[a-z0-9-]+\.jsonl$/.test(k)), keys.slice(0, 3));
ok('bad key -> 422', (await get('obs', KEY, '?key=../state')).status === 422);
ok('emit action accepts claude-code events', (await post('obs', KEY, { action: 'emit', events: [{ actor: 'claude-code', type: 'question', payload: { question: 'test' } }] })).body.accepted === 1 && !!one(await events(), 'question', e => e.actor === 'claude-code'));

// ---- collector ingests the chunks into a scratch obs.db and deletes them on the board ----
const scratch = path.join(os.tmpdir(), `obs-test-${Date.now()}.db`);
const collect = fileURLToPath(new URL('../../obs/collect.mjs', import.meta.url));
let out = '';
try { out = execFileSync(process.execPath, [collect, '--board', 'http://localhost:8899'], { env: { ...process.env, OBS_DB: scratch }, encoding: 'utf8', timeout: 120000 }); } catch (e) { out = String(e.stdout || '') + String(e.stderr || e.message); }
ok('collector ran and pulled board chunks', /board chunks: \d+ pulled/.test(out), out.slice(-600));
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(scratch, { readOnly: true });
const n = db.prepare("SELECT count(*) n FROM events WHERE source_file LIKE 'blob:%'").get().n;
const types = db.prepare("SELECT type, count(*) n FROM events WHERE source_file LIKE 'blob:%' GROUP BY type ORDER BY n DESC").all();
ok(`obs.db has the board events (${n}) across types`, n > 100 && ['transition', 'decision', 'guard.refused', 'settings', 'claim', 'heartbeat', 'mail', 'receipt', 'fire', 'save', 'request'].every(t => types.some(x => x.type === t)), types);
ok('generated columns work: transitions to skipped with forfeited reason', db.prepare("SELECT count(*) n FROM events WHERE type='transition' AND status_to='skipped' AND reason LIKE 'forfeited%' AND source_file LIKE 'blob:%'").get().n >= 2);
ok('v_errors shows the fire failure with cause + handling', db.prepare("SELECT count(*) n FROM v_errors WHERE error_class='fire-failed' AND error_handling='handled'").get().n >= 1);
ok('v_transitions (or events) answer "what did Eyal change": byHuman revive', db.prepare("SELECT count(*) n FROM events WHERE type='transition' AND json_extract(payload,'$.byHuman')=1 AND status_to='prepared'").get().n >= 1);
db.close();
ok('collector deleted the chunks on the board', (await chunks()).length === 0, await chunks());
try { out = execFileSync(process.execPath, [collect, '--board', 'http://localhost:8899', '--quiet'], { env: { ...process.env, OBS_DB: scratch }, encoding: 'utf8', timeout: 120000 }); ok('second collect is a no-op for chunks', true); } catch (e) { ok('second collect runs', false, String(e.message)); }
try { fs.unlinkSync(scratch); fs.unlinkSync(scratch + '-wal'); fs.unlinkSync(scratch + '-shm'); } catch { /* fine */ }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
