// Apply runner. Submits the practice-tier cards Eyal approved in the morning brief. Nothing else is ever touched.
//   node run.mjs [--dry] [--live] [--max N] [--role <id>] [--board <url>]
// --dry   fill + attach + screenshot, never click Submit, card stays "approved"
// --live  use the live board instead of localhost:8899 (config.json)
// Hard rules: only apply.status === 'approved' && tier === 'practice'; kill switch off; never-twice re-checked; one dialog = abort.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, Board, slug } from './lib/board.mjs';
import { Log, makeRunId } from './lib/log.mjs';
import { attach } from './lib/browser.mjs';
import { recipeFor } from './recipes/index.mjs';
import { sleep } from './lib/forms.mjs';

const { cfg, profile, flags, board: base, key, max } = loadConfig();
const runId = makeRunId();
const log = new Log(runId);
const say = (m, card) => log.line(m, card);
const summary = { board: base, dry: !!flags.dry, submitted: [], blocked: [], failed: [], skipped: [], aborted: '' };
const finish = (code = 0) => { log.finish(summary); console.log('\nSUMMARY ' + JSON.stringify(summary)); process.exit(code); };
const abort = m => { say('ABORT ' + m); summary.aborted = m; finish(2); };

if (!profile) abort('config.local.json is missing (firstName, lastName, email, phone, linkedin)');
say(`run ${runId} board=${base} dry=${!!flags.dry} max=${max}`);
const board = new Board(base, key);

// ---- preflight: board, kill switch, queue ----
let st;
try { st = await board.state(); } catch (e) { abort(`board unreachable: ${e.message}`); }
const hunt = st.hunt || {};
if (hunt.killSwitch) abort('kill switch is on');
await fetch(`${base}/.netlify/functions/hunt`, { method: 'POST', headers: board.hdr(), body: JSON.stringify({ action: 'sweep' }) }).catch(() => {});   // stale submitting -> failed/timeout
st = await board.state();
const companyOf = r => st.companies.find(c => c.id === r.companyId);
let queue = st.roles.filter(r => r.apply && r.apply.status === 'approved' && r.tier === 'practice' && companyOf(r) && companyOf(r).tier === 'practice');
if (flags.role) queue = queue.filter(r => r.id === flags.role);
const stuck = st.roles.filter(r => r.apply && r.apply.status === 'submitting');
if (stuck.length) say(`${stuck.length} card(s) still 'submitting' from an earlier run - left alone (the sweep turns them into failed/timeout after 2 h)`);
say(`queue: ${queue.length} approved practice card(s)${queue.length > max ? `, taking ${max}` : ''}`);
queue = queue.slice(0, max);
if (!queue.length) { say('nothing to do'); finish(0); }

// ---- preflight: browser ----
let browser;
try { browser = await attach({ log: say }); } catch (e) { abort(`browser: ${e.message}`); }
const ctx = browser.ctx;
{
  const p = await ctx.newPage();
  try { await p.goto('https://mail.google.com/mail/u/0/', { waitUntil: 'domcontentloaded', timeout: 30000 }); await sleep(2500);
    const loggedIn = !/accounts\.google\.com|\/signin|ServiceLogin|workspace\.google\.com/.test(p.url());
    say(`google: ${loggedIn ? 'logged in' : 'NOT logged in'}`);
    if (!loggedIn && !flags.dry) { await p.close(); abort('log into Google once in the apply-runner Chrome profile (start-chrome.cmd), then run again'); }
  } catch (e) { say(`google check skipped: ${e.message}`); }
  await p.close();
}

// ---- per card ----
const pdfFor = (card, co) => {
  const cand = [card.apply.pdf, card.apply.pdf && path.join(cfg.cvsDir, card.apply.pdf), path.join(cfg.cvsDir, slug(co.name), 'CV.pdf')].filter(Boolean);
  return cand.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || '';
};
const shotDir = co => { const d = path.join(cfg.applicationsDir, slug(co.name)); fs.mkdirSync(d, { recursive: true }); return d; };
const rel = p => path.relative(path.dirname(cfg.applicationsDir), p).replace(/\\/g, '/');

