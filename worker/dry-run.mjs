// Dry run of ONE recipe on ONE form, outside the board: open, fill, attach the CV, screeners, gate, screenshot. NEVER clicks submit.
// The reviewer and any session use it to prove a recipe fix before a scheduled tick proves it live.
//   node dry-run.mjs --url <form url> [--ats <recipe name>] [--cv <pdf path>] [--answers '{"Question": "Answer"}'] [--title "..."]
// Prints every step, the values that landed in the identity fields, the required fields still empty, and writes
// logs/dry-<ts>-filled.png (or -error.png). Exit 0 when the gate passed, 1 otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { attach } from './lib/browser.mjs';
import { loadConfig } from './lib/board.mjs';
import { recipeFor } from './recipes/index.mjs';
import { emptyRequired, sleep, setFieldHook, setPageHook } from './lib/forms.mjs';
import { Obs } from './lib/obs.mjs';

const argv = process.argv.slice(2); const arg = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : ''; };
const url = arg('--url'); if (!url) { console.error('need --url'); process.exit(2); }
const { profile, cfg } = loadConfig([], { defaultLive: true });
const ats = arg('--ats'); const cvArg = arg('--cv');
const pdf = cvArg || (() => { const dir = cfg.cvsDir; const first = fs.existsSync(dir) ? fs.readdirSync(dir).map(d => path.join(dir, d, 'CV.pdf')).find(f => fs.existsSync(f)) : null; return first || cfg.cvFallback || ''; })();
let answers = {}; try { answers = arg('--answers') ? JSON.parse(arg('--answers')) : {}; } catch { console.error('bad --answers json'); process.exit(2); }
const card = { title: arg('--title') || 'dry run', apply: { url, ats, title: arg('--title') || '', screeners: Object.keys(answers).map(q => ({ q, type: 'text', options: [] })), answers, cv: 'dry' } };
const recipe = recipeFor(card); if (!recipe) { console.error(`no recipe matches ${url}${ats ? ` / ats ${ats}` : ''}`); process.exit(2); }
const log = m => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
log(`recipe ${recipe.name} | cv ${pdf || '(none)'} | answers ${Object.keys(answers).length}`);
fs.mkdirSync('logs', { recursive: true }); const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const { ctx, close } = await attach({ log, offscreen: true, keepOpen: true });
const page = await ctx.newPage(); let code = 1;
const sources = {}; setFieldHook(rec => { for (const k of [rec.field, rec.label, rec.selector]) if (k) sources[k] = rec.source; });
const obs = new Obs(`dry-${ts}`, { dry: true }); setPageHook(s => obs.formSnapshot(s, 'dry', { company: 'dry run', sources, partial: true }));
try {
  const scope = await recipe.open(page, card, log, { dry: true, pdf }); log('open ok: ' + page.url());
  if (recipe.fill) await recipe.fill(scope, card, profile, log);
  if (recipe.attachCv) { if (!pdf) throw new Error('no CV pdf to attach (--cv)'); log('attach: ' + await recipe.attachCv(scope, page, pdf, log)); }
  if (recipe.screeners) await recipe.screeners(scope, card, log);
  const empty = await emptyRequired(scope); log('required still empty (generic check): ' + (empty.length ? empty.join(', ') : 'none'));
  // the same form record a live tick keeps (evidence/dry/<ts>-form.json): proves the snapshot reads what the screenshot shows
  const snap = await obs.formSnapshot(scope, 'dry', { company: 'dry run', sources });
  const req = (obs.lastFields || []).filter(f => f.visible && f.required && f.type !== 'file');
  log(`form record ${snap}: ${(obs.lastFields || []).filter(f => f.visible).length} visible fields, required with no value: ${req.filter(f => !f.final || f.final === 'off').map(f => f.label || f.id).join(', ') || 'none'}`);
  for (const f of (obs.lastFields || []).filter(f => f.visible && f.type !== 'hidden')) log(`  ${f.page ? `p${f.page} ` : ''}${(f.label || f.id || f.name).slice(0, 60)}${f.required && !/\*\s*$/.test(f.label) ? '*' : ''} = ${String(f.final || '').slice(0, 60)} [${f.source}]`);
  if (recipe.gate) await recipe.gate(scope, log); else log('(recipe has no gate)');
  await sleep(800);
  await page.screenshot({ path: `logs/dry-${ts}-filled.png`, fullPage: true }).catch(() => {});
  if (recipe.reveal) { const vis = await (async () => { try { const b = scope.locator('#submit_app, button[type=submit]:has-text("Submit"), button:has-text("Submit application"), input[type=submit]').first(); return await b.isVisible(); } catch { return false; } })(); log('submit button visible after the screenshot: ' + vis); const sb = await recipe.reveal(scope, page); log('submit button reachable (reveal ok, not clicked); stable for a normal click: ' + (recipe.stable ? await recipe.stable(sb) : 'n/a') + (recipe.stable ? ' (false = submit() uses the DOM click)' : '')); }   // Lucerne 24 Oct: the tab flipped after the screenshot
  log(`DRY RUN PASSED - not submitting. Screenshot logs/dry-${ts}-filled.png`); code = 0;
} catch (e) {
  if (e.kind === 'dry') { log(`DRY RUN stopped on purpose before the first click: ${e.message}`); code = 0; }
  else { log(`DRY RUN FAILED (${e.kind || 'error'}): ${String(e.message).slice(0, 400)}`); await page.screenshot({ path: `logs/dry-${ts}-error.png`, fullPage: true }).catch(() => {}); }
}
await page.close().catch(() => {}); await close(); process.exit(code);
