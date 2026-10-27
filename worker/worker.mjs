// PC worker, the hands-off submitter. A Windows scheduled task (JobApplyWorker) runs it at logon and every 15 minutes while Eyal is
// logged on. Each tick: lock -> replay the outbox -> recover interrupted cards -> claim the oldest queued cards from the board
// (the board moves them to 'submitting', atomically) -> start the runner Chrome if needed -> login checks -> per card: tailor the CV,
// fill, attach, screeners, required-field gate, submit, confirmation screenshot -> patch the board -> report -> close what it started.
//   node worker.mjs [--dry] [--max N] [--board <url>] [--local] [--fast] [--once]
// --dry    fill + attach + screenshot, never click Submit; the claimed cards are released back to the queue at the end
// --local  localhost:8899 instead of the live board (the worker defaults to LIVE, unlike run.mjs)
// --fast   no pacing pause between cards (tests)
// Hard rules: only cards the board hands out (practice tier, grade <= 6, no open screener, never-twice checked server-side); kill switch
// = no cards; CAPTCHA = blocked, never bypassed; an unknown outcome after the click = 'unverified', never retried; nothing is guessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { loadConfig, Board, slug, ROOT } from './lib/board.mjs';
import { Log, makeRunId, LOGS } from './lib/log.mjs';
import { attach } from './lib/browser.mjs';
import { recipeFor, recipeForUrl } from './recipes/index.mjs';
import { sleep, setFieldHook, setPageHook } from './lib/forms.mjs';
import { Obs, recipeHash } from './lib/obs.mjs';

const { cfg, profile, flags, board: base, key, max } = loadConfig(process.argv.slice(2), { defaultLive: true });
const runId = makeRunId('worker');
const log = new Log(runId);
const say = (m, card) => log.line(m, card);
const MACHINE = os.hostname();
const WORKER_ID = `${MACHINE}-${profile ? slug(profile.firstName || 'human') : 'x'}`.slice(0, 60);
const LOCK = path.join(LOGS, 'worker.lock');
const summary = { board: base, dry: !!flags.dry, chrome: 'none', submitted: [], blocked: [], failed: [], unverified: [], skipped: [], released: [], error: '', ms: 0 };
const t0 = Date.now();
const obs = new Obs(runId, { machine: MACHINE, dry: !!flags.dry });
obs.emit({ type: 'run', outcome: 'started', entity_type: 'worker', entity_id: runId, payload: { board: base, max, worker: WORKER_ID, node: process.version, argv: process.argv.slice(2) }, seq: 'tick.start' });

// ---- single instance ----
function takeLock() {
  try {
    if (fs.existsSync(LOCK)) {
      const l = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
      let alive = false; try { process.kill(l.pid, 0); alive = true; } catch { alive = false; }
      const age = Date.now() - Date.parse(l.at || 0);
      if (alive && age < 45 * 60000) { obs.emit({ type: 'log', outcome: 'skipped', payload: { step: 'lock', message: `another worker is running (pid ${l.pid}, ${Math.round(age / 60000)} min)` } }); return false; }
      say(`stale lock (pid ${l.pid}, ${Math.round(age / 60000)} min) taken over`);
      obs.emit({ type: 'log', severity: 'warn', payload: { step: 'lock', message: `stale lock taken over (pid ${l.pid}, ${Math.round(age / 60000)} min)` } });
    }
  } catch { /* unreadable lock: take over */ }
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), runId }));
  return true;
}
const releaseLock = () => { try { const l = JSON.parse(fs.readFileSync(LOCK, 'utf8')); if (l.pid === process.pid) fs.rmSync(LOCK, { force: true }); } catch { /* ignore */ } };

