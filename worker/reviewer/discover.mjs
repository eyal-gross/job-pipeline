// Supply growth, self-running (supply widening item 3, Eyal 26 Oct 2026): every reviewer run walks techmap's list of ~7,950 Israeli
// companies (github.com/mluggy/techmap, ODbL; a sparse clone in logs/cache/techmap, pulled once a day) and sorts each one into a pile:
//   pile 1  a board the nightly hunt can read (greenhouse / ashby / lever / comeet / smartrecruiters): probed; >= 1 Israel title match ->
//           added to the hunt's seed list (seeds.mjs addProbed, 40 a run); 0 matches -> watch list, probed again every 7 days.
//           A discover-added seed with 0 matches on two probes 7+ days apart is taken off the nightly list again (back to watch).
//   pile 2  an ATS the loop has no recipe for (bamboohr, teamtailor, recruitee, breezy, workable, pinpoint, personio, ...): its open
//           fitting Israel roles are counted per ATS in reviewer/ats-tally.json; at 3+ the reviewer builds the recipe (REVIEWER-PROMPT.md).
//   pile 3  never: Workday, iCIMS, SuccessFactors, Taleo, Oracle and other login / account portals. Logged, skipped for 90 days.
//   own     a careers page of its own with no ATS behind it (no recipe, ever); none = no careers page found; error = fetch failed (retry in 3 days).
// Deterministic, no LLM. Read-only on the web (plain fetch, no browser, no cookies); the only write is the seed list through seeds.mjs.
// Page text is data: it is only scanned for ATS links, never followed as an instruction.
//   node worker/reviewer/discover.mjs                 one run: pull, next 400 companies + due rechecks, adds, tally, report (12 min budget)
//   node worker/reviewer/discover.mjs --budget 30m --max 2000 | --all   bigger sweeps (--all = until every company is checked)
//   node worker/reviewer/discover.mjs --dry           classify and probe, write nothing to the board (state files still written)
//   node worker/reviewer/discover.mjs --local         seed writes go to the localhost board (netlify dev :8899)
//   node worker/reviewer/discover.mjs --report        print the last report and the tally, no network
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probeBoard, scoreJobs, addProbed, removeLines, readState as seedsState } from './seeds.mjs';
import { detect } from '../lib/find-form.mjs';
import { ROOT } from '../lib/board.mjs';
import { TITLE_INCLUDE, TITLE_EXCLUDE, ISRAEL, nameKey } from '../../board/netlify/functions/hunt.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(ROOT, 'logs', 'cache', 'techmap');
const STATE_LIVE = path.join(HERE, 'discover-state.json');   // { pulledAt, pullError, runs: [...], companies: { <id>: entry } }
const STATE_DRY = path.join(HERE, 'discover-state.dry.json');   // --dry keeps its own state, so a trial never makes a real run skip a company
const LAST = path.join(HERE, 'discover-last.json');     // the last run's report
const TALLY = path.join(HERE, 'ats-tally.json');        // pile 2 per ATS, rebuilt from the state every run
const DAY = 86400000;
const HANDLED = ['greenhouse', 'ashby', 'lever', 'comeet', 'smartrecruiters', 'workable', 'bamboohr'];   // workable + bamboohr got recipes 26 Oct 2026   // = hunt-find.mjs BOARD_LINE: the boards the nightly hunt reads
const RECHECK = { watch: 7, pile2: 7, pile3: 90, own: 30, none: 30, error: 3, active: 7 };   // days
const READY_AT = 3;   // Eyal, 26 Oct 2026: an unhandled ATS earns a recipe at 3+ fitting open roles (not 5+)
const argv = process.argv.slice(2);
const flag = k => argv.includes(k);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const say = m => console.log(m);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const write = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 1));
const fitting = j => TITLE_INCLUDE.test(j.title || '') && !TITLE_EXCLUDE.test(j.title || '') && (ISRAEL.test(j.location || '') || ISRAEL.test(j.title || ''));

