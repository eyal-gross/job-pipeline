// Reviewer helper: the seed BOARDS the nightly hunt reads (hunt.seeds on the board, one "<ats> <slug>" per line; hunt-find.mjs
// boardsOf()). The one supply lever the reviewer may pull without a deploy (lever 1, approved by Eyal 22 Oct 2026).
//   node worker/reviewer/seeds.mjs --list                      seed lines + learned boards
//   node worker/reviewer/seeds.mjs --probe "greenhouse fabrikam"    read the public board: jobs, title matches, Israel matches (read-only)
//   node worker/reviewer/seeds.mjs --add "smartrecruiters Fabrikam2" probe, then append the line and save (refused without >= 1 matching Israel title)
//   node worker/reviewer/seeds.mjs --remove "lever acme"        only a line that probed 0 jobs on two different days (reviewer/seeds-state.json)
// Guards: max 10 adds per process, 200 seed lines, never a line the hunt already learned, exit 1 on a refusal, exit 2 on a board error.
// The key is read from the pipeline .env by lib/board.mjs; never printed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board, loadConfig } from '../lib/board.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(HERE, 'seeds-state.json');
// the board's own title and location rules, imported (26 Oct 2026: the hand-kept copy drifted twice), so a probe judges a board exactly
// the way the nightly hunt will
import { TITLE_EXCLUDE, TITLE_INCLUDE, ISRAEL } from '../../board/netlify/functions/hunt.mjs';
const ATS = ['greenhouse', 'ashby', 'lever', 'comeet', 'smartrecruiters', 'workable', 'bamboohr'];   // workable + bamboohr 26 Oct 2026
const MAX_ADDS = 10, MAX_LINES = 200;   // 150 -> 200 (Eyal, 27 Oct 2026); about 240 boards fit the night hour at 40 a tick, learned boards included

const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const norm = line => { const m = String(line || '').trim().match(/^(\w+)\s+(\S+)/); return m && ATS.includes(m[1].toLowerCase()) ? `${m[1].toLowerCase()} ${m[2]}` : null; };
const say = m => console.log(m);

async function fetchJson(url) { const t0 = Date.now(); try { const r = await fetch(url, { headers: { accept: '*/*', 'user-agent': 'Mozilla/5.0 (job-search seeds probe)' } }); const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch { /* html */ } return { status: r.status, j, txt, ms: Date.now() - t0 }; } catch (e) { return { status: 0, err: e.message, ms: Date.now() - t0 }; } }
const daysAgo = iso => iso ? (Date.now() - Date.parse(iso)) / 86400000 : null;

