// Board client: reads the Job Pipeline state and patches apply statuses through the hunt function.
// The access key is read from board/.env at runtime and never logged.
// Worker additions: claim() / report() (one x-key action each), patchRetry() with an on-disk outbox so a submitted application is
// never left unrecorded on the board (that would break never-twice), replayOutbox() at the start of every worker tick.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const OUTBOX = path.join(ROOT, 'logs', 'outbox.jsonl');
export const RECORDS_OUTBOX = path.join(ROOT, 'logs', 'records-outbox.jsonl');
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function loadConfig(argv = process.argv.slice(2), { defaultLive = false } = {}) {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  for (const k of ['envFile', 'cvsDir', 'applicationsDir']) if (cfg[k] && !path.isAbsolute(cfg[k])) cfg[k] = path.resolve(ROOT, cfg[k]);   // config paths are relative to worker/
  const localPath = path.join(ROOT, 'config.local.json');
  const profile = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : null;
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') flags.dry = true;
    else if (a === '--live') flags.live = true;
    else if (a === '--local') flags.local = true;
    else if (a === '--fast') flags.fast = true;
    else if (a === '--max') flags.max = parseInt(argv[++i], 10);
    else if (a === '--role') flags.role = argv[++i];
    else if (a === '--board') flags.board = argv[++i];
    else if (a === '--url') flags.url = argv[++i];
    else if (a === '--once') flags.once = true;
  }
  const live = flags.live || (defaultLive && !flags.local);
  const board = flags.board || (live ? cfg.boardLive : cfg.boardLocal);
  const envText = fs.readFileSync(cfg.envFile, 'utf8');
  const key = (envText.match(/^PIPELINE_KEY=(.*)$/m) || [])[1]?.trim() || '';
  if (!key) throw new Error(`PIPELINE_KEY not found in ${cfg.envFile}`);
  return { cfg, profile, flags, board, key, max: Math.min(flags.max || cfg.maxPerRun, cfg.maxPerRun) };
}

export class Board {
  constructor(base, key) { this.base = base.replace(/\/$/, ''); this.key = key; }
  hdr() { return { 'content-type': 'application/json', 'x-key': this.key }; }
  async state() {
    const r = await fetch(`${this.base}/.netlify/functions/state`, { headers: this.hdr() });
    if (!r.ok) throw new Error(`board GET ${r.status}`);
    const d = await r.json();
    return d.state;
  }
  async role(id) { const st = await this.state(); const r = st.roles.find(x => x.id === id); return { st, r, c: r ? st.companies.find(x => x.id === r.companyId) : null }; }
  async post(body) {
    const r = await fetch(`${this.base}/.netlify/functions/hunt`, { method: 'POST', headers: this.hdr(), body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(`${body.action} -> ${r.status} ${d.error || ''} ${d.detail || ''}`.trim()), { status: r.status, body: d });
    return d;
  }
  async patch(roleId, patch, extra = {}) {
    try { return await this.post({ action: 'apply', roleId, patch, ...extra }); }
    catch (e) { throw Object.assign(new Error(`patch ${roleId} ${JSON.stringify(patch.status || patch)} -> ${e.message}`), { status: e.status, body: e.body }); }
  }
  // essential patch (submitted / unverified): retry with backoff, then park it in the outbox for the next tick. A 409 is final (the board
  // refused the move on purpose) and is returned, not retried.
  async patchRetry(roleId, patch, extra = {}, { tries = 6, log = () => {} } = {}) {
    const waits = [1000, 2000, 4000, 8000, 16000, 30000];
    for (let i = 0; i < tries; i++) {
      try { return await this.patch(roleId, patch, extra); }
      catch (e) {
        if (e.status && e.status < 500 && e.status !== 429) return { refused: true, error: e.message, status: e.status };
        log(`board patch failed (${i + 1}/${tries}): ${e.message}`);
        if (i < tries - 1) await sleep(waits[i]);
      }
    }
    fs.mkdirSync(path.dirname(OUTBOX), { recursive: true });
    fs.appendFileSync(OUTBOX, JSON.stringify({ at: new Date().toISOString(), roleId, patch, extra }) + '\n');
    log(`parked in the outbox: ${roleId} -> ${patch.status || 'patch'}`);
    return { parked: true };
  }
  // replay parked patches; keeps the ones that still fail (server errors), drops the ones the board refuses on purpose
  async replayOutbox(log = () => {}) {
    if (!fs.existsSync(OUTBOX)) return { replayed: 0, kept: 0 };
    const lines = fs.readFileSync(OUTBOX, 'utf8').split(/\r?\n/).filter(Boolean);
    const keep = []; let replayed = 0;
    for (const line of lines) {
      let it; try { it = JSON.parse(line); } catch { continue; }
      try { await this.patch(it.roleId, it.patch, it.extra || {}); replayed++; log(`outbox replayed: ${it.roleId} -> ${it.patch.status || 'patch'}`); }
      catch (e) { if (e.status && e.status < 500 && e.status !== 429) log(`outbox entry refused by the board, dropped: ${e.message}`); else keep.push(line); }
    }
    if (keep.length) fs.writeFileSync(OUTBOX, keep.join('\n') + '\n'); else fs.rmSync(OUTBOX, { force: true });
    return { replayed, kept: keep.length };
  }
  claim({ max, workerId, machine, runId }) { return this.post({ action: 'worker', claim: true, max, workerId, machine, runId }); }
  report({ workerId, machine, report }) { return this.post({ action: 'worker', workerId, machine, report }); }
  // application record (board record.mjs, 25 Oct 2026): what was put on the form. Never blocks a submit: 3 tries, then the records outbox.
  async record(rec, { log = () => {} } = {}) {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(`${this.base}/.netlify/functions/record`, { method: 'POST', headers: this.hdr(), body: JSON.stringify(rec) });
        const d = await r.json().catch(() => ({}));
        if (r.ok) return d;
        if (r.status < 500 && r.status !== 429) { log(`record refused by the board: ${r.status} ${d.error || ''}`); return { refused: true }; }
      } catch { /* network: retry */ }
      await sleep(1500 * (i + 1));
    }
    fs.mkdirSync(path.dirname(RECORDS_OUTBOX), { recursive: true });
    fs.appendFileSync(RECORDS_OUTBOX, JSON.stringify(rec) + '\n'); log(`record parked in the outbox: ${rec.roleId}`);
    return { parked: true };
  }
  async replayRecords(log = () => {}) {
    if (!fs.existsSync(RECORDS_OUTBOX)) return { replayed: 0, kept: 0 };
    const lines = fs.readFileSync(RECORDS_OUTBOX, 'utf8').split(/\r?\n/).filter(Boolean); fs.rmSync(RECORDS_OUTBOX, { force: true });
    let replayed = 0; for (const line of lines) { let rec; try { rec = JSON.parse(line); } catch { continue; } const r = await this.record(rec, { log }); if (!r.parked) replayed++; }
    return { replayed, kept: lines.length - replayed };
  }
  feed(source, roles, extra = {}) { return this.post({ action: 'feed', source, roles, ...extra }); }   // linkedin-feed.mjs (26 Oct 2026): rows for the finder's linkedin step
  settings(fields) { return this.post({ action: 'settings', by: 'claude-code', ...fields }); }   // caps / seeds / answerBank etc. (hunt.mjs settings action); the reviewer's seeds.mjs uses it
}

export const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'company';
