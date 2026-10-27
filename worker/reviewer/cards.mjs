// Reviewer helper: what changed on the board since the last review, plus the leak counts the Analytics tab shows.
//   node worker/reviewer/cards.mjs            cards touched since reviewer/state.json .lastRunAt (or 24 h), one line each
//   node worker/reviewer/cards.mjs --leaks    why kept cards never reached the queue / were not sent, last 14 days
//   node worker/reviewer/cards.mjs --rates    the four stage rates, last 7 days vs the 7 before
// Read-only. The key is read from the pipeline .env by lib/board.mjs; never printed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board, loadConfig } from '../lib/board.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(HERE, 'state.json');
const flags = new Set(process.argv.slice(2));
const { board: base, key } = loadConfig([], { defaultLive: true });
const st = await new Board(base, key).state();
const DAY = 86400000; const now = Date.now();
let since = now - DAY; try { const s = JSON.parse(fs.readFileSync(STATE, 'utf8')); if (s.lastRunAt) since = Date.parse(s.lastRunAt); } catch { /* first run */ }
const co = id => st.companies.find(c => c.id === id) || {};
const tierOf = r => r.tier || (co(r.companyId).tier) || 'real';
const pr = st.roles.filter(r => r.apply && r.apply.status && tierOf(r) === 'practice');
const a = r => r.apply;
const stamps = ['foundAt', 'preparedAt', 'approvedAt', 'startedAt', 'submittedAt', 'confirmedAt', 'unverifiedAt', 'failedAt', 'blockedAt', 'skippedAt'];
const lastTouch = r => Math.max(0, ...stamps.map(k => a(r)[k] ? Date.parse(a(r)[k]) : 0), a(r).formFinder && a(r).formFinder.at ? Date.parse(a(r).formFinder.at) : 0);
const short = (s, n) => String(s || '').replace(/\s+/g, ' ').slice(0, n);
const queuedAt = r => a(r).approvedAt || a(r).startedAt || (['submitted', 'confirmed', 'failed', 'blocked'].includes(a(r).status) ? (a(r).submittedAt || a(r).failedAt || a(r).blockedAt) : '');
const sentAt = r => a(r).submittedAt || (a(r).status === 'confirmed' ? a(r).confirmedAt : '');

if (flags.has('--rates')) {
  const win = (from, to) => { const inW = t => t && Date.parse(t) >= from && Date.parse(t) < to; const k = pr.filter(r => inW(a(r).foundAt) && a(r).status !== 'real'); const q = pr.filter(r => inW(queuedAt(r))); const s = pr.filter(r => inW(sentAt(r))); const pct = (x, y) => y ? Math.round(100 * x / y) + '%' : '-'; return `kept->queued ${pct(k.filter(r => queuedAt(r)).length, k.length)} (${k.filter(r => queuedAt(r)).length}/${k.length}) · queued->sent ${pct(q.filter(r => sentAt(r)).length, q.length)} (${q.filter(r => sentAt(r)).length}/${q.length}, unknown ${q.filter(r => a(r).status === 'unverified' && !sentAt(r)).length}) · sent->receipt ${pct(s.filter(r => a(r).confirmedAt).length, s.length)} · sent->interview ${pct(s.filter(r => r.screened || ['interviewing', 'offer'].includes(r.stage)).length, s.length)}`; };
  console.log('last 7 days:  ' + win(now - 7 * DAY, now + DAY));
  console.log('7 before:     ' + win(now - 14 * DAY, now - 7 * DAY));
  console.log(`caps: perDay ${st.hunt.caps.perDay ?? 5}, prepared ${st.hunt.caps.prepared}, worker today: ${JSON.stringify(st.hunt.worker && st.hunt.worker.today)}`);
  process.exit(0);
}
if (flags.has('--leaks')) {
  const sinceL = now - 14 * DAY; const count = (list, f) => { const m = {}; list.forEach(r => { const k = f(r); if (k) m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((x, y) => y[1] - x[1]); };
  const reasonKey = s => String(s || '').replace(/^forfeited:\s*/i, '').split(/[;(]/)[0].trim().slice(0, 90) || 'unknown';
  const notQueued = pr.filter(r => a(r).foundAt && Date.parse(a(r).foundAt) >= sinceL && !queuedAt(r) && !['candidate', 'prepared', 'real'].includes(a(r).status));
  console.log('Never reached the queue (14 d):'); count(notQueued, r => a(r).status === 'manual' ? `no recipe for ${a(r).ats || '?'}` : reasonKey(a(r).reason || a(r).status)).forEach(([k, n]) => console.log(`  ${n}  ${k}`));
  const notSent = pr.filter(r => queuedAt(r) && Date.parse(queuedAt(r)) >= sinceL && !sentAt(r) && !['approved', 'submitting'].includes(a(r).status));
  console.log('Queued but not sent (14 d):'); count(notSent, r => `${a(r).ats || '?'}: ${a(r).status === 'unverified' ? 'clicked, outcome unknown' : reasonKey(a(r).reason || a(r).status)}`).forEach(([k, n]) => console.log(`  ${n}  ${k}`));
  const manual = pr.filter(r => a(r).status === 'manual'); console.log('Cards with no recipe at all (any time): ' + (manual.length ? Object.entries(manual.reduce((m, r) => (m[a(r).ats || '?'] = (m[a(r).ats || '?'] || 0) + 1, m), {})).map(([k, n]) => `${k} ${n}`).join(', ') : 'none'));
  process.exit(0);
}
const changed = pr.filter(r => lastTouch(r) >= since).sort((x, y) => lastTouch(y) - lastTouch(x));
console.log(`cards touched since ${new Date(since).toISOString().slice(0, 16)} UTC: ${changed.length}`);
for (const r of changed) {
  const c = co(r.companyId); const x = a(r);
  console.log(`- ${r.id} | ${c.name} | ${short(r.title, 50)} | ${x.ats} | ${x.status} | grade ${x.grade ?? '?'} | url ${x.url}\n    reason: ${short(x.reason, 160) || '-'}${x.errors && x.errors.length ? `\n    prep errors: ${short(x.errors.slice(-1)[0], 160)}` : ''}${x.formFinder ? `\n    finder: ${x.formFinder.found ? 'found ' + x.formFinder.ats : 'not found'} via ${x.formFinder.via}` : ''}${x.screenshot ? `\n    screenshot: ${x.screenshot}` : ''}`);
}