// Comeet company pages (www.comeet.com/jobs/<company>/<uid>) embed the positions as JSON: each object starts {"name": "<title>", "department": ...
// and carries "location": {"name": ...}, "time_updated" and "url_comeet_hosted_page". No href links on the page, so parse the JSON text.
export function parseComeet(html) {
  const starts = [...html.matchAll(/\{"name": "((?:[^"\\]|\\.)+)", "department": /g)]; const jobs = []; const seen = new Set();
  for (let i = 0; i < starts.length; i++) {
    const chunk = html.slice(starts[i].index, starts[i + 1] ? starts[i + 1].index : starts[i].index + 6000);
    const url = (chunk.match(/"url_comeet_hosted_page": "([^"]+)"/) || [])[1]; if (!url || seen.has(url)) continue; seen.add(url);
    const loc = (chunk.match(/"location": \{"name": "((?:[^"\\]|\\.)*)"/) || [])[1] || '';
    const upd = (chunk.match(/"time_updated": "([^"]+)"/) || [])[1];
    const unescape = t => { try { return JSON.parse('"' + t + '"'); } catch { return t; } };
    jobs.push({ title: unescape(starts[i][1]), location: unescape(loc), url, ageDays: upd ? (Date.now() - Date.parse(upd)) / 86400000 : null });
  }
  return jobs;
}
// -> { ok, status, jobs: [{title, location, url, ageDays}] }   (same sources as hunt-find.mjs readBoard0, plus smartrecruiters)
export async function probeBoard(line) {
  const [ats, slug] = line.split(' ');
  if (ats === 'greenhouse') { const r = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`); return { ok: r.status === 200 && r.j && Array.isArray(r.j.jobs), status: r.status || r.err, jobs: ((r.j && r.j.jobs) || []).map(x => ({ title: x.title, location: x.location && x.location.name, url: x.absolute_url, ageDays: daysAgo(x.updated_at || x.first_published) })) }; }
  if (ats === 'ashby') { const r = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=false`); return { ok: r.status === 200 && r.j && Array.isArray(r.j.jobs), status: r.status || r.err, jobs: ((r.j && r.j.jobs) || []).map(x => ({ title: x.title, location: x.location, url: x.jobUrl, ageDays: daysAgo(x.publishedAt) })) }; }
  if (ats === 'lever') { const r = await fetchJson(`https://api.lever.co/v0/postings/${slug}?mode=json`); return { ok: r.status === 200 && Array.isArray(r.j), status: r.status || r.err, jobs: (Array.isArray(r.j) ? r.j : []).map(x => ({ title: x.text, location: x.categories && x.categories.location, url: x.hostedUrl, ageDays: x.createdAt ? (Date.now() - x.createdAt) / 86400000 : null })) }; }
  if (ats === 'smartrecruiters') { const r = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`); return { ok: r.status === 200 && r.j && Array.isArray(r.j.content), status: r.status || r.err, jobs: ((r.j && r.j.content) || []).map(x => ({ title: x.name, location: x.location && (x.location.fullLocation || [x.location.city, x.location.country].filter(Boolean).join(', ')), url: `https://jobs.smartrecruiters.com/${slug}/${x.id}`, ageDays: daysAgo(x.releasedDate) })) }; }
  if (ats === 'comeet') { const r = await fetchJson(`https://www.comeet.com/jobs/${slug}`); const jobs = parseComeet(r.txt || ''); return { ok: r.status === 200 && jobs.length > 0, status: r.status || r.err, jobs }; }
  if (ats === 'workable') { const r = await fetchJson(`https://apply.workable.com/api/v1/widget/accounts/${slug}`); return { ok: r.status === 200 && r.j && Array.isArray(r.j.jobs), status: r.status || r.err, jobs: ((r.j && r.j.jobs) || []).map(x => ({ title: x.title, location: [x.city, x.state, x.country].filter(Boolean).join(', '), url: `https://apply.workable.com/${slug}/j/${x.shortcode}/apply/`, ageDays: daysAgo(x.published_on || x.created_at) })) }; }
  if (ats === 'bamboohr') { const r = await fetchJson(`https://${slug}.bamboohr.com/careers/list`); return { ok: r.status === 200 && r.j && Array.isArray(r.j.result), status: r.status || r.err, jobs: ((r.j && r.j.result) || []).map(x => ({ title: x.jobOpeningName, location: [x.location && x.location.city, x.location && x.location.state, x.atsLocation && x.atsLocation.country].filter(Boolean).join(', '), url: `https://${slug}.bamboohr.com/careers/${x.id}`, ageDays: null })) }; }
  return { ok: false, status: 'unknown ats', jobs: [] };
}
export function scoreJobs(jobs) {
  const titleOk = j => TITLE_INCLUDE.test(j.title || '') && !TITLE_EXCLUDE.test(j.title || '');
  const israel = j => ISRAEL.test(j.location || '') || ISRAEL.test(j.title || '');
  const matching = jobs.filter(titleOk), israelMatching = matching.filter(israel);
  return { total: jobs.length, matching: matching.length, israelMatching: israelMatching.length, israelAny: jobs.filter(israel).length, sample: israelMatching.slice(0, 5).map(j => `${j.title} (${j.location || '?'})`) };
}
async function probe(line) {
  const b = await probeBoard(line); const s = scoreJobs(b.jobs);
  say(`probe ${line}: ${b.ok ? 'ok' : 'FAILED ' + b.status} · jobs ${s.total} · title matches ${s.matching} · Israel+title ${s.israelMatching} · Israel any ${s.israelAny}`);
  s.sample.forEach(x => say('    ' + x));
  return { ...b, score: s };
}

