// Reviewer helper: put a card that FAILED BEFORE ANYTHING WAS SENT back in the queue after the cause was fixed (Eyal's standing
// "fix and try again at the same recipe", 21 Oct 2026).   node worker/reviewer/requeue.mjs <roleId> [--answer "Question=Answer"]...
// Refuses: unverified cards (a click happened), real-tier cards, cards already queued or sent. Goes failed/skipped/blocked -> prepared
// (byHuman, his standing rule) -> answers from the bank if given -> approved. The scheduled worker does the rest.
import { Board, loadConfig } from '../lib/board.mjs';
const argv = process.argv.slice(2); const id = argv.find(x => !x.startsWith('--'));
if (!id) { console.error('need <roleId>'); process.exit(2); }
const answers = {}; for (let i = 0; i < argv.length; i++) if (argv[i] === '--answer') { const [q, ...v] = String(argv[i + 1] || '').split('='); if (q && v.length) answers[q.trim()] = v.join('=').trim(); }
const { board: base, key } = loadConfig([], { defaultLive: true }); const board = new Board(base, key);
const { st, r, c } = await board.role(id); if (!r) { console.error('no such role'); process.exit(2); }
const a = r.apply || {}; const tier = r.tier || (c && c.tier) || 'real';
const say = (m) => console.log(m);
if (tier !== 'practice') { say(`refused: ${c && c.name} is ${tier} tier`); process.exit(1); }
if (a.status === 'unverified') { say(`refused: ${c.name} is unverified (a click happened); never retried`); process.exit(1); }
// a queued card whose answer is wrong (Proseware, 27 Oct: the preparer wrote "From a friend." where the bank says "Company careers page"): correct it in place
if (a.status === 'approved' && Object.keys(answers).length) { const res = await board.patchRetry(id, { answers: { ...(a.answers || {}), ...answers } }, { byHuman: true }, { log: say }); say(`answers -> ${res && res.error ? 'refused: ' + res.error : res.role.apply.status}`); process.exit(0); }
if (['approved', 'submitting', 'submitted', 'confirmed'].includes(a.status)) { say(`nothing to do: ${c.name} is ${a.status}`); process.exit(0); }
if (!['failed', 'skipped', 'blocked', 'prepared'].includes(a.status)) { say(`refused: ${c.name} is ${a.status}`); process.exit(1); }
const call = async (patch, extra = {}) => { const res = await board.patchRetry(id, patch, extra, { log: say }); return res && res.error ? `refused: ${res.error}` : (res.role ? res.role.apply.status : JSON.stringify(res)); };
if (a.status !== 'prepared') say(`revive  -> ${await call({ status: 'prepared' }, { byHuman: true })}`);
if (Object.keys(answers).length) say(`answers -> ${await call({ answers: { ...(a.answers || {}), ...answers } }, { byHuman: true })}`);
say(`queue   -> ${await call({ status: 'approved' })}`);