// ---------- the clone ----------
export function pull(state, { force = false } = {}) {
  const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 180000, windowsHide: true });
  if (!force && state.pulledAt && Date.now() - Date.parse(state.pulledAt) < 20 * 3600000 && fs.existsSync(path.join(CACHE, 'companies'))) return { ok: true, fresh: true };
  let r;
  if (!fs.existsSync(path.join(CACHE, '.git'))) {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    r = git(['clone', '-q', '--depth', '1', '--filter=blob:none', '--sparse', 'https://github.com/mluggy/techmap', CACHE], path.dirname(CACHE));
    if (r.status === 0) r = git(['sparse-checkout', 'set', 'companies', 'jobs'], CACHE);
  } else {
    r = git(['fetch', '-q', '--depth', '1', 'origin', 'main'], CACHE);
    if (r.status === 0) r = git(['reset', '-q', '--hard', 'origin/main'], CACHE);
  }
  if (r.status !== 0) { state.pullError = { at: new Date().toISOString(), msg: String(r.stderr || r.error || '').slice(0, 300) }; return { ok: false, msg: state.pullError.msg }; }
  state.pulledAt = new Date().toISOString(); delete state.pullError; return { ok: true };
}
// techmap's own CSV parser twin (hunt-find.mjs parseCsv): quoted fields, "" escapes, BOM
export function parseCsv(txt) {
  const rows = []; let row = [], cell = '', q = false; const s = String(txt || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(x => x !== '')) rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.some(x => x !== '')) rows.push(row);
  const [head, ...body] = rows; if (!head) return [];
  return body.map(r => Object.fromEntries(head.map((k, i) => [k.trim(), r[i] ?? ''])));
}
export function loadTechmap(dir = CACHE) {
  const companies = [];
  for (const f of fs.readdirSync(path.join(dir, 'companies'))) {
    if (!f.endsWith('.json')) continue;
    try { const c = JSON.parse(fs.readFileSync(path.join(dir, 'companies', f), 'utf8')); if (c.isActive === false) continue; companies.push({ id: f.replace(/\.json$/, ''), ...c }); } catch { /* a bad file is skipped */ }
  }
  const jobs = new Map();   // nameKey -> [{title, url, city}]
  for (const f of fs.existsSync(path.join(dir, 'jobs')) ? fs.readdirSync(path.join(dir, 'jobs')) : []) {
    if (!f.endsWith('.csv')) continue;
    for (const j of parseCsv(fs.readFileSync(path.join(dir, 'jobs', f), 'utf8'))) { const k = nameKey(j.company); if (!k) continue; if (!jobs.has(k)) jobs.set(k, []); jobs.get(k).push({ title: j.title, url: j.url, city: j.city }); }
  }
  return { companies, jobs };
}