const boardFor = local => { const { board: base, key } = loadConfig(local ? ['--local'] : [], { defaultLive: !local }); return new Board(base, key); };   // local = the localhost board (netlify dev :8899)
export const readState = () => { try { const s = JSON.parse(fs.readFileSync(STATE, 'utf8')); return { zeroProbes: {}, adds: [], removed: [], ...s }; } catch { return { zeroProbes: {}, adds: [], removed: [] }; } };
const writeState = s => fs.writeFileSync(STATE, JSON.stringify(s, null, 1));
export const seedLines = async board => { const st = await board.state(); const h = st.hunt || {}; return { seeds: String(h.seeds || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean), learned: Array.isArray(h.boards) ? h.boards : [], h }; };

// Discover's add path (supply widening item 3, 26 Oct 2026): lines it already probed (>= 1 Israel title match), up to MAX_DISCOVER_ADDS a run,
// the seed list capped at MAX_LINES. Every add is recorded with by: 'discover' so --revert-discover <date> can take a day's adds back.
export const MAX_DISCOVER_ADDS = 40;
export async function addProbed(items, { by = 'discover', local = false, dry = false } = {}) {
  const board = boardFor(local); const { seeds, learned } = await seedLines(board); const st = readState();
  const have = new Set([...seeds, ...learned].map(norm).filter(Boolean)); const next = [...seeds]; const added = [], refused = [];
  for (const it of items) {
    const line = norm(it.line);
    if (!line) { refused.push({ line: it.line, why: 'bad line' }); continue; }
    if (have.has(line)) { refused.push({ line, why: 'already read by the hunt' }); continue; }
    if (!(it.israelMatching >= 1)) { refused.push({ line, why: 'no Israel title match' }); continue; }
    if (added.length >= MAX_DISCOVER_ADDS) { refused.push({ line, why: `limit ${MAX_DISCOVER_ADDS} adds a run` }); continue; }
    if (next.length >= MAX_LINES) { refused.push({ line, why: `seeds at the ${MAX_LINES}-line limit` }); continue; }
    next.push(line); have.add(line); added.push(line);
    st.adds.push({ line, at: new Date().toISOString(), jobs: it.total ?? null, israelMatching: it.israelMatching, by, company: it.company || null });
  }
  if (added.length && !dry) { await board.settings({ seeds: next.join('\n') }); writeState(st); }
  return { added, refused, lines: next.length };
}
// Discover's demote path: a discover-added seed that probed 0 Israel matches twice, 7+ days apart, leaves the nightly list (it stays on
// discover's watch list and comes back when a match appears). Hand-added seeds are never touched here.
export async function removeLines(lines, { local = false, dry = false, why = 'demoted by discover' } = {}) {
  const board = boardFor(local); const { seeds } = await seedLines(board); const st = readState();
  const drop = new Set(lines.map(norm).filter(Boolean)); const next = seeds.filter(l => !drop.has(norm(l)));
  if (next.length === seeds.length) return { removed: [] };
  const removed = seeds.filter(l => drop.has(norm(l))).map(norm);
  if (!dry) { await board.settings({ seeds: next.join('\n') }); st.removed.push(...removed.map(line => ({ line, at: new Date().toISOString(), why }))); writeState(st); }
  return { removed };
}