let browser = null, board = null, claimed = [], disconnected = false;
let disconnectedByUs = false;
// claim ledger: logs/claims/<runId>.json records how far each claimed card got (claimed -> touched -> clicked -> done), so a tick that
// dies (closed browser, killed process) can be recovered precisely by the next tick: untouched/touched cards go back to the queue,
// clicked cards become unverified unless the local proof exists.
const CLAIMS = path.join(LOGS, 'claims'); fs.mkdirSync(CLAIMS, { recursive: true });
const ledgerFile = id => path.join(CLAIMS, `${id}.json`);
const ledgerWrite = () => { try { fs.writeFileSync(ledgerFile(runId), JSON.stringify({ runId, at: new Date().toISOString(), cards: claimed.map(c => ({ roleId: c.roleId, company: c.company, state: c._state || 'claimed' })) }, null, 1)); } catch { /* ignore */ } };
const mark = (c, state) => { c._state = state; ledgerWrite(); };
const ledgerLookup = (roleId, rid) => { try { const l = JSON.parse(fs.readFileSync(ledgerFile(rid), 'utf8')); const e = l.cards.find(x => x.roleId === roleId); return e ? e.state : ''; } catch { return ''; } };
// Reviewer heartbeat (22 Oct 2026): relay what the scheduled reviewer left behind (reviewer/state.json, logs/reviewer.out, reviewer/digest.md)
// so the board's System block can show a Reviewer light. Never throws; missing files -> nulls.
const reviewerBeat = () => {
  const out = { lastRunAt: null, startedAt: null, open: null, proven: null, digest: null, lastExit: null };
  try { const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'reviewer', 'state.json'), 'utf8')); out.lastRunAt = s.lastRunAt || null; out.startedAt = s.startedAt || null; out.open = Array.isArray(s.open) ? s.open.length : null; out.proven = Array.isArray(s.proven) ? s.proven.length : null; } catch { /* no state yet */ }
  try { const lines = fs.readFileSync(path.join(ROOT, 'logs', 'reviewer.out'), 'utf8').trim().split(/\r?\n/).reverse(); const m = (lines.find(l => /^exit \d+ at/.test(l)) || '').match(/^exit (\d+)/); out.lastExit = m ? Number(m[1]) : null; } catch { /* no runs yet */ }
  try { out.digest = (fs.readFileSync(path.join(ROOT, 'reviewer', 'digest.md'), 'utf8').split(/\r?\n/).find(l => /^#\s/.test(l)) || '').replace(/^#\s*/, '').slice(0, 160) || null; } catch { /* no digest yet */ }
  return out;
};
// Alerts (25 Oct 2026): relay the open alerts alerts.mjs found last tick (red "Needs you" banner on the board), then start the next check
// detached so the tick never waits on it (it may email Eyal through headless Claude Code). Never throws.
const creditsBeat = () => { try { const c = JSON.parse(fs.readFileSync(path.join(LOGS, 'credits.json'), 'utf8')); return { at: c.at, used: c.used, projected: c.projected, budget: c.budget, resetAt: c.resetAt, deploysLeft: c.deploysLeft, nextDeployAllowedAt: c.nextDeployAllowedAt, lastBoardDeploy: c.lastBoardDeploy }; } catch { return null; } };   // reviewer/credits.mjs, for the board's Credits line
const openAlerts = () => { try { const a = JSON.parse(fs.readFileSync(path.join(LOGS, 'alerts.json'), 'utf8')); return Array.isArray(a.alerts) ? a.alerts.slice(0, 10) : []; } catch { return []; } };
const startAlerts = () => { if (flags.dry || flags.local) return; try { const out = fs.openSync(path.join(LOGS, 'alerts.out'), 'a'); spawn(process.execPath, [path.join(ROOT, 'alerts.mjs')], { cwd: ROOT, detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref(); } catch (e) { say(`alerts check not started: ${e.message}`); } };
// LinkedIn feed (supply widening item 5, 26 Oct 2026): started detached like the alerts check; it exits at once unless a hunt window is near
// and has no feed yet, so the tick never waits on its paced searches. Off with config.json linkedinFeed: false.
const startLinkedinFeed = () => { if (flags.dry || flags.local) return; try { const out = fs.openSync(path.join(LOGS, 'linkedin-feed.out'), 'a'); spawn(process.execPath, [path.join(ROOT, 'linkedin-feed.mjs')], { cwd: ROOT, detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref(); } catch (e) { say(`linkedin feed not started: ${e.message}`); } };
const finish = async (code = 0) => {
  summary.ms = Date.now() - t0;
  obs.emit({ type: 'run', outcome: summary.error ? 'fail' : 'ok', entity_type: 'worker', entity_id: runId, duration_ms: summary.ms, error_class: summary.error ? 'tick-error' : null, error_cause: summary.error || null, error_handling: summary.error ? 'handled' : null, payload: { board: base, chrome: summary.chrome, submitted: summary.submitted.length, failed: summary.failed.length, blocked: summary.blocked.length, unverified: summary.unverified.length, released: summary.released.length, skipped: summary.skipped.length, error: summary.error || null, claimed: claimed.length, lists: { submitted: summary.submitted, failed: summary.failed, blocked: summary.blocked, unverified: summary.unverified, released: summary.released } }, seq: 'tick.end' });
  if (board) { try { await board.report({ workerId: WORKER_ID, machine: MACHINE, report: { runId, chrome: summary.chrome, submitted: summary.submitted, failed: summary.failed, blocked: summary.blocked, unverified: summary.unverified, skipped: summary.skipped, error: summary.error, ms: summary.ms, reviewer: reviewerBeat(), alerts: openAlerts(), credits: creditsBeat() } }); say('reported to the board'); } catch (e) { say(`report failed: ${e.message}`); } }
  startAlerts();
  startLinkedinFeed();
  if (browser) { disconnectedByUs = true; try { await browser.close(); } catch { /* ignore */ } }
  log.finish(summary); console.log('\nSUMMARY ' + JSON.stringify(summary));
  releaseLock();
  process.exit(code);
};
// release the cards this tick claimed but never touched (environment problem): back to the queue
const releaseUntouched = async (why) => {
  for (const c of claimed.filter(c => !c._touched)) {
    const r = await board.patchRetry(c.roleId, { status: 'approved' }, { release: true, workerId: WORKER_ID }, { log: m => say(m, c._tag) });
    say(`released back to the queue (${why}): ${r.refused ? 'refused - ' + r.error : 'ok'}`, c._tag);
    summary.released.push({ company: c.company, why });
    obs.emit({ type: 'transition', trace_id: c.roleId, entity_type: 'role', entity_id: c.roleId, outcome: 'released', payload: { company: c.company, from: 'submitting', to: 'approved', field: 'apply.status', reason: `released: ${why}`, boardPatch: r.refused ? 'refused' : 'ok' } });
  }
};
const fail = async (m, code = 2) => { say('STOP ' + m); summary.error = m; try { if (board) await releaseUntouched(m); } catch { /* ignore */ } await finish(code); };
process.on('uncaughtException', e => { say(`CRASH ${e && e.stack || e}`); summary.error = `crash: ${e && e.message}`; finish(3); });
process.on('unhandledRejection', e => { say(`CRASH ${e && e.stack || e}`); summary.error = `crash: ${e && e.message}`; finish(3); });

if (!takeLock()) { console.log('another worker is running - exit'); process.exit(0); }
if (!profile) await fail('config.local.json is missing (firstName, lastName, email, phone, linkedin)');
say(`${runId} board=${base} dry=${!!flags.dry} max=${max} worker=${WORKER_ID}`);
board = new Board(base, key);

// ---- collector: pull the board's event chunks + snapshot into obs.db at the start of every tick (MONITORING-PLAN §3); never blocks the tick ----
if (!flags.dry || flags.collect) await new Promise(res => {
  const t = Date.now(); const script = path.resolve(ROOT, '..', 'obs', 'collect.mjs');
  execFile(process.execPath, [script, '--quiet', '--board', base], { timeout: 90000, windowsHide: true }, (err, out, errOut) => {
    if (err) { say(`collect: ${String(err.message).split('\n')[0].slice(0, 160)}`); obs.emit({ type: 'log', severity: 'warn', payload: { step: 'collect', message: `collector failed: ${String(err.message).slice(0, 300)}`, stderr: String(errOut || '').slice(0, 300), ms: Date.now() - t } }); }
    else obs.emit({ type: 'log', payload: { step: 'collect', message: 'collector ran at tick start', ms: Date.now() - t } });
    res();
  });
});

// ---- outbox + recovery ----
try { const o = await board.replayOutbox(m => say(m)); if (o.replayed || o.kept) { say(`outbox: replayed ${o.replayed}, kept ${o.kept}`); obs.emit({ type: 'log', payload: { step: 'outbox', message: `replayed ${o.replayed}, kept ${o.kept}` } }); } } catch (e) { say(`outbox replay failed: ${e.message}`); obs.error(e, { step: 'outbox', handling: 'retried' }); }
try { const o = await board.replayRecords(m => say(m)); if (o.replayed || o.kept) say(`records outbox: replayed ${o.replayed}, kept ${o.kept}`); } catch (e) { say(`records replay failed: ${e.message}`); }
let st;
try { st = await board.state(); } catch (e) { await fail(`board unreachable: ${e.message}`); }
const companyOf = r => st.companies.find(c => c.id === r.companyId);
// evidence folder per company: a Hebrew-only name slugs to 'company' (two Drushim cards in one tick overwrote each other on 23 Oct 2026), so fall back to the domain, then the role id
const folderOf = (name, domain, roleId) => { const s = slug(name); if (s !== 'company') return s; const d = slug(String(domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '')); return d && d !== 'company' ? d : `company-${roleId || 'x'}`; };
const rel = p => path.relative(path.dirname(cfg.applicationsDir), p).replace(/\\/g, '/');
for (const r of st.roles.filter(r => r.apply && r.apply.status === 'submitting' && r.apply.workerId === WORKER_ID)) {
  const age = Date.now() - Date.parse(r.apply.startedAt || 0);
  if (age < 10 * 60000) continue;   // another tick of this worker may still be on it
  const co = companyOf(r); const dir = path.join(cfg.applicationsDir, folderOf(co ? co.name : 'company', co && (co.domain || co.website || co.site), r.id));
  const proof = r.apply.runId && fs.existsSync(path.join(dir, `${r.apply.runId}-confirmed.png`)) ? path.join(dir, `${r.apply.runId}-confirmed.png`) : '';
  const state = r.apply.runId ? ledgerLookup(r.id, r.apply.runId) : '';
  obs.emit({ type: 'transition', trace_id: r.id, entity_type: 'role', entity_id: r.id, payload: { company: co && co.name, from: 'submitting', to: proof ? 'submitted' : (state === 'claimed' || state === 'touched') ? 'approved' : 'unverified', field: 'apply.status', reason: `recovery: ledger ${state || 'none'}, proof ${proof ? 'yes' : 'no'}`, interruptedRun: r.apply.runId } });
  if (proof) { await board.patchRetry(r.id, { status: 'submitted', screenshot: rel(proof), reason: 'recovered from the local proof' }, {}, { log: say }); say(`recovered ${co && co.name}: local proof found -> submitted`); }
  else if (state === 'claimed' || state === 'touched') { const rr = await board.patchRetry(r.id, { status: 'approved' }, { release: true, workerId: WORKER_ID }, { log: say }); say(`recovered ${co && co.name}: ledger says ${state}, nothing was sent -> back to the queue (${rr.refused ? 'refused: ' + rr.error : 'ok'})`); summary.released.push({ company: co && co.name, why: `recovered (${state})` }); }
  else { await board.patchRetry(r.id, { status: 'unverified', reason: state === 'clicked' ? 'worker interrupted after the submit click' : 'worker interrupted, no ledger entry' }, {}, { log: say }); say(`recovered ${co && co.name}: ${state || 'no ledger'} and no proof -> unverified`); summary.unverified.push({ company: co && co.name, why: 'worker interrupted' }); }
}

// ---- claim ----
let claimRes;
try { claimRes = await board.claim({ max, workerId: WORKER_ID, machine: MACHINE, runId }); } catch (e) { await fail(`claim failed: ${e.message}`); }
claimed = claimRes.claimed || [];
if (claimRes.note) say(`board: ${claimRes.note}`);
if ((claimRes.refused || []).length) say(`board refused ${claimRes.refused.length}: ${claimRes.refused.map(x => `${x.company} (${x.why})`).join(', ')}`);
say(`claimed ${claimed.length} card(s), room today ${claimRes.room}`);
obs.emit({ type: 'claim', outcome: claimed.length ? 'ok' : 'skipped', entity_type: 'worker', entity_id: runId, payload: { claimed: claimed.map(c => ({ roleId: c.roleId, company: c.company, title: c.title, ats: c.apply && c.apply.ats, grade: c.grade })), refused: claimRes.refused || [], room: claimRes.room, note: claimRes.note || null, perDay: claimRes.perDay, killSwitch: claimRes.killSwitch } });
// ---- form finder (LinkedIn-only cards): at most 2 per tick, one attempt per card, before the claimed cards are worked ----
try {
  const { runFinder } = await import('./find-form.mjs');
  const fr = await runFinder({ board, ctxFactory: () => attach({ log: m => say(m), offscreen: !flags.local, keepOpen: true }), max: 2, dry: !!flags.dry, workerId: WORKER_ID, log: m => say(m) });
  if (fr.tried) { summary.finder = fr; obs.emit({ type: 'log', entity_type: 'worker', entity_id: runId, payload: { step: 'find-form', message: `finder tried ${fr.tried}, found ${fr.found}` } }); }
} catch (e) { say(`finder error (ignored): ${e.message}`); obs.emit({ type: 'error', severity: 'warn', entity_type: 'worker', entity_id: runId, error_class: 'finder', error_cause: String(e.message).slice(0, 200), error_handling: 'ignored', payload: { step: 'find-form' } }); }
if (!claimed.length) { say('nothing to do'); await finish(0); }
for (const c of claimed) c._tag = `${folderOf(c.company, c.domain, c.roleId)}/${c.roleId}`;
ledgerWrite();

// ---- browser + logins ----
{ const end = obs.step('chrome');
  try { browser = await attach({ log: say, offscreen: !flags.local, keepOpen: true /* Chrome stays up between ticks, logins survive: lib/browser.mjs */ }); summary.chrome = browser.startedByMe ? 'started' : 'attached'; let ver = ''; try { ver = browser.browser.version(); } catch { /* ignore */ } end('ok', { chrome: summary.chrome, pid: browser.pid || null, version: ver }); }
  catch (e) { end('fail', { error: e.message }); obs.error(e, { step: 'chrome', handling: 'released' }); await fail(`browser: ${e.message}`); } }
const ctx = browser.ctx;
try { browser.browser.on('disconnected', () => { disconnected = true; say(disconnectedByUs ? 'detached from Chrome (left running)' : 'browser disconnected (window closed?)'); }); } catch { /* ignore */ }
{
  const p = await ctx.newPage();
  try {
    await p.goto('https://mail.google.com/mail/u/0/', { waitUntil: 'domcontentloaded', timeout: 30000 }); await sleep(2500);
    const loggedIn = !/accounts\.google\.com|\/signin|ServiceLogin|workspace\.google\.com/.test(p.url());
    say(`google: ${loggedIn ? 'logged in' : 'NOT logged in'}`);
    obs.emit({ type: 'heartbeat', outcome: loggedIn ? 'ok' : 'fail', payload: { step: 'login', site: 'google', loggedIn } });
    if (!loggedIn && !flags.dry) { await p.close(); await fail('runner Chrome is logged out of Google - open start-chrome.cmd and sign in once'); }
  } catch (e) { say(`google check skipped: ${e.message}`); }
  await p.close().catch(() => {});
}
const siteLogin = {};   // recipe name -> true/false, checked once per tick
async function siteLoggedIn(recipe) {
  if (!recipe.loggedIn) return true;
  if (siteLogin[recipe.name] !== undefined) return siteLogin[recipe.name];
  const p = await ctx.newPage();
  try { siteLogin[recipe.name] = await recipe.loggedIn(p); } catch (e) { say(`${recipe.name} login check failed: ${e.message}`); siteLogin[recipe.name] = false; }
  await p.close().catch(() => {});
  say(`${recipe.name}: ${siteLogin[recipe.name] ? 'logged in' : 'NOT logged in'}`);
  obs.emit({ type: 'heartbeat', outcome: siteLogin[recipe.name] ? 'ok' : 'fail', payload: { step: 'login', site: recipe.name, loggedIn: siteLogin[recipe.name] } });
  return siteLogin[recipe.name];
}

// ---- CV tailoring (cv.js, headless Edge) ----
const cvSlug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
function runCv(args) {
  return new Promise(resolve => execFile(process.execPath, [path.join(path.dirname(cfg.cvsDir), 'cv.js'), ...args], { cwd: path.dirname(cfg.cvsDir), timeout: 90000, windowsHide: true }, (err, stdout, stderr) => resolve({ err, out: String(stdout || '') + String(stderr || '') })));
}
async function tailorCv(card) {
  const version = card.apply.cv; const title = card.apply.title || card.title || '';
  let company = cvSlug(card.company) ? card.company : (card.domain || slug(card.company));   // a Hebrew-only name gets its domain as the folder name
  const attempt = async t => { const r = await runCv(['tailor', version, company, ...(t ? [t] : [])]); const pages = parseInt((r.out.match(/(\d+) page\(s\)/) || [])[1] || '0', 10); return { ...r, pages }; };
  let r = await attempt(title);
  if (r.err || !r.pages) throw Object.assign(new Error(`cv.js failed: ${(r.out || r.err && r.err.message || '').trim().slice(0, 200)}`), { kind: 'cv' });
  if (r.pages > 1 && title.length > 40) { say(`CV over one page with the full title, retrying with a shorter one`, card._tag); r = await attempt(title.slice(0, 40).trim()); }
  if (r.pages > 1) throw Object.assign(new Error('CV is over one page with this title'), { kind: 'cv' });
  const pdf = path.join(cfg.cvsDir, cvSlug(company), 'CV.pdf');
  if (!fs.existsSync(pdf)) throw Object.assign(new Error(`cv.js reported success but ${pdf} is missing`), { kind: 'cv' });
  return pdf;
}

// ---- per card ----
const shotDir = (name, domain, roleId) => { const d = path.join(cfg.applicationsDir, folderOf(name, domain, roleId)); fs.mkdirSync(d, { recursive: true }); return d; };
const perAts = {};
let i = 0;
for (const c of claimed) {
  const tag = c._tag; const card = { id: c.roleId, title: c.title, apply: c.apply, company: c.company, domain: c.domain, _tag: tag };
  if (i++ > 0 && !flags.fast) { const pause = 60000 + Math.floor(Math.random() * 60000); say(`pausing ${Math.round(pause / 1000)}s before the next card`); obs.emit({ type: 'log', payload: { step: 'pause', message: `pausing ${Math.round(pause / 1000)}s`, ms: pause } }); await sleep(pause); }
  if (disconnected) { await fail('the browser was closed mid-tick - untouched cards go back to the queue'); }
  let page, shot = '', clicked = false, recipeCleanup = null, endCard = null, stopCapture = null, tracing = false, stepEnd = null;
  const fieldSources = {}; obs.lastFields = null; let cvEv = null; const shots = [];
  // the application record for the board (record.mjs): what was on the form, the CV, the outcome. Never throws, never blocks.
  const sendRecord = async (outcome, extra = {}) => { try {
    const fields = (obs.lastFields || []).filter(f => !f.error && (f.visible || f.type === 'file') && f.type !== 'hidden' && (f.label || f.final)).map(f => ({ label: f.label || f.name || f.id, final: f.final || '', required: !!f.required, source: f.source, page: f.page, type: f.type }));
    await board.record({ roleId: c.roleId, runId, at: new Date().toISOString(), company: c.company, title: card.title, url: card.apply.url, ats: recipe && recipe.name, outcome, clicked, cv: { version: card.apply.cv, title: card.apply.title || card.title, sha256: cvEv && cvEv.sha256, file: cvEv && rel(cvEv.copy) }, fields, screenshots: shots, ...extra }, { log: m => say(m, tag) });
  } catch (e) { say(`record not sent: ${e.message}`, tag); } };
  setFieldHook(rec => { for (const k of [rec.field, rec.label, rec.selector]) if (k) fieldSources[k] = rec.source; obs.field(c.roleId, { ...rec, company: c.company }); });
  setPageHook(s => obs.formSnapshot(s, c.roleId, { company: c.company, sources: fieldSources, partial: true }));
  const timed = async (name, fn) => { stepEnd = obs.step(name, { trace_id: c.roleId, payload: { company: c.company } }); try { const r = await fn(); stepEnd('ok'); stepEnd = null; return r; } catch (e) { stepEnd('fail', { error: String(e.message).slice(0, 200) }); stepEnd = null; throw e; } };
  const patch = async (p, extra = {}) => { const r = await board.patchRetry(c.roleId, { ...p, log: log.cardLog(tag), runId }, extra, { log: m => say(m, tag) }); if (r.refused) say(`board refused the patch: ${r.error}`, tag); return r; };
  let formScope = null;   // the frame holding the form: proof screenshots capture the form itself when they can, the full page otherwise
  const screenshot = async name => {
    try {
      const f = path.join(shotDir(c.company, c.domain, c.roleId), `${runId}-${name}.png`);
      let done = false;
      if (formScope) { try { const form = formScope.locator('form').first(); if (await form.count() && await form.isVisible()) { await form.screenshot({ path: f, timeout: 8000 }); done = true; } } catch { /* fall back */ } }
      if (!done) await page.screenshot({ path: f, fullPage: true });
      shot = rel(f); shots.push(shot); say(`screenshot ${shot}`, tag); return f;
    } catch (e) { say(`screenshot failed: ${e.message}`, tag); return ''; }
  };
  let recipe = null;   // hoisted: the catch block reports recipe.name (was a ReferenceError on the release path, 20 Oct)
  try {
    recipe = recipeFor(card);
    if (!recipe) throw Object.assign(new Error(`no recipe for ${card.apply.ats} / ${card.apply.url}`), { kind: 'no-recipe' });
    perAts[recipe.name] = (perAts[recipe.name] || 0) + 1;
    recipeCleanup = recipe.cleanup || null;
    if (perAts[recipe.name] > 3) { obs.emit({ type: 'log', trace_id: c.roleId, outcome: 'released', payload: { step: 'cap', company: c.company, message: `per-ATS cap: more than 3 ${recipe.name} cards in one tick` } }); throw Object.assign(new Error(`more than 3 ${recipe.name} cards in one tick - left for the next tick`), { kind: 'release' }); }
    if (!(await siteLoggedIn(recipe))) { summary.error = `runner Chrome is logged out of ${recipe.name} - open start-chrome.cmd and sign in once`; throw Object.assign(new Error(summary.error), { kind: 'release' }); }
    c._touched = true; mark(c, 'touched');
    say(`start ${c.company} - ${card.title} (${recipe.name}, grade ${c.grade ?? '?'})`, tag);
    endCard = obs.step('card', { trace_id: c.roleId, payload: { company: c.company, title: card.title, ats: recipe.name, grade: c.grade, url: card.apply.url, cv: card.apply.cv, recipe: recipeHash(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'recipes', `${recipe.name}.mjs`)) } });
    const pdf = await timed('cv', () => tailorCv(card)); say(`cv ${card.apply.cv} -> ${pdf}`, tag);
    cvEv = obs.cvEvidence(c.roleId, pdf, { company: c.company, version: card.apply.cv, title: card.apply.title || card.title });
    await patch({ pdf });
    page = await ctx.newPage(); page.setDefaultTimeout(8000);
    tracing = await obs.traceStart(ctx);
    let dialog = '';
    page.on('dialog', d => { dialog = `${d.type()}: ${d.message()}`.slice(0, 200); d.dismiss().catch(() => {}); });
    const work = (async () => {
      let scope;
      try { scope = await recipe.open(page, card, m => say(m, tag), { dry: !!flags.dry, pdf }); }
      catch (e) {
        if (e.kind === 'dry') { say(`DRY RUN - ${e.message}`, tag); return { dry: true }; }   // recipes whose first click can send stop before it
        if (e.kind === 'submitted-on-open') {   // the site sent on the first click (AllJobs with a stored CV): it IS sent, record it as such
          clicked = true; mark(c, 'clicked'); say(`SENT ON CLICK: ${e.message}`, tag);
          const f = await screenshot('confirmed');
          if (f) fs.writeFileSync(f.replace(/\.png$/, '.txt'), `${new Date().toISOString()}
${c.company} - ${card.title}
${card.apply.url}

${e.text || e.message}
(sent on click with the CV stored on the profile, not the tailored one)
`);
          return { submitted: true, text: e.text || e.message, onOpen: true };
        }
        if (e.kind === 'external' && e.href) {   // Drushim handed off to the company's site: use that recipe if we have one
          let r2 = recipeForUrl(e.href), href = e.href;
          if (!r2) {   // a tracking redirect (stats.the-network.com, ...) hides the real ATS: follow it once in the browser, then look again
            await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}); await sleep(2000);
            const landed = page.url(); if (landed && landed !== href) { say(`external apply redirects to ${landed}`, tag); href = landed; r2 = recipeForUrl(landed); }
          }
          if (!r2) throw Object.assign(new Error(`external apply with no recipe: ${href}`), { kind: 'no-recipe' });
          e.href = href;
          say(`external apply -> ${r2.name} ${e.href}`, tag); recipe = r2; card.apply = { ...card.apply, url: e.href, ats: r2.name }; scope = await recipe.open(page, card);
        } else throw e;
      }
      formScope = scope;
      const b0 = await recipe.blocked(page); if (b0) throw Object.assign(new Error(`blocked on open: ${b0}`), { kind: 'blocked', reason: b0 });
      await timed('fill', () => recipe.fill(scope, card, profile, m => say(m, tag)));
      const how = await timed('attach', () => recipe.attachCv(scope, page, pdf, m => say(m, tag))); say(`cv attached via ${how}`, tag);
      obs.emit({ type: 'log', trace_id: c.roleId, payload: { step: 'attach', company: c.company, message: `cv attached via ${how}`, how } });
      await timed('screeners', () => recipe.screeners(scope, card, m => say(m, tag)));
      if (recipe.gate) await timed('gate', () => recipe.gate(scope, m => say(m, tag)));
      await sleep(1500);
      await obs.formSnapshot(scope, c.roleId, { company: c.company, sources: fieldSources });
      await screenshot('filled');
      if (dialog) throw Object.assign(new Error(`dialog: ${dialog}`), { kind: 'dialog' });
      if (flags.dry) { say('DRY RUN - not submitting', tag); return { dry: true }; }
      clicked = true; mark(c, 'clicked');
      stopCapture = obs.armSubmitCapture(page, c.roleId, { company: c.company });
      obs.emit({ type: 'submit.attempt', trace_id: c.roleId, entity_type: 'role', entity_id: c.roleId, outcome: 'clicked', payload: { company: c.company, ats: recipe.name, url: card.apply.url } });
      try { await timed('submit', () => recipe.submit(scope, page)); }
      catch (e) {
        // Playwright throws from click() only when the click was NOT dispatched (covered by an overlay, hidden, detached, still disabled). Such a
        // card was never sent, so it goes back to 'failed' (re-queueable), not 'unverified'. Seen 21 Oct 2026 04:00 (Vandelay): Drushim's
        // "CV limit reached" box sat over the submit button, the click timed out and the card was wrongly parked as unverified.
        if (/locator\.click|intercepts pointer events|element is not (visible|enabled|attached)|waiting for (locator|element)/i.test(e.message || '')) {
          clicked = false; mark(c, 'claimed');
          throw Object.assign(new Error(`submit click never landed, nothing sent: ${String(e.message).split('\n')[0].slice(0, 120)}`), { kind: 'changed-form' });
        }
        throw e;
      }
      say('submit clicked', tag);
      const res = await timed('confirm', () => recipe.confirmed(page, scope, recipe.confirmMs || cfg.confirmMs || 30000));
      if (res.ok) {
        const f = await screenshot('confirmed');
        if (f) fs.writeFileSync(f.replace(/\.png$/, '.txt'), `${new Date().toISOString()}\n${c.company} - ${card.title}\n${card.apply.url}\n\n${res.text}\n`);
        return { submitted: true, text: res.text };
      }
      const why = await recipe.blocked(page);
      if (why) throw Object.assign(new Error(`blocked after submit: ${why}`), { kind: 'blocked', reason: why });
      throw Object.assign(new Error('no confirmation within the time limit'), { kind: 'timeout' });
    })();
    const out = await Promise.race([work, sleep(cfg.perCardMs || 240000).then(() => { throw Object.assign(new Error('card time limit'), { kind: 'timeout' }); })]);
    if (stopCapture) { await stopCapture({ clicked }); stopCapture = null; }
    if (out.dry) { summary.skipped.push({ company: c.company, why: 'dry run' }); c._touched = false; obs.emit({ type: 'submit.attempt', trace_id: c.roleId, entity_type: 'role', entity_id: c.roleId, outcome: 'skipped', payload: { company: c.company, ats: recipe.name, dry: true, reason: 'dry run' } }); }
    else { say(`CONFIRMED: ${out.text.slice(0, 120)}`, tag); const pr = await patch({ status: 'submitted', screenshot: shot }); mark(c, 'done'); summary.submitted.push({ company: c.company, title: card.title, screenshot: shot }); await sendRecord('submitted', { confirmText: out.text });
      obs.emit({ type: 'submit.attempt', trace_id: c.roleId, entity_type: 'role', entity_id: c.roleId, outcome: 'ok', payload: { company: c.company, ats: recipe.name, text: out.text, onOpen: !!out.onOpen, screenshot: shot, boardPatch: pr && pr.refused ? 'refused' : pr && pr.parked ? 'parked' : 'ok' } }); }
    if (endCard) { endCard('ok', { outcome: out.dry ? 'dry' : 'submitted' }); endCard = null; }
    if (dialog) say(`dialog seen during the run: ${dialog}`, tag);
  } catch (e) {
    const kind = e.kind || 'form-error';
    say(`${kind.toUpperCase()}: ${e.message}`, tag);
    if (stopCapture) { try { await stopCapture({ clicked }); } catch { /* ignore */ } stopCapture = null; }
    const handling = flags.dry ? 'handled' : kind === 'release' ? 'released' : clicked ? 'unverified' : kind === 'blocked' ? 'forfeited' : 'forfeited';
    obs.error(e, { trace_id: c.roleId, step: stepEnd ? 'step' : (clicked ? 'after-click' : 'before-click'), handling, payload: { company: c.company, ats: recipe && recipe.name, clicked, kind } });
    if (endCard) { endCard('fail', { outcome: kind, clicked }); endCard = null; }
    if (page) await screenshot(kind === 'blocked' ? 'blocked' : 'failed');
    if (flags.dry) { summary.failed.push({ company: c.company, why: `(dry) ${e.message}` }); c._touched = false; }
    else if (kind === 'release' || (disconnected && !clicked)) { c._touched = false; mark(c, 'claimed'); if (e.loggedOut) { summary.error = e.message; const rn = (recipeCleanup && recipeCleanup.name) || ''; for (const k of Object.keys(siteLogin)) if (e.message.includes(k)) siteLogin[k] = false; } }   // released at the end, untouched (browser gone / logged out = nothing was sent)
    else if (clicked) { await patch({ status: 'unverified', reason: `after the click: ${e.message}`.slice(0, 160), screenshot: shot }); summary.unverified.push({ company: c.company, why: e.message }); }
    else if (kind === 'blocked') { await patch({ status: 'blocked', reason: e.reason || 'blocked', screenshot: shot }); summary.blocked.push({ company: c.company, reason: e.reason, screenshot: shot }); }
    else { const reason = kind === 'needs-human' ? 'needs-human' : kind === 'changed-form' ? 'changed-form' : kind === 'upload' ? 'upload' : kind; await patch({ status: 'failed', reason: `${reason}: ${e.message}`.slice(0, 160), screenshot: shot }); mark(c, 'done'); summary.failed.push({ company: c.company, why: e.message, screenshot: shot }); }
    if (kind === 'blocked' && !flags.dry) mark(c, 'done');
    if (!flags.dry && kind !== 'release' && !(disconnected && !clicked)) await sendRecord(clicked ? 'unverified' : kind === 'blocked' ? 'blocked' : 'failed', { reason: String(e.message).slice(0, 300) });
    if (kind === 'dialog') { await fail('a browser dialog appeared - stopping this tick'); }
  } finally {
    setFieldHook(null); setPageHook(null);
    if (tracing) { const z = await obs.traceStop(ctx, c.roleId); if (z) say(`trace ${z}`, tag); }
    if (page && recipeCleanup) { try { await recipeCleanup(page, m => say(m, tag)); } catch (e) { say(`cleanup failed: ${e.message}`, tag); } }
    if (page) await page.close().catch(() => {});
  }
}
if (flags.dry) await releaseUntouched('dry run');
else await releaseUntouched('left for the next tick');
await finish(0);
