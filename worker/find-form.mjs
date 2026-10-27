// Form finder step (see lib/find-form.mjs for the method). Two uses:
//   node find-form.mjs --probe "<Company>|<title>|<site>|<domain>|<location>"   try one company, print the verdict, write nothing
//   node find-form.mjs [--dry] [--max N] [--live]                                 board mode: cards forfeited as LinkedIn-only
// Board mode is what the worker runs at the start of every tick (worker.mjs): for each card with apply.ats = linkedin, status skipped,
// reason "forfeited: manualOnly" and no formFinder note yet, find the company's own form. Found on a recipe ATS -> patch the card
// (status candidate + formFinder {url, ats}) so the board re-fires the preparer and queues it; the normal recipe then submits it on a later
// tick. Not found, or found on a portal without a recipe -> formFinder note with what was checked (and the URL, for Eyal), card stays skipped.
// One attempt per card, ever (the note is the marker). At most `max` cards per tick (default 2) to keep the tick short.
import { attach } from './lib/browser.mjs';
import { Board, loadConfig } from './lib/board.mjs';
import { findForm } from './lib/find-form.mjs';

const argv = process.argv.slice(2);
const probeIdx = argv.indexOf('--probe');
const { board: base, key, flags } = loadConfig(probeIdx >= 0 ? argv.filter((a, i) => i !== probeIdx && i !== probeIdx + 1) : argv, { defaultLive: true });
const max = flags.max || 2;
const say = m => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

export async function runFinder({ board, ctxFactory, max = 2, dry = false, workerId = 'finder', log = say }) {
  const st = await board.state();
  const isCandidate = r => r.apply && r.apply.status === 'skipped' && r.apply.ats === 'linkedin' && /manualOnly/i.test(r.apply.reason || '') && !r.apply.formFinder;
  const cards = st.roles.filter(isCandidate).slice(0, max);
  if (!cards.length) { log('finder: no LinkedIn-only cards waiting'); return { tried: 0, found: 0 }; }
  let ctx = null, close = null, found = 0;
  try {
    for (const r of cards) {
      const c = st.companies.find(x => x.id === r.companyId) || {};
      const title = r.apply.title || r.title;
      log(`finder: ${c.name} - "${title}" (${r.apply.location || '?'}), company site ${c.links || '?'}, domain ${(c.hunt && c.hunt.domain) || '?'}`);
      if (!ctx && ctxFactory) { const b = await ctxFactory(); ctx = b.ctx; close = b.close; }
      let res;
      try { res = await findForm({ ctx, name: c.name, site: c.links, domain: c.hunt && c.hunt.domain, title, location: r.apply.location, log }); }
      catch (e) { res = { found: false, ats: '', url: '', via: 'error', error: e.message, checked: [] }; }
      const note = { at: new Date().toISOString(), by: workerId, found: !!res.found, ats: res.ats || '', url: res.url || '', portal: res.portal || '', via: res.via, score: res.score ? Number(res.score.toFixed(2)) : undefined, matchedTitle: res.matchedTitle || '', checked: (res.checked || []).slice(0, 20), error: res.error || '' };
      const verdict = res.found ? `FOUND ${res.ats}: ${res.url}` : res.url && res.matchedTitle ? `found on ${res.portal || res.ats || 'an own portal'} (no recipe): ${res.url}` : res.url ? `own careers portal ${res.portal || ''} (no recipe), posting not matched by title: ${res.url}` : `not found (${(res.checked || []).length} checks)`;
      log(`finder: ${c.name} -> ${verdict}`);
      if (dry) continue;
      if (res.found) {
        const out = await board.patchRetry(r.id, { status: 'candidate', formFinder: note }, { workerId }, { log });
        if (out && out.error) { log(`finder: board refused ${c.name}: ${out.error}${out.detail ? ` (${out.detail})` : ''}`); if (/illegal transition/i.test(out.error)) { log('finder: the board does not accept finder results yet (hunt.mjs not deployed) - stopping for this tick'); break; } }
        else { found++; log(`finder: ${c.name} back to candidate with the ${res.ats} form; the board re-fires the preparer`); }
      } else {
        const reason = (res.url && res.matchedTitle ? `forfeited: own portal${res.portal ? ` (${res.portal})` : ''} - no recipe; form at ${res.url}` : res.url ? `forfeited: own careers portal${res.portal ? ` (${res.portal})` : ''} - no recipe, posting not matched by title; ${res.url}` : `forfeited: manualOnly - linkedin; own form not found (${(res.checked || []).length} checks)`).slice(0, 160);
        const out = await board.patchRetry(r.id, { formFinder: note, reason }, { workerId }, { log });
        if (out && out.error) log(`finder: board refused note for ${c.name}: ${out.error}`);
        else if (out && out.role && out.role.apply && !out.role.apply.formFinder) { log('finder: the board does not store finder notes yet (hunt.mjs not deployed) - stopping for this tick'); break; }
      }
    }
  } finally { if (close) await close(); }
  return { tried: cards.length, found };
}

if (probeIdx >= 0) {
  const [name, title, site, domain, location] = String(argv[probeIdx + 1] || '').split('|').map(s => s.trim());
  const { ctx, close } = await attach({ log: say, offscreen: true });
  try { const res = await findForm({ ctx, name, site, domain, title, location, log: say }); console.log(JSON.stringify(res, null, 1)); }
  finally { await close(); }
} else if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('find-form.mjs')) {
  const board = new Board(base, key);
  const r = await runFinder({ board, ctxFactory: () => attach({ log: say, offscreen: true }), max, dry: !!flags.dry, log: say });
  console.log(`finder done: tried ${r.tried}, found ${r.found}`);
}
