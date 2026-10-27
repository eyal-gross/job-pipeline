// The supply score and the stall rule (supply widening item 3, Eyal 26 Oct 2026), shared by reviewer/supply.mjs (writes the daily line to
// reviewer/supply-history.jsonl) and worker/alerts.mjs (raises supply-stalled / discover-stuck). Pure functions, no network.
//   score = new practice companies on the board that day + new board lines the hunt reads (the parts are kept for the digest)
const DAY = 86400000;
export const sourcesOf = run => { const o = {}; const re = /(drushim|alljobs|linkedin|techmap|boards)[^:;]*:\s*(\d+) roles seen/g; let m; while ((m = re.exec(run.brief || ''))) o[m[1]] = Number(m[2]); return o; };
const num = (brief, re) => { const m = String(brief || '').match(re); return m ? Number(m[1]) : null; };
export function scoreDay(st, day, prev, disc) {
  const h = st.hunt || {};
  const firstFound = c => { const hs = c.hunt || {}; return (Array.isArray(hs.history) && hs.history.length && hs.history[0].foundAt) || hs.foundAt || ''; };
  const newCompanies = (st.companies || []).filter(c => c.tier === 'practice' && c.autoAdded && String(firstFound(c)).slice(0, 10) === day).length;
  const lines = new Set([...String(h.seeds || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean), ...(Array.isArray(h.boards) ? h.boards : [])]).size;
  const runs = (h.runs || []).filter(r => String(r.at).slice(0, 10) === day && !r.noop).map(r => ({ runId: r.runId, kept: r.candidates || 0, offered: num(r.brief, /(\d+) offered to the sorter/), known: num(r.brief, /(\d+) known dropped before the cap/), src: sourcesOf(r) }));
  const discRuns = ((disc && disc.runs) || []).filter(r => String(r.at).slice(0, 10) === day);
  const newBoards = prev && Number.isInteger(prev.boardLines) ? lines - prev.boardLines : 0;
  const lastSweep = discRuns[0] || (disc && disc.runs && disc.runs[0]) || null;
  return { day, at: new Date().toISOString(), score: newCompanies + Math.max(0, newBoards), newCompanies, newBoards, boardLines: lines, runs, capFound: (h.caps && h.caps.found) || 10,
    discovered: discRuns.reduce((n, r) => n + (r.checked || 0), 0), discoverAdds: discRuns.reduce((n, r) => n + (r.newBoards || 0), 0), sweepPct: lastSweep && lastSweep.sweep ? lastSweep.sweep.pct : null };
}
// two complete days (today is still running, so it never counts) -> a stall, with the reason, or null
export function stalled(history, today) {
  const days = history.filter(x => x.day < today).slice(-2);
  if (days.length < 2) return null;
  if (days.every(d => d.score === 0)) return `supply score 0 on ${days.map(d => d.day).join(' and ')}: no new companies on the board and no new board lines`;
  if (days.every(d => d.runs.length && d.runs.every(r => r.kept < (d.capFound || 10) / 2))) return `every hunt run on ${days.map(d => d.day).join(' and ')} kept under half of caps.found (${days.flatMap(d => d.runs.map(r => r.kept)).join(' / ')} of ${days[1].capFound || 10})`;
  return null;
}
// discover itself stopped: the sweep is unfinished and no run checked a company in 48 h, or the techmap pull has failed for 48 h
export function discoverStuck(disc, now = Date.now()) {
  if (!disc) return null;
  const runs = disc.runs || [];
  const last = runs.find(r => r.checked > 0);
  const pct = runs[0] && runs[0].sweep ? runs[0].sweep.pct : 0;
  if (disc.pullError && (!disc.pulledAt || now - Date.parse(disc.pulledAt) > 2 * DAY)) return `the techmap copy has not updated for 48 h (${String(disc.pullError.msg || '').slice(0, 80)})`;
  if (pct < 100 && runs.length && (!last || now - Date.parse(last.at) > 2 * DAY)) return `discover has not checked a company for 48 h (sweep at ${pct}%)`;
  return null;
}
