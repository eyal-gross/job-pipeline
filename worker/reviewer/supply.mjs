// Reviewer helper: the SUPPLY side of the loop (lever 1 of reviewer-levers-2026-10-22.md). Read-only.
//   node worker/reviewer/supply.mjs            last 7 hunt runs: seen per source, dropped by reason, offered, kept; sorter drops;
//                                                    14-day yield per source; the board lines the hunt reads; rule-based flags at the end
//   node worker/reviewer/supply.mjs --json     the same as JSON (for scripts)
// Numbers come from the board's hunt.runs (brief text parsed the way app.js systemData() does) and from obs.db when it is there.
// The key is read from the pipeline .env by lib/board.mjs; never printed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Board, loadConfig } from '../lib/board.mjs';
import { sourcesOf, scoreDay } from './supply-score.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const flags = new Set(process.argv.slice(2));
const { board: base, key } = loadConfig([], { defaultLive: true });
const st = await new Board(base, key).state();
const h = st.hunt || {}; const DAY = 86400000; const now = Date.now();
const SOURCES = ['drushim', 'alljobs', 'linkedin', 'techmap', 'boards'];   // techmap since 26 Oct 2026 (supply widening item 2)
const boardsRead = run => { const m = (run.brief || '').match(/boards (\d+)\/(\d+)/); return m ? { read: Number(m[1]), of: Number(m[2]) } : null; };
const refusedLinkedin = run => /searches refused/.test(run.brief || '') || (run.errors || []).some(e => /^linkedin/.test(e));

// ---- runs, last 7 nights ----
const runs = (h.runs || []).filter(r => now - Date.parse(r.at) < 7 * DAY && !r.noop).slice(0, 7);
const nights = runs.map(r => ({ runId: r.runId, at: r.at, src: sourcesOf(r), boards: boardsRead(r), found: (r.funnel && r.funnel.found) || 0, dropped: (r.funnel && r.funnel.dropped) || {}, offered: (r.brief || '').match(/(\d+) offered to the sorter/) ? Number((r.brief || '').match(/(\d+) offered to the sorter/)[1]) : null, kept: r.candidates || 0, known: (r.brief || '').match(/(\d+) known dropped before the cap/) ? Number((r.brief || '').match(/(\d+) known dropped before the cap/)[1]) : null, errors: (r.errors || []).length, linkedinRefused: refusedLinkedin(r), sorterBrief: ((r.brief || '').match(/Sorter:\s*(.*)$/) || [])[1] || '' }));
const sum = (f) => nights.reduce((n, x) => n + (f(x) || 0), 0);
const avg = (f) => nights.length ? sum(f) / nights.length : 0;
const drops = {}; nights.forEach(n => Object.entries(n.dropped).forEach(([k, v]) => { drops[k] = (drops[k] || 0) + v; }));
const cheapDrops = Object.entries(drops).filter(([k]) => !/^sorter:/.test(k)).sort((a, b) => b[1] - a[1]);
const sorterDrops = Object.entries(drops).filter(([k]) => /^sorter:/.test(k)).map(([k, v]) => [k.replace(/^sorter:/, ''), v]).sort((a, b) => b[1] - a[1]);

// ---- item-level sorter drops from obs.db (when collected) ----
let sorterItems = [];
try {
  const { openDb } = await import('../../obs/lib.mjs');
  const db = openDb({ readonly: true });
  sorterItems = db.prepare(`SELECT ts, item, reason, json_extract(payload,'$.title') AS title, json_extract(payload,'$.ats') AS ats FROM events WHERE type='decision' AND actor='agent:sorter' AND json_extract(payload,'$.step')='sort' AND item IS NOT NULL AND ts > datetime('now','-7 days') ORDER BY ts DESC LIMIT 60`).all();
  db.close();
} catch { /* obs.db missing or not collected: the aggregate counts above still stand */ }

// ---- 14-day yield per source: kept -> queued -> sent, by company.hunt.source ----
const co = id => st.companies.find(c => c.id === id) || {};
const tierOf = r => r.tier || co(r.companyId).tier || 'real';
const a = r => r.apply || {};
const queuedAt = r => a(r).approvedAt || a(r).startedAt || (['submitted', 'confirmed', 'failed', 'blocked'].includes(a(r).status) ? (a(r).submittedAt || a(r).failedAt || a(r).blockedAt) : '');
const sentAt = r => a(r).submittedAt || (a(r).status === 'confirmed' ? a(r).confirmedAt : '');
const kept14 = st.roles.filter(r => a(r).foundAt && now - Date.parse(a(r).foundAt) < 14 * DAY && tierOf(r) === 'practice' && a(r).status !== 'real');
const yieldBy = {}; kept14.forEach(r => { const s = (co(r.companyId).hunt || {}).source || '?'; const o = yieldBy[s] = yieldBy[s] || { source: s, kept: 0, queued: 0, sent: 0 }; o.kept++; if (queuedAt(r)) o.queued++; if (sentAt(r)) o.sent++; });
const yieldRows = Object.values(yieldBy).sort((x, y) => y.kept - x.kept);

