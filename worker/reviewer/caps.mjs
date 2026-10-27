// The ONLY way the scheduled reviewer changes the loop's caps. Ceilings are code (Eyal, 22 Oct 2026): perDay and prepared at most 20 (raised from 8 by Eyal 23 Oct),
// found at most 30, offered at most 60, nothing below 1. Never the kill switch, never autoQueue.
//   node worker/reviewer/caps.mjs                       show the caps
//   node worker/reviewer/caps.mjs --perDay 10 --prepared 10 [--found 12] [--offered 50] [--perHour 5]
import { Board, loadConfig } from '../lib/board.mjs';
const CEIL = { perDay: 20, prepared: 20, found: 30, offered: 60, perHour: 10 };   // raised by Eyal 23 Oct 2026 (was 8 / 8 / 15)
const argv = process.argv.slice(2); const want = {};
for (const k of Object.keys(CEIL)) { const i = argv.indexOf('--' + k); if (i >= 0) want[k] = Number(argv[i + 1]); }
const { board: base, key } = loadConfig(argv.filter(x => x === '--local' || x === '--live'), { defaultLive: true }); const board = new Board(base, key);
const st = await board.state(); const caps = (st.hunt && st.hunt.caps) || {};
console.log('caps now: ' + JSON.stringify(caps));
if (!Object.keys(want).length) process.exit(0);
for (const [k, v] of Object.entries(want)) { if (!Number.isInteger(v) || v < 1 || v > CEIL[k]) { console.log(`refused: ${k}=${v}, allowed 1..${CEIL[k]}`); process.exit(1); } }
const res = await board.settings({ caps: { ...caps, ...want } });
console.log('caps set: ' + JSON.stringify(res.hunt && res.hunt.caps));
