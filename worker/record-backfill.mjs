// One-off (idempotent): post an application record (board record.mjs) for every run that clicked submit before 25 Oct 2026, from the
// local evidence: obs/evidence/<roleId>/<run>-form.json + -request.json + -cv.pdf, applications/<slug>/<run>-*.png / -confirmed.txt.
// Old snapshots read only el.value, so a custom dropdown that shows a choice on screen has no value here: it is posted as
// "(see screenshot)" instead of a guess. Re-running replaces the same records (key roleId/runId).
//   node record-backfill.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, Board, ROOT } from './lib/board.mjs';
import { EVIDENCE, sha256File } from './lib/obs.mjs';

const dry = process.argv.includes('--dry');
const { board: base, key, cfg } = loadConfig([], { defaultLive: true });
const board = new Board(base, key);
const st = await board.state();
const APPS = cfg.applicationsDir;
const shotsOf = run => { const out = []; for (const d of fs.readdirSync(APPS, { withFileTypes: true })) if (d.isDirectory()) for (const f of fs.readdirSync(path.join(APPS, d.name))) if (f.startsWith(run + '-') && /\.png$/.test(f)) out.push(`applications/${d.name}/${f}`); return out; };
const confirmOf = shots => { const c = shots.find(s => /-confirmed\.png$/.test(s)); if (!c) return ''; try { return fs.readFileSync(path.join(path.dirname(APPS), c.replace(/\.png$/, '.txt')), 'utf8').split(/\r?\n/).slice(4).join(' ').trim(); } catch { return ''; } };
let posted = 0, skipped = 0;
for (const roleId of fs.readdirSync(EVIDENCE)) {
  const dir = path.join(EVIDENCE, roleId); if (!fs.statSync(dir).isDirectory() || roleId === 'dry') continue;
  const r = st.roles.find(x => x.id === roleId); if (!r) { skipped++; continue; }
  const co = st.companies.find(x => x.id === r.companyId) || {};
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('-request.json'))) {
    const run = f.replace('-request.json', '');
    let req, form; try { req = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!req.clicked) continue;
    try { form = JSON.parse(fs.readFileSync(path.join(dir, `${run}-form.json`), 'utf8')); } catch { form = { fields: [] }; }
    const fields = (form.fields || []).filter(x => !x.error && (x.visible || x.type === 'file') && x.type !== 'hidden' && (x.label || x.value)).map(x => {
      const final = x.final || (x.type === 'file' ? x.value : x.checked !== undefined ? (x.checked ? 'on' : 'off') : (x.selected || x.value || ''));
      const combo = !final && x.required && x.tag === 'input' && x.type !== 'checkbox' && x.type !== 'radio';
      return { label: x.label || x.name || x.id, final: combo ? '(see screenshot)' : final, required: !!x.required, source: combo ? 'screenshot' : x.source, type: x.type };
    });
    const a = r.apply || {}; const pdf = path.join(dir, `${run}-cv.pdf`);
    const outcome = run === a.runId || !a.runId ? ({ submitted: 'submitted', confirmed: 'submitted', unverified: 'unverified', failed: 'failed', blocked: 'blocked' }[a.status] || 'submitted') : 'unverified';
    const shots = shotsOf(run);
    const rec = { roleId, runId: run, at: req.at || form.at, company: co.name || req.company, title: r.title, url: a.url, ats: a.ats, outcome, clicked: true,
      cv: { version: a.cv, title: a.title || r.title, sha256: fs.existsSync(pdf) ? sha256File(pdf) : '', file: fs.existsSync(pdf) ? `obs/evidence/${roleId}/${run}-cv.pdf` : '' },
      fields, confirmText: confirmOf(shots), screenshots: shots, backfilled: true };
    if (dry) { console.log(`${run} ${rec.company} | ${rec.outcome} | ${fields.length} fields | ${fields.filter(x => x.final === '(see screenshot)').length} from screenshot`); posted++; continue; }
    const res = await board.record(rec, { log: m => console.log(m) });
    if (res.ok) posted++; else skipped++;
  }
}
console.log(`${dry ? 'would post' : 'posted'} ${posted}, skipped ${skipped}`);