// ---- the board lines the hunt reads ----
const seeds = String(h.seeds || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
const learned = Array.isArray(h.boards) ? h.boards : [];
const boardLines = [...new Set([...seeds, ...learned])];

// ---- flags ----
const capFound = (h.caps && h.caps.found) || 10;
const last3 = nights.slice(0, 3);
const flagsOut = [];
if (last3.length >= 2 && last3.filter(n => n.kept < capFound).length >= 2) flagsOut.push(`supply short: kept ${last3.map(n => n.kept).join('/')} on the last ${last3.length} nights, cap.found is ${capFound}`);
SOURCES.forEach(s => { const lastN = nights[0] ? (nights[0].src[s] || 0) : 0; const av = avg(n => n.src[s] || 0); if (nights.length >= 2 && lastN === 0 && av > 0) flagsOut.push(`source silent: ${s} saw 0 last night, 7-day average ${Math.round(av)}`); });
if (nights.some(n => n.linkedinRefused)) flagsOut.push(`linkedin refused: ${nights.filter(n => n.linkedinRefused).length} of ${nights.length} nights had LinkedIn searches refused from the cloud address`);
if (boardLines.length < 10) flagsOut.push(`boards thin: ${boardLines.length} board lines (${seeds.length} seeds + ${learned.length} learned); every own-ATS board the hunt knows adds roles the runner can submit`);
const bigDrop = cheapDrops[0]; if (bigDrop && nights.length && bigDrop[1] / Math.max(1, sum(n => n.found)) > 0.25) flagsOut.push(`filter heavy: "${bigDrop[0]}" dropped ${bigDrop[1]} of ${sum(n => n.found)} seen (${Math.round(100 * bigDrop[1] / sum(n => n.found))}%); worth a filter proposal for Eyal if titles like "Product Lead" are in it`);

// ---- supply score, one line per UTC day (supply widening item 3, 26 Oct 2026) ----
// score = new practice companies on the board that day + new board lines the hunt reads; the parts are kept for the digest and for
// alerts.mjs, which raises "supply-stalled" after two complete days at 0 (or every run of both days keeping under half of caps.found).
// --score prints today's line; --record also writes it to reviewer/supply-history.jsonl (today's line is rewritten on every run).
const HISTORY = path.join(HERE, 'supply-history.jsonl');
if (flags.has('--score') || flags.has('--record')) {
  const day = new Date().toISOString().slice(0, 10);
  const hist = (() => { try { return fs.readFileSync(HISTORY, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } })();
  const prev = hist.filter(x => x.day < day).slice(-1)[0] || null;
  const disc = (() => { try { return JSON.parse(fs.readFileSync(path.join(HERE, 'discover-state.json'), 'utf8')); } catch { return null; } })();
  const line = scoreDay(st, day, prev, disc);
  if (flags.has('--record')) fs.writeFileSync(HISTORY, [...hist.filter(x => x.day !== day), line].sort((a, b) => a.day.localeCompare(b.day)).slice(-120).map(x => JSON.stringify(x)).join('\n') + '\n');
  console.log(`SUPPLY SCORE ${day}: ${line.score} (new companies ${line.newCompanies}, new board lines ${line.newBoards}, ${line.boardLines} lines read) · runs ${line.runs.map(r => `${r.runId.replace(/^hunt-/, '')} kept ${r.kept}${r.known != null ? ` known ${r.known}` : ''}`).join(', ') || 'none yet'} · discover checked ${line.discovered}, added ${line.discoverAdds}, sweep ${line.sweepPct ?? '-'}%${prev ? ` · yesterday ${prev.score}` : ''}`);
  process.exit(0);
}

const out = { nights, drops: { cheap: cheapDrops, sorter: sorterDrops }, sorterItems, yield: yieldRows, boards: { seeds, learned }, caps: h.caps, flags: flagsOut };
if (flags.has('--json')) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }

console.log(`SUPPLY BRIEF (last ${nights.length} hunt runs, caps ${JSON.stringify(h.caps || {})})`);
console.log('night        drushim alljobs linkedin techmap boards  seen  known offered kept  errors');
for (const n of nights) console.log(`${n.runId.padEnd(20)} ${String(n.src.drushim ?? '-').padStart(5)} ${String(n.src.alljobs ?? '-').padStart(7)} ${String(n.src.linkedin ?? '-').padStart(8)} ${String(n.src.techmap ?? '-').padStart(7)}${String(n.boards ? `${n.src.boards ?? 0}(${n.boards.read}/${n.boards.of})` : (n.src.boards ?? '-')).padStart(10)} ${String(n.found).padStart(5)} ${String(n.known ?? '-').padStart(6)} ${String(n.offered ?? '-').padStart(7)} ${String(n.kept).padStart(4)}  ${n.errors}${n.linkedinRefused ? ' linkedin refused' : ''}`);
console.log(`averages: seen ${Math.round(avg(n => n.found))}, offered ${Math.round(avg(n => n.offered))}, kept ${Math.round(avg(n => n.kept))}`);
console.log('\nDropped by the cheap rules (7 nights): ' + (cheapDrops.map(([k, v]) => `${k} ${v}`).join(', ') || '-'));
console.log('Dropped by the sorter (7 nights):      ' + (sorterDrops.map(([k, v]) => `${k} ${v}`).join(', ') || '-'));
if (nights[0] && nights[0].sorterBrief) console.log('Sorter, last night: ' + nights[0].sorterBrief);
if (sorterItems.length) { console.log(`\nSorter item drops in obs (last 7 days, ${sorterItems.length}):`); sorterItems.slice(0, 25).forEach(x => console.log(`  ${String(x.ts).slice(5, 16)} ${String(x.item || '').slice(0, 30).padEnd(30)} ${String(x.title || '').slice(0, 40).padEnd(40)} ${x.reason || ''}`)); }
console.log('\nYield by source, 14 days (kept -> queued -> sent):');
yieldRows.forEach(o => console.log(`  ${o.source.padEnd(12)} ${o.kept} -> ${o.queued} -> ${o.sent}`));
console.log(`\nBoard lines the hunt reads: ${boardLines.length} (${seeds.length} seeds, ${learned.length} learned)`);
boardLines.forEach(l => console.log('  ' + l));
console.log('\nFLAGS:' + (flagsOut.length ? '' : ' none'));
flagsOut.forEach(f => console.log('  - ' + f));
