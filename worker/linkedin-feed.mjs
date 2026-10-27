// LinkedIn guest search from the PC (supply widening item 5, Eyal 26 Oct 2026). The board's finder asks LinkedIn's logged-out job search
// from the cloud and is refused most nights (about 30 roles a night got through). This runs the SAME public guest endpoint from the home
// PC before each hunt window and hands the rows to the board (hunt action "feed"); the finder's linkedin step uses them while fresh (16 h).
// Rules: plain fetch, logged out, no cookies, no browser, never Eyal's account, read-only. Polite: 5-9 s between requests, at most ~37 a
// run, and the first refusal (429 / 999 / 403 / anything not 200) stops the run and backs off for 24 h.
// The worker starts it detached at every tick; it runs only once per hunt window (22:00-23:59 UTC for the night run, 09:00-10:59 UTC for
// the day run) and exits at once otherwise.
//   node worker/linkedin-feed.mjs            run if this window has no feed yet
//   node worker/linkedin-feed.mjs --now      run now (still honours the back-off)
//   node worker/linkedin-feed.mjs --dry      search and print the counts, post nothing, write no window mark
//   node worker/linkedin-feed.mjs --local    post to the localhost board (netlify dev :8899)
// Off switch: "linkedinFeed": false in config.json (the finder then falls back on its own cloud search).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board, loadConfig, ROOT } from './lib/board.mjs';
import { parseGuestCards, QUERIES } from '../board/netlify/functions/hunt-find.mjs';
import { TITLE_INCLUDE, TITLE_EXCLUDE, ISRAEL } from '../board/netlify/functions/hunt.mjs';

const STATE = path.join(ROOT, 'logs', 'linkedin-feed.json');   // { window, lastRunAt, backoffUntil, running, last }
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const PAGES = [0, 25], DEEP = 5, DEEP_PAGE = 50;   // two pages for every search word, a third for the first five (the core titles)
const H = 3600000;
const flags = new Set(process.argv.slice(2));
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const write = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 1)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = m => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

// which hunt window a moment feeds: 22-23 UTC -> the next night run, 09-10 UTC -> today's day run, else none
export function windowFor(d = new Date()) {
  const hr = d.getUTCHours();
  if (hr >= 22) return `hunt-${new Date(d.getTime() + 3 * H).toISOString().slice(0, 10)}`;
  if (hr >= 9 && hr <= 10) return `hunt-${d.toISOString().slice(0, 10)}-day`;
  return null;
}
export const fits = c => TITLE_INCLUDE.test(c.title) && !TITLE_EXCLUDE.test(c.title) && (!c.location || ISRAEL.test(c.location) || ISRAEL.test(c.title));
export function plan() { const out = []; QUERIES.forEach((q, i) => { for (const p of PAGES) out.push({ q, start: p }); if (i < DEEP) out.push({ q, start: DEEP_PAGE }); }); return out; }

export async function search({ fetchImpl = fetch, pause = () => sleep(5000 + Math.random() * 4000), log = say } = {}) {
  const rows = new Map(); let pages = 0, refusedAt = null, status = null;
  const steps = plan();
  for (let i = 0; i < steps.length; i++) {
    const { q, start } = steps[i];
    const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(q)}&location=Israel&f_TPR=r604800&start=${start}`;
    let r; try { r = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' }, redirect: 'follow' }); } catch (e) { refusedAt = `${q}@${start}`; status = `network ${String(e.message).slice(0, 60)}`; break; }
    if (r.status !== 200) { refusedAt = `${q}@${start}`; status = r.status; break; }
    const cards = parseGuestCards(await r.text()); pages++;
    let kept = 0; for (const c of cards) if (fits(c) && !rows.has(c.url)) { rows.set(c.url, c); kept++; }
    log(`"${q}" start=${start}: ${cards.length} cards, ${kept} new fitting`);
    if (!cards.length && start === 0) { /* nothing for this word: skip its next page */ while (steps[i + 1] && steps[i + 1].q === q) i++; }
    if (i < steps.length - 1) await pause();
  }
  return { rows: [...rows.values()], pages, refusedAt, status, queries: QUERIES.length };
}

async function main() {
  const cfg = read(path.join(ROOT, 'config.json'), {});
  if (cfg.linkedinFeed === false && !flags.has('--dry')) { say('off (config.json linkedinFeed: false)'); return; }
  const S = read(STATE, {});
  const win = windowFor();
  if (!flags.has('--now') && !flags.has('--dry')) { if (!win) return; if (S.window === win) return; }
  if (S.backoffUntil && Date.now() < Date.parse(S.backoffUntil)) { say(`backing off until ${S.backoffUntil} (LinkedIn refused ${S.last && S.last.refusedAt})`); return; }
  if (S.running && Date.now() - Date.parse(S.running) < 20 * 60000) { say('another feed run is going'); return; }
  if (!flags.has('--dry')) write(STATE, { ...S, running: new Date().toISOString() });
  const t0 = Date.now(); let res;
  try { res = await search(); } finally { if (!flags.has('--dry')) { const s2 = read(STATE, {}); delete s2.running; write(STATE, s2); } }
  say(`done: ${res.rows.length} fitting roles from ${res.pages} pages in ${Math.round((Date.now() - t0) / 1000)} s${res.refusedAt ? `; refused at ${res.refusedAt} (${res.status})` : ''}`);
  if (flags.has('--dry')) { res.rows.slice(0, 15).forEach(c => console.log(`  ${c.name} | ${c.title} | ${c.location}`)); return; }
  const S2 = read(STATE, {});
  S2.lastRunAt = new Date().toISOString(); S2.last = { rows: res.rows.length, pages: res.pages, refusedAt: res.refusedAt, status: res.status };
  if (res.refusedAt) S2.backoffUntil = new Date(Date.now() + 24 * H).toISOString();
  if (res.rows.length) {
    const { board: base, key } = loadConfig(flags.has('--local') ? ['--local'] : [], { defaultLive: true });
    try { const b = await new Board(base, key).feed('linkedin', res.rows, { queries: res.queries, pages: res.pages, refusedAt: res.refusedAt || '' }); say(`board kept ${b.feed ? b.feed.rows : '?'} rows`); }
    catch (e) { say(`board refused the feed: ${e.message}`); S2.last.boardError = String(e.message).slice(0, 160); }
  }
  S2.window = win || S2.window;   // one search per window, whatever the board answered: LinkedIn is never asked twice for the same window
  write(STATE, S2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