for (const q of queue) {
  const cardId = q.id; const tag = `${slug(companyOf(q).name)}/${cardId}`;
  let page, status = '', reason = '', shot = '';
  const patch = async (p, extra = {}) => { try { await board.patch(cardId, { ...p, log: log.cardLog(tag), runId }, extra); } catch (e) { say(`patch failed: ${e.message}`, tag); } };
  const screenshot = async (name) => { try { const f = path.join(shotDir(companyOf(q)), `${runId}-${name}.png`); await page.screenshot({ path: f, fullPage: true }); shot = rel(f); say(`screenshot ${shot}`, tag); return f; } catch (e) { say(`screenshot failed: ${e.message}`, tag); return ''; } };
  try {
    // re-read the card and re-check every guard right before touching it
    const { st: st2, r: card, c: co } = await board.role(cardId);
    if (!card || !co) throw Object.assign(new Error('card vanished'), { kind: 'skip' });
    if ((st2.hunt || {}).killSwitch) abort('kill switch switched on mid-run');
    if (card.apply.status !== 'approved') throw Object.assign(new Error(`status is ${card.apply.status}, not approved`), { kind: 'skip' });
    if (card.tier !== 'practice' || co.tier !== 'practice') throw Object.assign(new Error('not practice tier'), { kind: 'skip' });
    const g = co.research && co.research.fit && co.research.fit.grade; if (Number.isInteger(g) && g > 6) throw Object.assign(new Error(`grade ${g} is above 6`), { kind: 'skip' });
    if (st2.roles.some(r => r.companyId === co.id && r.id !== card.id && r.apply && ['submitting', 'submitted', 'confirmed', 'unverified'].includes(r.apply.status))) throw Object.assign(new Error('another role at this company was already submitted'), { kind: 'skip' });
    if ((card.apply.needsHuman || []).length) throw Object.assign(new Error(`${card.apply.needsHuman.length} screener(s) still need an answer from you`), { kind: 'skip' });
    const pdf = pdfFor(card, co); if (!pdf) throw Object.assign(new Error('CV pdf not found - run cv.js tailor first'), { kind: 'skip' });
    const recipe = recipeFor(card); if (!recipe) throw Object.assign(new Error(`no recipe for ${card.apply.ats} / ${card.apply.url}`), { kind: 'skip' });
    say(`start ${co.name} - ${card.title} (${recipe.name}) cv=${pdf}`, tag);

    if (!flags.dry) await board.patch(cardId, { status: 'submitting', runId });
    page = await ctx.newPage();
    let dialog = '';
    page.on('dialog', d => { dialog = `${d.type()}: ${d.message()}`.slice(0, 200); d.dismiss().catch(() => {}); });
    const work = (async () => {
      const scope = await recipe.open(page, card);
      const b0 = await recipe.blocked(page); if (b0) throw Object.assign(new Error(`blocked on open: ${b0}`), { kind: 'blocked', reason: b0 });
      await recipe.fill(scope, card, profile, m => say(m, tag));
      const how = await recipe.attachCv(scope, page, pdf); say(`cv attached via ${how}`, tag);
      await recipe.screeners(scope, card, m => say(m, tag));
      await sleep(1500);
      await screenshot('filled');
      if (dialog) throw Object.assign(new Error(`dialog: ${dialog}`), { kind: 'dialog' });
      if (flags.dry) { say('DRY RUN - not submitting', tag); return { dry: true }; }
      await recipe.submit(scope, page);
      say('submit clicked', tag);
      const res = await recipe.confirmed(page, scope, cfg.confirmMs || 30000);
      if (res.ok) {
        const f = await screenshot('confirmed');
        if (f) fs.writeFileSync(f.replace(/\.png$/, '.txt'), `${new Date().toISOString()}\n${co.name} - ${card.title}\n${card.apply.url}\n\n${res.text}\n`);
        return { submitted: true, text: res.text };
      }
      const why = await recipe.blocked(page);
      if (why) throw Object.assign(new Error(`blocked after submit: ${why}`), { kind: 'blocked', reason: why });
      throw Object.assign(new Error('no confirmation within the time limit'), { kind: 'timeout' });
    })();
    const out = await Promise.race([work, sleep(cfg.perCardMs || 240000).then(() => { throw Object.assign(new Error('card time limit'), { kind: 'timeout' }); })]);
    if (out.dry) { summary.skipped.push({ id: cardId, company: co.name, why: 'dry run' }); }
    else { status = 'submitted'; say(`CONFIRMED: ${out.text.slice(0, 120)}`, tag); await patch({ status: 'submitted', screenshot: shot }); summary.submitted.push({ id: cardId, company: co.name, title: card.title, screenshot: shot }); }
    if (dialog) { say(`dialog seen during the run: ${dialog}`, tag); abort('a browser dialog appeared - stopping the run'); }
  } catch (e) {
    const kind = e.kind || 'form-error';
    reason = e.reason || (kind === 'timeout' ? 'timeout' : kind === 'needs-human' ? 'needs-human' : kind === 'changed-form' ? 'changed-form' : kind === 'upload' ? 'upload' : kind === 'dialog' ? 'dialog' : kind);
    say(`${kind.toUpperCase()}: ${e.message}`, tag);
    if (kind === 'skip') { summary.skipped.push({ id: cardId, why: e.message }); }
    else {
      if (page) await screenshot(kind === 'blocked' ? 'blocked' : 'failed');
      if (!flags.dry) {
        if (kind === 'blocked') { await patch({ status: 'blocked', reason, screenshot: shot }); summary.blocked.push({ id: cardId, reason, screenshot: shot }); }
        else { await patch({ status: 'failed', reason: `${reason}: ${e.message}`.slice(0, 160), screenshot: shot }); summary.failed.push({ id: cardId, reason: e.message, screenshot: shot }); }
      } else summary.failed.push({ id: cardId, reason: `(dry) ${e.message}`, screenshot: shot });
      if (kind === 'dialog') abort('a browser dialog appeared - stopping the run');
    }
  } finally {
    if (page) await page.close().catch(() => {});
  }
}
await browser.close().catch(() => {});
finish(0);