async function main() {
  const board = boardFor(argv.includes('--local'));
  if (argv.includes('--list')) {
    const { seeds, learned } = await seedLines(board);
    say(`seeds (${seeds.length}):`); seeds.forEach(l => say('  ' + l));
    say(`learned by the resolver (${learned.length}, not editable here):`); learned.forEach(l => say('  ' + l));
    process.exit(0);
  }
  if (arg('--probe')) { const line = norm(arg('--probe')); if (!line) { say('bad line: want "<greenhouse|ashby|lever|comeet|smartrecruiters> <slug>"'); process.exit(2); } const r = await probe(line); process.exit(r.ok ? 0 : 2); }
  if (arg('--revert-discover')) {   // rollback for item 3: take back every line discover added on that day (YYYY-MM-DD)
    const day = arg('--revert-discover'); const st = readState(); const lines = st.adds.filter(a => a.by === 'discover' && String(a.at).slice(0, 10) === day).map(a => a.line);
    if (!lines.length) { say(`no discover adds on ${day}`); process.exit(1); }
    const r = await removeLines(lines, { local: argv.includes('--local'), why: `revert-discover ${day}` }); say(`removed ${r.removed.length} of ${lines.length} lines added by discover on ${day}`); process.exit(0);
  }
  if (arg('--add')) {
    const wanted = argv.flatMap((x, i) => x === '--add' ? [argv[i + 1]] : []).map(norm);
    if (wanted.some(x => !x)) { say('bad line: want "<ats> <slug>"'); process.exit(2); }
    if (wanted.length > MAX_ADDS) { say(`refused: ${wanted.length} adds, the limit is ${MAX_ADDS} per run`); process.exit(1); }
    const { seeds, learned } = await seedLines(board); const st = readState(); let added = 0;
    const next = [...seeds];
    for (const line of wanted) {
      if (next.map(norm).includes(line)) { say(`skip ${line}: already a seed`); continue; }
      if (learned.map(norm).includes(line)) { say(`skip ${line}: the hunt already learned this board`); continue; }
      const r = await probe(line);
      if (!r.ok) { say(`refused ${line}: board not readable (${r.status})`); st.zeroProbes[line] = [...new Set([...(st.zeroProbes[line] || []), new Date().toISOString().slice(0, 10)])]; continue; }
      if (r.score.israelMatching < 1) { say(`refused ${line}: no Israel-located title match (${r.score.matching} title matches, ${r.score.israelAny} Israel jobs)`); continue; }
      if (next.length >= MAX_LINES) { say(`refused ${line}: seeds at the ${MAX_LINES}-line limit`); break; }
      next.push(line); added++; st.adds.push({ line, at: new Date().toISOString(), jobs: r.score.total, israelMatching: r.score.israelMatching, by: 'reviewer' });
    }
    if (!added) { say('nothing added'); writeState(st); process.exit(1); }
    try { await board.settings({ seeds: next.join('\n') }); } catch (e) { say(`board refused the save: ${e.message}`); process.exit(2); }
    writeState(st); say(`saved: ${added} added, ${next.length} seed lines now`); process.exit(0);
  }
  if (arg('--remove')) {
    const line = norm(arg('--remove')); if (!line) { say('bad line'); process.exit(2); }
    const st = readState(); const days = st.zeroProbes[line] || [];
    const r = await probe(line); if (r.ok && r.score.total > 0) { say(`refused: ${line} still lists ${r.score.total} jobs`); process.exit(1); }
    const today = new Date().toISOString().slice(0, 10); st.zeroProbes[line] = [...new Set([...days, today])];
    if (st.zeroProbes[line].length < 2) { writeState(st); say(`not yet: ${line} probed empty on ${st.zeroProbes[line].length} day; a second empty probe on another day allows the remove`); process.exit(1); }
    const { seeds } = await seedLines(board); const next = seeds.filter(l => norm(l) !== line);
    if (next.length === seeds.length) { say(`${line} is not a seed line (learned boards are not editable here)`); process.exit(1); }
    try { await board.settings({ seeds: next.join('\n') }); } catch (e) { say(`board refused the save: ${e.message}`); process.exit(2); }
    delete st.zeroProbes[line]; writeState(st); say(`removed ${line}, ${next.length} seed lines now`); process.exit(0);
  }
  say('usage: --list | --probe "<ats> <slug>" | --add "<ats> <slug>" [--add ...] | --remove "<ats> <slug>" | --revert-discover YYYY-MM-DD   [--local]'); process.exit(2);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
