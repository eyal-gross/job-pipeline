// Worker-side observability (MONITORING-PLAN.md §2 "PC worker"): every tick writes canonical events to obs/raw/worker/<runId>.jsonl
// (the collector ingests them into obs.db) and stores an evidence bundle per attempt under obs/evidence/<trace_id>/.
// Events here mirror obs/lib.mjs makeEvent(): {ts, run_id, trace_id, actor, type, severity, entity_type, entity_id, outcome, duration_ms,
// error_class, error_cause, error_handling, payload, seq}. Nothing is ever updated; the worker only appends.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './board.mjs';

export const OBS_RAW = path.resolve(ROOT, '..', 'obs', 'raw', 'worker');
export const EVIDENCE = path.resolve(ROOT, '..', 'obs', 'evidence');
export const sha256File = p => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };

export class Obs {
  constructor(runId, { machine = '', dry = false } = {}) {
    this.runId = runId; this.machine = machine; this.dry = dry; this.seq = 0; this.spans = {};
    fs.mkdirSync(OBS_RAW, { recursive: true });
    this.file = path.join(OBS_RAW, `${runId}.jsonl`);
  }
  emit(ev) {
    const e = { ts: new Date().toISOString(), run_id: this.runId, actor: 'pc:worker', severity: 'info', ...ev, seq: ev.seq ?? `s${++this.seq}` };
    e.payload = { machine: this.machine, dry: this.dry, ...(ev.payload || {}) };
    try { fs.appendFileSync(this.file, JSON.stringify(e) + '\n'); } catch { /* never let telemetry break a run */ }
    return e;
  }
  // step timing: start() returns a function that emits step.end with the duration
  step(name, { trace_id = null, payload = {} } = {}) {
    const t0 = Date.now(); const span_id = `${name}-${t0.toString(36)}`;
    this.emit({ type: 'step.start', span_id, trace_id, entity_type: trace_id ? 'role' : 'worker', entity_id: trace_id || this.runId, payload: { step: name, ...payload } });
    return (outcome = 'ok', extra = {}) => this.emit({ type: 'step.end', span_id, trace_id, entity_type: trace_id ? 'role' : 'worker', entity_id: trace_id || this.runId, outcome, duration_ms: Date.now() - t0, payload: { step: name, ...payload, ...extra } });
  }
  error(e, { trace_id = null, step = '', handling = 'unhandled', payload = {} } = {}) {
    const cls = e && e.kind ? e.kind : (e && e.reason) || 'error';
    return this.emit({ type: 'error', severity: 'error', trace_id, entity_type: trace_id ? 'role' : 'worker', entity_id: trace_id || this.runId, outcome: 'fail', error_class: cls, error_cause: String(e && e.message || e).slice(0, 400), error_handling: handling, payload: { step, message: String(e && e.message || e).slice(0, 1000), stack: e && e.stack ? String(e.stack).split('\n').slice(0, 4).join(' | ') : undefined, ...payload } });
  }
  // one row per field the recipe set: what was typed where and from which source
  field(trace_id, { field, label = '', value, source, selector = '', kind = 'text', company = '' }) {
    return this.emit({ type: 'field.fill', trace_id, entity_type: 'role', entity_id: trace_id, payload: { company, field, label, value: String(value ?? ''), source, selector, kind } });
  }
  evidenceDir(trace_id) { const d = path.join(EVIDENCE, trace_id); fs.mkdirSync(d, { recursive: true }); return d; }
  // snapshot of every control in the form right before the click; saved as evidence/<trace>/<runId>-form.json and summarized in an event
  // partial: a multi-page form (SmartRecruiters "Next") keeps this page's fields and merges them into the final snapshot, tagged page 1, 2, ...
  async formSnapshot(scope, trace_id, { within = '', company = '', sources = {}, partial = false } = {}) {
    let fields = [];
    try {
      fields = await scope.evaluate((within) => {
        const anchor = within ? document.querySelector(within) : null;
        const root = (anchor && anchor.closest('form, [role=dialog], .modal, [class*="modal" i], .ReactModal__Content')) || document;
        const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return (r.width > 0 || r.height > 0) && cs.visibility !== 'hidden' && cs.display !== 'none'; };
        // aria-labelledby holds ids, not text: resolve them (Ashby / SmartRecruiters label their controls that way)
        const byIds = (el, a) => (el.getAttribute(a) || '').split(/\s+/).map(id => { const n = id && (el.getRootNode().getElementById ? el.getRootNode().getElementById(id) : document.getElementById(id)); return n ? n.innerText : ''; }).join(' ').trim();
        const hostLab = el => { const h = el.getRootNode && el.getRootNode().host; return h ? (h.getAttribute('label') || h.getAttribute('aria-label') || h.getAttribute('data-label') || '') : ''; };   // SmartRecruiters: <spl-input label="..."> around a shadow input
        const nearLab = el => { const box = el.closest('fieldset, [class*="field" i], [class*="question" i]'); const l = box && box.querySelector('legend, label'); return l ? l.innerText : ''; };
        const lab = el => (el.labels && el.labels[0] ? el.labels[0].innerText : (el.getAttribute('aria-label') || byIds(el, 'aria-labelledby') || hostLab(el) || nearLab(el) || el.placeholder || '')).trim().slice(0, 120);
        // every control, shadow roots included (SmartRecruiters renders its form inside them)
        const all = (r, sel, out = []) => { r.querySelectorAll(sel).forEach(n => out.push(n)); r.querySelectorAll('*').forEach(n => { if (n.shadowRoot) all(n.shadowRoot, sel, out); }); return out; };
        // what a custom dropdown shows once picked: react-select clears its search input and keeps the choice in a sibling node
        // (the same walk lib/forms.mjs uses for the submit gate); a hidden input next to it may carry the picked value too (Lever location)
        const shownOf = el => {
          let n = el;
          for (let i = 0; i < 6 && n; i++, n = n.parentElement) {
            if (i > 0 && n.querySelectorAll('input:not([type=hidden]), select, textarea').length > 1) break;   // reached a container of other fields: never borrow a neighbour's value
            const v = n.querySelector('[class*="single-value"], [class*="singleValue"], [class*="multi-value__label"], [class*="multiValue"]');
            if (v && v.innerText.trim()) return [...n.querySelectorAll('[class*="single-value"], [class*="singleValue"], [class*="multi-value__label"]')].map(x => x.innerText.trim()).filter(Boolean).join(', ');
            const h = n.querySelector('input[type=hidden][name]'); if (h && h.value && i > 0) return h.value;
          }
          return '';
        };
        const combo = el => el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete') || /select__input|react-select/.test(el.className + ' ' + el.id);
        const controls = all(root, 'input, select, textarea').map(el => ({ tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', id: el.id || '', label: lab(el), required: !!el.required || el.getAttribute('aria-required') === 'true',
          visible: vis(el), checked: el.type === 'checkbox' || el.type === 'radio' ? el.checked : undefined,
          value: el.type === 'file' ? [...(el.files || [])].map(f => `${f.name} (${f.size} bytes)`).join(', ') : el.type === 'password' ? '[redacted]' : String(el.value ?? '').slice(0, 300),
          selected: el.tagName === 'SELECT' ? (el.selectedOptions[0] && el.selectedOptions[0].text) : undefined,
          shown: el.tagName === 'INPUT' && combo(el) && !el.value ? shownOf(el).slice(0, 300) : undefined }))
          .filter(f => f.type !== 'hidden' || /^(question|job_application|cv|resume|selectedLocation)/i.test(f.name));
        // button pickers (Ashby selects, SmartRecruiters country code): the button text is the choice
        const buttons = all(root, 'button[aria-haspopup="listbox"], [role="combobox"]:not(input)').map(el => ({ tag: el.tagName.toLowerCase(), type: 'picker', name: el.getAttribute('name') || '', id: el.id || '', label: lab(el), required: el.getAttribute('aria-required') === 'true', visible: vis(el), value: '', shown: el.innerText.trim().slice(0, 300) }));
        return [...controls, ...buttons];
      }, within);
    } catch (e) { fields = [{ error: String(e.message).slice(0, 200) }]; }
    // final = what was submitted as a person would read it; source = which rule filled it (the fill hook keys by recipe name, label or selector)
    const norm = s => String(s || '').toLowerCase().replace(/[*:]/g, '').replace(/\s+/g, ' ').trim();
    const srcBy = {}; for (const [k, v] of Object.entries(sources)) srcBy[norm(k)] = v;
    for (const f of fields) {
      if (f.error) continue;
      f.final = f.type === 'file' ? f.value : f.checked !== undefined ? (f.checked ? 'on' : 'off') : (f.selected || f.shown || f.value || '');
      const k = [f.id, f.name, f.label, f.id && `#${f.id}`].map(norm).find(x => x && srcBy[x])
        || Object.keys(srcBy).find(x => x.length >= 4 && (norm(f.label).startsWith(x) || norm(f.id).includes(x)));   // 'location' -> "Location (City)", #candidate-location
      f.source = k ? srcBy[k] : (f.final && f.final !== 'off' ? 'unknown' : (f.required ? 'MISSING' : 'empty'));
    }
    this.pageNo = this.pageNo || 1;
    if (partial) { this.earlier = [...(this.earlier || []), ...fields.map(f => ({ ...f, page: this.pageNo }))]; this.pageNo++; return ''; }
    if (this.earlier) { fields = [...this.earlier, ...fields.map(f => ({ ...f, page: this.pageNo }))]; }
    this.earlier = null; this.pageNo = null;
    const file = path.join(this.evidenceDir(trace_id), `${this.runId}-form.json`);
    try { fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), run: this.runId, trace_id, company, fields }, null, 1)); } catch { /* ignore */ }
    this.emit({ type: 'form.snapshot', trace_id, entity_type: 'role', entity_id: trace_id, payload: { company, file, fields: fields.length, filled: fields.filter(f => f.final && f.final !== 'off').length, requiredEmpty: fields.filter(f => f.required && f.visible && (!f.final || f.final === 'off') && f.type !== 'file').map(f => f.label || f.name || f.id), summary: fields.filter(f => f.visible || f.type === 'file').map(f => `${f.label || f.name || f.id}=${f.final || ''}`).slice(0, 60) } });
    this.lastFields = fields;   // the worker turns these into the application record for the board
    return file;
  }
  // arm a listener BEFORE the submit click: records the first non-GET request to the form's host (method, url, status, timing, body size)
  armSubmitCapture(page, trace_id, { hostPattern = /./, company = '' } = {}) {
    const started = Date.now(); let done = false; const rec = { requests: [] };
    const onReq = async req => {
      if (done) return; if (req.method() === 'GET') return;
      const url = req.url(); if (!hostPattern.test(url)) return;
      if (/google|analytics|facebook|hotjar|segment|sentry|datadog|collect|gtm|doubleclick|clarity|optimizely|qualified|vwo/i.test(url)) return;
      const entry = { method: req.method(), url: url.slice(0, 300), at: Date.now() - started, bodyBytes: (req.postData() || '').length, bodyPreview: (req.postData() || '').replace(/[\r\n]+/g, ' ').slice(0, 600) };
      rec.requests.push(entry);
      try { const res = await req.response(); if (res) { entry.status = res.status(); entry.responseMs = Date.now() - started - entry.at; } } catch { /* navigation */ }
    };
    page.on('request', onReq);
    return async ({ clicked = true } = {}) => {
      await new Promise(r => setTimeout(r, 1500));
      done = true; try { page.off('request', onReq); } catch { /* ignore */ }
      const main = rec.requests.find(r => r.status) || rec.requests[0] || null;
      const file = path.join(this.evidenceDir(trace_id), `${this.runId}-request.json`);
      let pageUrl = '', title = ''; try { pageUrl = page.url(); title = await page.title(); } catch { /* closed */ }
      try { fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), run: this.runId, trace_id, company, clicked, pageUrl, title, requests: rec.requests }, null, 1)); } catch { /* ignore */ }
      this.emit({ type: 'submit.request', trace_id, entity_type: 'role', entity_id: trace_id, outcome: main && main.status && main.status < 400 ? 'ok' : (main ? 'fail' : 'none'), payload: { company, clicked, method: main && main.method, url: main && main.url, status: main && main.status, responseMs: main && main.responseMs, bodyBytes: main && main.bodyBytes, requests: rec.requests.length, pageUrl, title, file } });
      return main;
    };
  }
  // Playwright trace per attempt: start before open(), stop into evidence/<trace>/<runId>-trace.zip
  async traceStart(ctx) { try { await ctx.tracing.start({ screenshots: true, snapshots: true, sources: false }); return true; } catch (e) { this.emit({ type: 'log', severity: 'warn', payload: { message: `tracing.start failed: ${e.message.slice(0, 120)}` } }); return false; } }
  async traceStop(ctx, trace_id) { const file = path.join(this.evidenceDir(trace_id), `${this.runId}-trace.zip`); try { await ctx.tracing.stop({ path: file }); return file; } catch (e) { this.emit({ type: 'log', severity: 'warn', trace_id, payload: { message: `tracing.stop failed: ${e.message.slice(0, 120)}` } }); return ''; } }
  // freeze the CV that was sent: copy + sha256
  cvEvidence(trace_id, pdf, meta = {}) {
    const dir = this.evidenceDir(trace_id); const out = path.join(dir, `${this.runId}-cv.pdf`);
    try { fs.copyFileSync(pdf, out); } catch { /* ignore */ }
    const sha = sha256File(pdf);
    this.emit({ type: 'log', trace_id, entity_type: 'role', entity_id: trace_id, payload: { step: 'cv', message: `cv frozen ${out}`, pdf, copy: out, sha256: sha, bytes: (() => { try { return fs.statSync(pdf).size; } catch { return null; } })(), ...meta } });
    return { copy: out, sha256: sha };
  }
}
export function gitCommit(dir) { try { return fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim().replace(/^ref: /, '') ? require_git(dir) : ''; } catch { return ''; } }
function require_git(dir) { try { const head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim(); if (head.startsWith('ref: ')) return fs.readFileSync(path.join(dir, '.git', head.slice(5)), 'utf8').trim().slice(0, 12); return head.slice(0, 12); } catch { return ''; } }
export const recipeHash = file => { try { return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12); } catch { return ''; } };
