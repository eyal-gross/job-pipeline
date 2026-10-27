// The ONLY way the scheduled reviewer deploys the Job Pipeline board (Eyal, 22 Oct 2026: "fix + test + verify anything that improves the
// stats", limits in code). The gate, in order, all or nothing:
//   1. the repo has no uncommitted change under board/ (what goes live is a commit, so it can be rolled back)
//   2. the four test suites pass on localhost:8899 (handsoff + chain: zero failures; obs + sorter: no more failures than reviewer/test-baseline.json,
//      they carry known local-only failures); netlify dev + the fire-catcher are started here when the port is silent and stopped after
//   3. deploy with netlify-cli, token from the file named in board-site.json read into the child's environment, never printed
//   4. after: cas-probe against the live site + app.js answers 200; the deploy is recorded in reviewer/deploys.jsonl {at, commit, deployId}
//   node worker/reviewer/deploy-board.mjs                 full gate + deploy
//   node worker/reviewer/deploy-board.mjs --tests-only    steps 1-2 only
//   node worker/reviewer/deploy-board.mjs --rollback      restore the previous recorded production deploy through the API (no credits)
//   node worker/reviewer/deploy-board.mjs --emergency     skip the 24 h pace (never the budget): only when the loop is broken
// Credits (25 Oct 2026): before step 3 the gate reads credits.mjs and refuses a deploy that breaks the pace or the budget (board-site.json).
//   node worker/reviewer/deploy-board.mjs --baseline      rewrite test-baseline.json from this run's obs / sorter failures (Eyal or a session, not the reviewer)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.BOARD_REPO || path.resolve(HERE, '..', '..');   // the git repo that holds board/
const SITE_DIR = path.join(REPO, 'board');
// the site, its account token and the credit budget live in board-site.json (25 Oct 2026: moved to a second Netlify account)
const { SITE, budget, deployVerdict, siteToken } = await import('./credits.mjs');
const SITE_ID = SITE.siteId;
const LIVE = SITE.live;
const LOCAL = 'http://localhost:8899';
const BASELINE = path.join(HERE, 'test-baseline.json');
const RECORD = path.join(HERE, 'deploys.jsonl');
const flags = new Set(process.argv.slice(2));
const say = m => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const fail = (m, code = 1) => { say('REFUSED: ' + m); process.exit(code); };
// alerts.mjs picks these up after the next worker tick and emails Eyal (25 Oct 2026: Netlify blocked deploys on credits and nobody knew)
const ALERTS_LOCAL = path.join(HERE, '..', 'logs', 'alerts-local.json');
const localAlert = (id, text) => { try { const a = (() => { try { return JSON.parse(fs.readFileSync(ALERTS_LOCAL, 'utf8')); } catch { return {}; } })(); if (text) a[id] = { text, sev: 'needs', at: new Date().toISOString() }; else delete a[id]; fs.mkdirSync(path.dirname(ALERTS_LOCAL), { recursive: true }); fs.writeFileSync(ALERTS_LOCAL, JSON.stringify(a, null, 1)); } catch { /* never blocks a deploy */ } };
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', ...opts });
const git = (...args) => sh('git', ['-C', REPO, ...args]).stdout.trim();

// ---- 1. clean tree, which commit ----
const dirty = git('status', '--porcelain', '--', 'board').split(/\r?\n/).filter(l => l.trim() && !/tests\/payloads\.jsonl/.test(l));
if (dirty.length && !flags.has('--rollback')) fail(`uncommitted changes under board/ (commit first, the deploy must equal a commit):\n  ${dirty.join('\n  ')}`);
const head = git('rev-parse', '--short', 'HEAD');
say(`repo at ${head}, tree clean under board/`);

