// Run logger: one text log per run in logs/<runId>.log plus one JSON line per run in logs/runs.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './board.mjs';

export const LOGS = path.join(ROOT, 'logs');
fs.mkdirSync(LOGS, { recursive: true });

// local date + time with seconds, so two runs never share a log file and the date is the one Eyal sees on the clock
export function makeRunId(prefix = 'run') {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return `${prefix}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export class Log {
  constructor(runId) { this.runId = runId; this.file = path.join(LOGS, `${runId}.log`); this.lines = []; }
  line(msg, card) {
    const t = new Date().toISOString().slice(11, 19);
    const s = `${t} ${card ? `[${card}] ` : ''}${msg}`;
    this.lines.push(s); console.log(s);
    try { fs.appendFileSync(this.file, s + '\n'); } catch { /* disk hiccup: never let logging kill a run */ }
  }
  cardLog(card) { return this.lines.filter(l => l.includes(`[${card}]`)).join('\n').slice(-4000); }
  finish(summary) {
    try { fs.appendFileSync(path.join(LOGS, 'runs.jsonl'), JSON.stringify({ runId: this.runId, at: new Date().toISOString(), ...summary }) + '\n'); } catch { /* ignore */ }
  }
}