// ---------- classifying one company ----------
// unhandled ATSs: host pattern -> slug, and a public job-list reader where one exists ({title, location, url})
const getJson = async (url, ms = 9000) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); try { const r = await fetch(url, { signal: c.signal, headers: { accept: 'application/json', 'user-agent': UA } }); if (!r.ok) return null; return await r.json().catch(() => null); } catch { return null; } finally { clearTimeout(t); } };
const getText = async (url, ms = 9000) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); try { const r = await fetch(url, { signal: c.signal, redirect: 'follow', headers: { accept: 'text/html,*/*;q=0.8', 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9,he;q=0.8' } }); const txt = r.ok ? (await r.text()).slice(0, 1500000) : ''; return { status: r.status, txt, final: r.url || url }; } catch (e) { return { status: 0, txt: '', err: String(e && e.message || e).slice(0, 80), final: url }; } finally { clearTimeout(t); } };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const JUNK = /^(www|app|api|embed|jobs|careers|career|apply|static|cdn|assets|images|img|support|help|blog)$/i;
export const PILE2 = {
  bamboohr: { re: /([a-z0-9-]+)\.bamboohr\.com/i, read: async s => { const j = await getJson(`https://${s}.bamboohr.com/careers/list`); return j && Array.isArray(j.result) ? j.result.map(x => ({ title: x.jobOpeningName, location: [x.location && x.location.city, x.location && x.location.state, x.location && x.location.country].filter(Boolean).join(', '), url: `https://${s}.bamboohr.com/careers/${x.id}` })) : null; } },
  recruitee: { re: /([a-z0-9-]+)\.recruitee\.com/i, read: async s => { const j = await getJson(`https://${s}.recruitee.com/api/offers/`); return j && Array.isArray(j.offers) ? j.offers.map(x => ({ title: x.title, location: [x.city, x.country].filter(Boolean).join(', ') || x.location, url: x.careers_url })) : null; } },
  breezy: { re: /([a-z0-9-]+)\.breezy\.hr/i, read: async s => { const j = await getJson(`https://${s}.breezy.hr/json`); return Array.isArray(j) ? j.map(x => ({ title: x.name, location: x.location && (x.location.name || [x.location.city, x.location.country && x.location.country.name].filter(Boolean).join(', ')), url: x.url })) : null; } },
  workable: { re: /(?:apply\.workable\.com\/|([a-z0-9-]+)\.workable\.com)([a-z0-9-]*)/i, slug: m => m[1] && !/^apply$/i.test(m[1]) ? m[1] : m[2], read: async s => { const j = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${s}`); return j && Array.isArray(j.jobs) ? j.jobs.map(x => ({ title: x.title, location: [x.city, x.state, x.country].filter(Boolean).join(', '), url: x.url || x.shortlink })) : null; } },
  pinpoint: { re: /([a-z0-9-]+)\.pinpointhq\.com/i, read: async s => { const j = await getJson(`https://${s}.pinpointhq.com/postings.json`); return j && Array.isArray(j.data) ? j.data.map(x => ({ title: x.title, location: x.location && (x.location.name || [x.location.city, x.location.country].filter(Boolean).join(', ')), url: x.url })) : null; } },
  personio: { re: /([a-z0-9-]+)\.jobs\.personio\.(?:de|com)/i, read: async s => { const r = await getText(`https://${s}.jobs.personio.de/xml`); if (r.status !== 200) return null; return [...r.txt.matchAll(/<position>([\s\S]*?)<\/position>/g)].map(m => ({ title: ((m[1].match(/<name>([\s\S]*?)<\/name>/) || [])[1] || '').trim(), location: ((m[1].match(/<office>([\s\S]*?)<\/office>/) || [])[1] || '').trim(), url: `https://${s}.jobs.personio.de/job/${((m[1].match(/<id>(\d+)<\/id>/) || [])[1] || '')}` })); } },
  teamtailor: { re: /([a-z0-9-]+)\.teamtailor\.com/i, read: async s => { const r = await getText(`https://${s}.teamtailor.com/jobs.rss`); if (r.status !== 200 || !/<item>/.test(r.txt)) return null; return [...r.txt.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => ({ title: ((m[1].match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '').trim(), location: ((m[1].match(/<(?:tt:)?location[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:tt:)?location>/) || [])[1] || '').trim(), url: ((m[1].match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '').trim() })); } },
  hibob: { re: /([a-z0-9-]+)\.careers\.hibob\.com/i, read: null },
  jobvite: { re: /jobs\.jobvite\.com\/([a-z0-9-]+)/i, read: null },
  jazzhr: { re: /([a-z0-9-]+)\.applytojob\.com/i, read: null },
  rippling: { re: /ats\.rippling\.com\/([a-z0-9-]+)/i, read: null },
  freshteam: { re: /([a-z0-9-]+)\.freshteam\.com/i, read: null },
  zoho: { re: /([a-z0-9-]+)\.zohorecruit\.(?:com|eu|in)/i, read: null },
};
export const PILE3 = /myworkdayjobs\.com|\.workday\.com|icims\.com|successfactors|\.taleo\.net|oraclecloud\.com|ultipro\.com|workforcenow\.adp\.com|avature\.net|eightfold\.ai|phenompeople|jobs\.sap\.com|wd\d\.myworkdaysite/i;
export function detectPile2(href) {
  for (const [ats, p] of Object.entries(PILE2)) { const m = String(href).match(p.re); if (!m) continue; const slug = p.slug ? p.slug(m) : m[1]; if (slug && !JUNK.test(slug)) return { ats, slug: slug.toLowerCase() }; }
  return null;
}
// every href / src / absolute URL in a page (regex only: the page is data, never run)
export function linksOf(html, base) {
  const out = new Set(); const abs = h => { try { return new URL(h.replace(/&amp;/g, '&'), base).href; } catch { return ''; } };
  for (const m of String(html).matchAll(/(?:href|src|data-src|action)\s*=\s*["']([^"'#][^"']*)["']/gi)) { const u = abs(m[1]); if (u) out.add(u); }
  for (const m of String(html).matchAll(/https?:\/\/[^"'\s<>\\)]+/g)) out.add(m[0]);
  // a Comeet widget's init object names the company uid in code, not in a URL
  if (/comeet/i.test(html)) for (const m of String(html).matchAll(/company[-_]uid["']?\s*[:=]\s*["']([0-9A-F]{2}\.[0-9A-F]{3})["']/gi)) out.add(`https://www.comeet.co/widget?company-uid=${m[1]}`);
  return [...out];
}
const CAREER_LINK = /career|jobs|join|positions|openings|hiring|work-with-us|we-are-hiring|%d7%9e%d7%a9%d7%a8%d7%95%d7%aa|%d7%a7%d7%a8%d7%99%d7%99%d7%a8%d7%94|משרות|קריירה|דרושים|הצטרפו/i;
// what one list of links says, best first: a handled board, then pile 2, then pile 3
export function judgeLinks(links) {
  let p2 = null, p3 = null, comeetUid = null;
  for (const h of links) {
    // Comeet widgets and their careers API carry the company uid (88.004) without the company slug; detect() misreads those
    const cu = String(h).match(/comeet\.com?\/(?:careers-api\/[\d.]+\/company\/|jobs\/[^/?#]+\/)?([0-9A-F]{2}\.[0-9A-F]{3})\b|company[-_]uid=([0-9A-F]{2}\.[0-9A-F]{3})/i);
    if (cu && /comeet\.co/i.test(h) && !/comeet\.com\/jobs\/[^/?#]+\/[0-9A-F]{2}\.[0-9A-F]{3}/i.test(h)) { comeetUid = comeetUid || cu[1] || cu[2]; continue; }
    const d = detect(h);
    if (d && HANDLED.includes(d.ats) && d.slug) {
      if (d.ats === 'comeet') { if (d.companyId) return { pile: 1, ats: 'comeet', slug: `${d.slug}/${d.companyId}`, via: h }; comeetUid = comeetUid || d.slug; continue; }
      return { pile: 1, ats: d.ats, slug: d.slug, via: h };
    }
    if (d && d.ats === 'workday') { p3 = p3 || { pile: 3, ats: 'workday', via: h }; continue; }
    const q = detectPile2(h); if (q) { if (HANDLED.includes(q.ats)) return { pile: 1, ...q, via: h }; p2 = p2 || { pile: 2, ...q, via: h }; continue; }
    if (PILE3.test(h)) p3 = p3 || { pile: 3, ats: (h.match(PILE3) || [''])[0].replace(/^\.|\.(com|net|ai)$/g, ''), via: h };
  }
  if (comeetUid && /^[0-9a-f]{2}\.[0-9a-f]{3}$/i.test(comeetUid)) return { pile: 1, ats: 'comeet', slug: null, uid: comeetUid, via: 'comeet uid' };
  return p2 || p3 || null;
}
const nameSlugs = (name, website) => {
  const host = String(website || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  const label = host.split('.')[0];
  const words = String(name || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(w => w && !/^(ltd|inc|llc|co|corp|israel|il)$/.test(w));
  return [...new Set([label, words.join(''), words.join('-')].filter(s => s && s.length >= 3 && !JUNK.test(s)))].slice(0, 3);
};
// one company -> { pile, ats, slug, via, line?, score? }
export async function classify(c, jobUrls = [], { guess = true } = {}) {
  // 1. what techmap itself says: explicit ATS ids, then the postings it lists
  if (c.greenhouseId) return { pile: 1, ats: 'greenhouse', slug: String(c.greenhouseId), via: 'techmap greenhouseId' };
  if (c.leverId) return { pile: 1, ats: 'lever', slug: String(c.leverId), via: 'techmap leverId' };
  if (c.comeetId && /\//.test(c.comeetId)) return { pile: 1, ats: 'comeet', slug: String(c.comeetId), via: 'techmap comeetId' };
  const fromJobs = judgeLinks(jobUrls); if (fromJobs && fromJobs.pile === 1 && fromJobs.slug) return { ...fromJobs, via: 'techmap posting' };
  if (c.breezyId) return { pile: 2, ats: 'breezy', slug: String(c.breezyId).toLowerCase(), via: 'techmap breezyId' };
  // 2. the careers URL by itself, then the page (careers page, else the home page and its careers link)
  const direct = c.careersUrl ? judgeLinks([c.careersUrl]) : null; if (direct && direct.slug !== null) return { ...direct, via: 'careersUrl' };
  let found = direct || null, gotPage = false, err = null;
  for (const start of [c.careersUrl, c.websiteUrl].filter(Boolean)) {
    const r = await getText(start);
    if (!r.txt) { err = err || `${r.status || r.err} ${start}`; continue; }
    gotPage = true;
    const links = linksOf(r.txt, r.final); const j = judgeLinks([r.final, ...links]);
    if (j && j.pile === 1 && j.slug) return { ...j, via: start };
    found = found || j;
    if (!found && start === c.careersUrl) found = { pile: 'own', via: start };   // a careers page of its own, no ATS link in it
    if (!found) {   // the home page: follow its careers link once
      const career = links.find(h => { try { const u = new URL(h); return CAREER_LINK.test(decodeURIComponent(u.pathname + u.hash)) || CAREER_LINK.test(u.hostname.split('.')[0]); } catch { return false; } });
      if (career && career !== start) { const r2 = await getText(career); if (r2.txt) { const j2 = judgeLinks([r2.final, ...linksOf(r2.txt, r2.final)]); if (j2 && j2.pile === 1 && j2.slug) return { ...j2, via: career }; found = found || j2 || { pile: 'own', via: career }; } }
    }
    if (found) break;
  }
  // a Comeet uid without the company slug: Comeet needs both; try name slugs against the real board
  if (found && found.pile === 1 && found.ats === 'comeet' && found.uid) {
    for (const s of nameSlugs(c.name, c.websiteUrl)) { const b = await probeBoard(`comeet ${s}/${found.uid}`); if (b.ok) return { pile: 1, ats: 'comeet', slug: `${s}/${found.uid}`, via: 'comeet uid + name slug' }; }
    found = { pile: 'own', ats: 'comeet', via: 'comeet uid, slug not found' };
  }
  // 3. slug guesses against the public APIs (cheap 404s; the same "no first-word guess" rule as the resolver)
  // (also for an own-looking careers page: many render their ATS list by script, so the page text shows no link)
  if ((!found || found.pile === 'own') && guess) {
    for (const s of nameSlugs(c.name, c.websiteUrl)) for (const ats of ['greenhouse', 'ashby', 'lever']) {
      const b = await probeBoard(`${ats} ${s}`);
      if (b.ok && b.jobs.length) return { pile: 1, ats, slug: s, via: 'slug guess' };
    }
  }
  if (found) return found;
  if (err && !gotPage) return { pile: 'error', via: err };
  return { pile: 'none', via: c.careersUrl || c.websiteUrl || 'no site' };
}

// ---------- the run ----------
const due = (e, now) => {
  if (!e) return true;
  const kind = e.pile === 1 ? (e.active ? 'active' : 'watch') : e.pile === 2 ? 'pile2' : e.pile === 3 ? 'pile3' : e.pile;
  return now - Date.parse(e.checkedAt || 0) > (RECHECK[kind] || 30) * DAY;
};
const SIZE = { xl: 0, l: 1, m: 2, s: 3, xs: 4 };
export function queueOf(companies, jobs, state, now = Date.now()) {
  const C = state.companies || {};
  const fresh = companies.filter(c => !C[c.id]), recheck = companies.filter(c => C[c.id] && due(C[c.id], now));
  const pri = c => (jobs.has(nameKey(c.name)) ? 0 : 10) + (SIZE[c.size] ?? 5);
  fresh.sort((a, b) => pri(a) - pri(b) || String(a.name).localeCompare(String(b.name)));
  recheck.sort((a, b) => Date.parse(C[a.id].checkedAt) - Date.parse(C[b.id].checkedAt));
  return [...fresh, ...recheck];
}
export function tallyOf(state) {
  const t = {};
  for (const [id, e] of Object.entries(state.companies || {})) {
    if (e.pile !== 2) continue;
    const o = t[e.ats] = t[e.ats] || { companies: 0, withRoles: 0, fitting: 0, reader: !!(PILE2[e.ats] && PILE2[e.ats].read), examples: [] };
    o.companies++; if ((e.fitting || []).length) o.withRoles++; o.fitting += (e.fitting || []).length;
    for (const f of (e.fitting || []).slice(0, 3)) if (o.examples.length < 8) o.examples.push({ company: e.name, title: f.title, url: f.url });
  }
  const ready = Object.entries(t).filter(([, o]) => o.fitting >= READY_AT).sort((a, b) => b[1].fitting - a[1].fitting).map(([ats, o]) => ({ ats, fitting: o.fitting, companies: o.withRoles }));
  return { at: new Date().toISOString(), readyAt: READY_AT, ready, byAts: t };
}

async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }

export async function run({ budgetMs = 12 * 60000, max = 400, dry = false, local = false, all = false, log = say } = {}) {
  const t0 = Date.now(); const now = Date.now(); const today = new Date().toISOString().slice(0, 10);
  const STATE = dry ? STATE_DRY : STATE_LIVE;
  const state = read(STATE, dry ? { ...read(STATE_LIVE, {}), companies: {}, runs: [] } : { companies: {}, runs: [] }); state.companies = state.companies || {}; state.runs = state.runs || [];
  const p = pull(state); if (!p.ok) log(`techmap pull failed: ${p.msg}`); if (!fs.existsSync(path.join(CACHE, 'companies'))) { write(STATE, state); return { ok: false, error: 'no techmap clone' }; }
  const { companies, jobs } = loadTechmap();
  const queue = queueOf(companies, jobs, state, now); const take = all ? queue : queue.slice(0, max);
  const rep = { at: new Date().toISOString(), companies: companies.length, queued: queue.length, checked: 0, piles: {}, newBoards: [], watch: 0, demoted: [], refused: [], errors: 0, budgetHit: false };
  const toAdd = [];
  let sinceSave = 0;
  await pool(take, 6, async c => {
    if (Date.now() - t0 > budgetMs) { rep.budgetHit = true; return; }
    const urls = (jobs.get(nameKey(c.name)) || []).map(j => j.url);
    const prev = state.companies[c.id];
    let e;
    try { e = await classify(c, urls, { guess: jobs.has(nameKey(c.name)) || ['xl', 'l', 'm'].includes(c.size) }); } catch (err) { e = { pile: 'error', via: String(err && err.message || err).slice(0, 120) }; }
    const entry = { name: c.name, size: c.size || null, checkedAt: new Date().toISOString(), pile: e.pile, ats: e.ats || null, slug: e.slug || null, via: String(e.via || '').slice(0, 200) };
    if (e.pile === 1 && e.slug) {
      entry.line = `${e.ats} ${e.slug}`;
      const b = await probeBoard(entry.line); const s = scoreJobs(b.ok ? b.jobs : []);
      entry.probe = { ok: b.ok, total: s.total, israelMatching: s.israelMatching, at: entry.checkedAt };
      entry.zeroDays = s.israelMatching ? [] : [...new Set([...((prev && prev.zeroDays) || []), today])];
      entry.active = !!(prev && prev.active);
      if (s.israelMatching >= 1 && !entry.active) toAdd.push({ id: c.id, line: entry.line, total: s.total, israelMatching: s.israelMatching, company: c.name });
      if (!s.israelMatching) rep.watch++;
      // demote a discover-added seed after 0 matches on two probes 7+ days apart
      if (entry.active && entry.zeroDays.length >= 2 && Date.parse(entry.zeroDays[entry.zeroDays.length - 1]) - Date.parse(entry.zeroDays[0]) >= 7 * DAY) rep.demoted.push({ id: c.id, line: entry.line });
    }
    if (e.pile === 2) {
      const rd = PILE2[e.ats] && PILE2[e.ats].read; let list = null;
      if (rd && e.slug) { try { list = await rd(e.slug); } catch { list = null; } }
      entry.reader = rd ? (list ? 'ok' : 'failed') : 'missing';
      entry.fitting = (list || []).filter(fitting).slice(0, 20).map(j => ({ title: String(j.title || '').slice(0, 120), location: String(j.location || '').slice(0, 80), url: String(j.url || '').slice(0, 300) }));
      entry.total = list ? list.length : null;
    }
    if (e.pile === 'error') rep.errors++;
    state.companies[c.id] = entry; rep.checked++; rep.piles[e.pile] = (rep.piles[e.pile] || 0) + 1;
    if (++sinceSave >= 25) { sinceSave = 0; write(STATE, state); }
  });
  // seed writes: adds (probed, >= 1 Israel match), then demotes. Pending boards from earlier runs (over the 40-a-run limit, or a board
  // save that failed) join this run's, best first, so nothing waits a week for its recheck.
  const inRun = new Set(toAdd.map(a => a.line));
  for (const [id, e] of Object.entries(state.companies)) if (e.pile === 1 && e.line && !e.active && e.probe && e.probe.israelMatching >= 1 && !inRun.has(e.line)) { inRun.add(e.line); toAdd.push({ id, line: e.line, total: e.probe.total, israelMatching: e.probe.israelMatching, company: e.name }); }
  toAdd.sort((a, b) => b.israelMatching - a.israelMatching);
  if (toAdd.length) {
    try {
      const r = await addProbed(toAdd, { by: 'discover', local, dry });
      rep.newBoards = r.added; rep.refused = r.refused.filter(x => !/already read/.test(x.why)).slice(0, 20);
      if (!dry) for (const a of toAdd) if (r.added.includes(a.line) || r.refused.some(x => x.line === a.line && /already read/.test(x.why))) { state.companies[a.id].active = true; state.companies[a.id].activeSince = state.companies[a.id].activeSince || rep.at; }
    } catch (err) { rep.refused.push({ why: `board refused the save: ${String(err.message).slice(0, 120)}` }); }
  }
  if (rep.demoted.length) {
    const added = new Set(seedsState().adds.filter(a => a.by === 'discover').map(a => a.line));
    const lines = rep.demoted.map(d => d.line).filter(l => added.has(l));   // never a hand-added seed
    try { const r = await removeLines(lines, { local, dry }); for (const d of rep.demoted) if (r.removed.includes(d.line)) { state.companies[d.id].active = false; state.companies[d.id].zeroDays = []; } rep.demoted = r.removed; } catch (err) { rep.refused.push({ why: `demote refused: ${String(err.message).slice(0, 120)}` }); rep.demoted = []; }
  }
  const checkedAll = Object.keys(state.companies).length;
  rep.sweep = { checked: checkedAll, of: companies.length, pct: Math.round(100 * checkedAll / Math.max(1, companies.length)) };
  rep.ms = Date.now() - t0; rep.dry = dry;
  state.runs.unshift({ at: rep.at, checked: rep.checked, newBoards: rep.newBoards.length, demoted: rep.demoted.length, errors: rep.errors, sweep: rep.sweep, pulledAt: state.pulledAt || null, pullError: state.pullError || null });
  state.runs = state.runs.slice(0, 120);
  const tally = tallyOf(state); write(STATE, state); write(dry ? LAST.replace(/\.json$/, '.dry.json') : LAST, rep); write(dry ? TALLY.replace(/\.json$/, '.dry.json') : TALLY, tally);
  return { ok: true, rep, tally };
}

export function report(rep, tally, out = say) {
  out(`DISCOVER ${rep.at.slice(0, 16)}Z${rep.dry ? ' (dry)' : ''}: checked ${rep.checked} of ${rep.queued} queued (${Math.round(rep.ms / 1000)} s${rep.budgetHit ? ', budget hit' : ''}); sweep ${rep.sweep.checked}/${rep.sweep.of} (${rep.sweep.pct}%)`);
  out(`  piles: ${Object.entries(rep.piles).map(([k, v]) => `${k === '1' ? 'boards' : k === '2' ? 'no-recipe ATS' : k === '3' ? 'never' : k} ${v}`).join(', ') || '-'}`);
  out(`  new boards for the hunt: ${rep.newBoards.length}${rep.newBoards.length ? ` (${rep.newBoards.slice(0, 12).join(', ')}${rep.newBoards.length > 12 ? ', ...' : ''})` : ''}; on watch (0 Israel matches): ${rep.watch}; demoted: ${rep.demoted.length}`);
  if (rep.refused.length) out(`  not added: ${rep.refused.slice(0, 6).map(x => `${x.line || ''} ${x.why}`.trim()).join('; ')}`);
  const by = Object.entries(tally.byAts).sort((a, b) => b[1].fitting - a[1].fitting || b[1].companies - a[1].companies);
  out(`  ATS without a recipe: ${by.map(([a, o]) => `${a} ${o.companies} co / ${o.fitting} fitting${o.reader ? '' : ' (no reader)'}`).join(', ') || '-'}`);
  out(`  READY for a recipe (${READY_AT}+ fitting open roles): ${tally.ready.length ? tally.ready.map(r => `${r.ats} (${r.fitting} roles at ${r.companies} companies)`).join(', ') : 'none'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (flag('--report')) { const rep = read(LAST, null); if (!rep) { say('no discover run yet'); process.exit(1); } report(rep, read(TALLY, { ready: [], byAts: {} })); process.exit(0); }
  const b = String(arg('--budget', '12m')); const budgetMs = /m$/.test(b) ? parseFloat(b) * 60000 : /h$/.test(b) ? parseFloat(b) * 3600000 : parseFloat(b) * 1000;
  // live seed writes only once Eyal's deploy of the supply widening is out (config.json discoverLive: true); until then every run is a dry run
  const live = read(path.join(ROOT, 'config.json'), {}).discoverLive === true;
  const dry = flag('--dry') || (!live && !flag('--local'));
  if (dry && !flag('--dry')) say('discoverLive is off in config.json: dry run (nothing written to the board)');
  const r = await run({ budgetMs: flag('--all') ? Math.max(budgetMs, 6 * 3600000) : budgetMs, max: Number(arg('--max', 400)), dry, local: flag('--local'), all: flag('--all') });
  if (!r.ok) { say(`discover failed: ${r.error}`); process.exit(2); }
  report(r.rep, r.tally); process.exit(0);
}