// ---- 2. tests on localhost ----
const started = [];
const alive = async () => { try { const r = await fetch(`${LOCAL}/.netlify/functions/state`, { signal: AbortSignal.timeout(4000) }); return r.status === 401 || r.status === 200; } catch { return false; } };
const catcherAlive = async () => { try { const r = await fetch('http://localhost:8898/fire', { method: 'POST', body: '{}', signal: AbortSignal.timeout(2000) }); return r.status < 500; } catch { return false; } };
async function ensureLocal() {
  if (!await catcherAlive()) { const c = spawn('node', ['tests/fire-catcher.mjs'], { cwd: SITE_DIR, stdio: 'ignore', shell: true, detached: false }); started.push(c); say('started the fire-catcher on 8898'); }
  if (!await alive()) {
    const d = spawn('npx', ['--yes', 'netlify', 'dev', '--port', '8899', '--no-open', '--offline'], { cwd: SITE_DIR, stdio: 'ignore', shell: true, env: { ...process.env, ROUTINE_FIRE_URL: 'http://localhost:8898/fire', ROUTINE_TOKEN: 'local-test' } });
    started.push(d); say('started netlify dev on 8899, waiting for it');
    // netlify dev needs 2-4 minutes on this PC the first time (npx fetch + function bundling): wait up to 5
    for (let i = 0; i < 150; i++) { await new Promise(r => setTimeout(r, 2000)); if (await alive()) break; }
    if (!await alive()) fail('localhost:8899 never answered within 5 minutes');
  }
  say('localhost board is up');
}
// kill what we started: the spawned tree (cmd -> npx -> node) and, since taskkill /t misses a detached grandchild, whatever still listens on the two ports
const pidsOnPorts = () => { const out = sh('netstat', ['-ano']).stdout || ''; return [...new Set(out.split(/\r?\n/).filter(l => /:(8899|8898)\s/.test(l) && /LISTENING/.test(l)).map(l => l.trim().split(/\s+/).pop()).filter(p => /^\d+$/.test(p) && p !== '0'))]; };
const stopLocal = () => {
  if (!started.length) return;
  for (const p of started.splice(0)) { try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/t', '/f'], { stdio: 'ignore' }); else p.kill(); } catch { /* gone */ } }
  if (process.platform === 'win32') for (const pid of pidsOnPorts()) spawnSync('taskkill', ['/pid', pid, '/t', '/f'], { stdio: 'ignore' });
};
process.on('exit', stopLocal);   // a refused run must not leave the servers it started behind
function runSuite(name) {
  const r = sh('node', [`tests/${name}.test.mjs`], { cwd: SITE_DIR, timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
  const all = (r.stdout || '') + (r.stderr || '');
  const m = all.match(/(\d+) passed, (\d+) failed/);
  // no summary line = the suite crashed, hung (timeout) or the local board stalled: counted as a failure of the gate, never as a pass
  const out = { name, passed: m ? Number(m[1]) : 0, failed: m ? Number(m[2]) : 999, fails: (all.match(/^FAIL .*$/gm) || []).slice(0, 8), crashed: !m ? (r.error ? r.error.message : all.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 300)) : null };
  say(`${name}: ${m ? `${out.passed} passed, ${out.failed} failed` : `NO SUMMARY (${out.crashed || 'empty output'})`}${out.fails.length ? '\n    ' + out.fails.join('\n    ').slice(0, 900) : ''}`);
  return out;
}
const CLEAN_EXTRA = ['company-rule', 'prefilter', 'techmap', 'titles', 'feed', 'rate-limit'];   // rate-limit: 27 Oct 2026, the routine 429 backoff (9b251ff)
let results = [];
if (!flags.has('--rollback')) {
  await ensureLocal();
  // 26 Oct 2026 (supply widening): the company rule, the pre-filter, techmap, the wider titles and the LinkedIn feed action join the gate, all required clean
  results = ['obs', 'handsoff', 'chain', 'sorter', ...CLEAN_EXTRA].map(runSuite);
  stopLocal();
  const base = (() => { try { return JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch { return { obs: 0, sorter: 0 }; } })();
  if (flags.has('--baseline')) { const b = { obs: results[0].failed, sorter: results[3].failed, at: new Date().toISOString() }; fs.writeFileSync(BASELINE, JSON.stringify(b, null, 1)); say(`baseline written: ${JSON.stringify(b)}`); }
  const bad = [];
  for (const r of results) { if (['handsoff', 'chain', ...CLEAN_EXTRA].includes(r.name) && r.failed > 0) bad.push(`${r.name} has ${r.failed} failures`); if (['obs', 'sorter'].includes(r.name) && r.failed > (base[r.name] ?? 0)) bad.push(`${r.name} has ${r.failed} failures, baseline allows ${base[r.name] ?? 0}`); }
  if (bad.length) fail('tests: ' + bad.join('; '));
  say('test gate passed');
  if (flags.has('--tests-only')) process.exit(0);
}

// ---- 3. credits, then deploy ----
// Every production deploy costs Netlify credits (15 each); the old account ran out on 25 Oct 2026. Pace and budget are code, not advice:
// one production deploy per minHoursBetweenDeploys (--emergency skips only the pace, for a broken loop) and never past budget - reserve.
let token; try { token = siteToken(); } catch (e) { fail(e.message, 2); }
const records = (() => { try { return fs.readFileSync(RECORD, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)).filter(r => r.site === SITE_ID); } catch { return []; } })();
if (flags.has('--rollback')) {
  // a rollback restores the previous production deploy through the API: Netlify charges no credits for it, so no budget check
  const prev = records.length >= 2 ? records[records.length - 2] : null;
  if (!prev || !prev.deployId) fail('no earlier recorded deploy on this site to roll back to');
  const r = await fetch(`https://api.netlify.com/api/v1/sites/${SITE_ID}/deploys/${prev.deployId}/restore`, { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) fail(`rollback restore answered ${r.status}`);
  fs.appendFileSync(RECORD, JSON.stringify({ at: new Date().toISOString(), site: SITE_ID, commit: prev.commit, deployId: prev.deployId, rollback: true }) + '\n');
  say(`rolled back to ${prev.deployId} (${prev.commit}), no credits used`); process.exit(0);
}
let credit; try { credit = await budget(); } catch (e) { fail(`could not read the Netlify credit budget (${e.message}); not deploying blind`); }
const verdict = deployVerdict(credit, { emergency: flags.has('--emergency') });
say(`credits: used ~${credit.used} of ${credit.budget}, projected ${credit.projected} at the reset ${credit.resetAt.slice(0, 10)}, ${credit.deploysThisCycle} deploys this cycle`);
if (!verdict.ok) fail(verdict.why, 4);
say(`credit gate: ${verdict.why}${flags.has('--emergency') ? ' (EMERGENCY: pace skipped)' : ''}`);
const dir = SITE_DIR, commit = head;
say(`deploying ${commit} to ${LIVE}`);
try { fs.unlinkSync(path.join(dir, 'tests', 'payloads.jsonl')); } catch { /* not there */ }   // the fire-catcher's scratch file must not be published
// stdin closed + CI=1: with an open stdin the CLI waits on a prompt forever (23 minutes of nothing on 22 Oct)
const dep = sh('npx', ['--yes', 'netlify-cli@latest', 'deploy', `--dir=.`, `--site=${SITE_ID}`, '--prod'], { cwd: dir, timeout: 600000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NETLIFY_AUTH_TOKEN: token.trim(), CI: '1' } });
let text = (dep.stdout || '') + (dep.stderr || '');
let deployId = (text.match(/deployId:\s*([0-9a-f]{24})/) || [])[1] || null;
if (!/Deploy is live/.test(text) && /Forbidden/.test(text)) {
  // 25 Oct 2026: a 403 here meant "Account credit usage exceeded". No draft fallback any more: a draft runs without production-only
  // variables, and publishing drafts sidesteps the account's limit. Stop and tell Eyal.
  localAlert('deploy-blocked', `Netlify refused a production deploy of the board (403) on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Usually the account is out of credits: check Netlify (${SITE.account}) > Billing > Usage.`);
  fail('Netlify refused the production deploy (403 Forbidden): not deploying; alert raised');
}
if (!/Deploy is live/.test(text)) { say(text.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/).filter(l => l.trim() && !/token/i.test(l)).slice(-15).join('\n') + `\n(exit ${dep.status}${dep.error ? ', ' + dep.error.message : ''})`); fail('netlify did not report "Deploy is live"'); }   // the tail, not just "error" lines: 24 Oct the refusal printed nothing
say(`deploy live: ${deployId || '(id not parsed)'}`);
localAlert('deploy-blocked', null);   // a production deploy went through: no block

// ---- 4. probe ----
let probe = sh('node', ['tests/cas-probe.mjs', LIVE], { cwd: SITE_DIR, timeout: 120000 });
let probeOk = /PASS/.test(probe.stdout || '');
if (!probeOk) {   // 23 Oct 2026: the probe 30 s after "deploy live" failed on cold functions, the same probe by hand a minute later passed; one retry after 25 s
  say(`post-deploy: cas-probe FAIL on the first try (${(probe.stdout || '').trim().split('\n').pop() || probe.stderr || 'no output'}), retrying in 25 s`);
  await new Promise(r => setTimeout(r, 25000));
  probe = sh('node', ['tests/cas-probe.mjs', LIVE], { cwd: SITE_DIR, timeout: 120000 });
  probeOk = /PASS/.test(probe.stdout || '');
}
let appOk = false; try { appOk = (await fetch(`${LIVE}/app.js`, { signal: AbortSignal.timeout(15000) })).status === 200; } catch { /* no */ }
say(`post-deploy: cas-probe ${probeOk ? 'PASS' : 'FAIL'}, app.js ${appOk ? '200' : 'not 200'}`);
let features = {}; try { const cfg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'config.json'), 'utf8')); const pk = (fs.readFileSync(path.resolve(HERE, '..', cfg.envFile), 'utf8').match(/^PIPELINE_KEY=(.*)$/m) || [])[1]?.trim(); const d = await (await fetch(`${LIVE}/.netlify/functions/state`, { headers: { 'x-key': pk }, signal: AbortSignal.timeout(20000) })).json(); features = d.features || {}; } catch { /* reported below */ }
const agentsOk = features.huntWorker === true;   // ROUTINE_TOKEN + ROUTINE_FIRE_URL reached the functions: the board can start its agents
say(`post-deploy: agents ${agentsOk ? 'can start (huntWorker true)' : 'CANNOT start (huntWorker not true)'}`);
localAlert('agents-off-deploy', agentsOk ? null : 'The board was deployed but cannot start its agents (ROUTINE_TOKEN or ROUTINE_FIRE_URL missing on the site).');
try { fs.writeFileSync(path.join(HERE, '..', 'logs', 'credits.json'), JSON.stringify(await budget(), null, 1)); } catch { /* the next worker tick refreshes it */ }
fs.appendFileSync(RECORD, JSON.stringify({ at: new Date().toISOString(), site: SITE_ID, commit, deployId, agentsOk, rollback: false, tests: results.map(r => `${r.name} ${r.passed}/${r.failed}`), probeOk, appOk }) + '\n');
if (!probeOk || !appOk) fail('post-deploy probe failed: roll back with --rollback (free) and write it in the digest', 3);
if (!agentsOk) fail('post-deploy: the board cannot start its agents; check ROUTINE_TOKEN / ROUTINE_FIRE_URL on the site', 3);
say('done');
