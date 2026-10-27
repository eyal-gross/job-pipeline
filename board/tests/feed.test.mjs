// Supply widening item 5 (Eyal, 26 Oct 2026): the board's "feed" action (the PC's LinkedIn guest-search rows) against localhost:8899, and
// the finder's linkedin step reading a fresh feed / falling back to its own search when the feed is stale (in-process, fetch stubbed).
//   node tests/feed.test.mjs     (netlify dev on :8899 must be up, like the other localhost suites)
import fs from 'node:fs';
import { findStep, FEED_FRESH_H } from '../netlify/functions/hunt-find.mjs';
const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const B = 'http://localhost:8899/.netlify/functions';
const KEY = { 'x-key': env.PIPELINE_KEY, 'content-type': 'application/json' };
const j = async r => ({ status: r.status, body: await r.json().catch(() => null) });
const post = (h, b) => fetch(`${B}/hunt`, { method: 'POST', headers: h, body: JSON.stringify(b) }).then(j);
const state = async () => (await fetch(`${B}/state`, { headers: KEY }).then(j)).body.state;
let pass = 0, fail = 0; const ok = (name, c, extra = '') => { if (c) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra); } };

const row = i => ({ name: `Co ${i}`, title: 'Product Manager', url: `https://il.linkedin.com/jobs/view/product-manager-${i}`, location: 'Tel Aviv, Israel', ageDays: 2 });
ok('no key -> 401', (await post({ 'content-type': 'application/json' }, { action: 'feed', source: 'linkedin', roles: [row(1)] })).status === 401);
ok('unknown source -> 422', (await post(KEY, { action: 'feed', source: 'indeed', roles: [row(1)] })).status === 422);
const rows = [...Array.from({ length: 420 }, (_, i) => row(i)), { name: 'Bad', title: 'PM', url: 'https://evil.example.com/jobs/view/1' }, { name: 'NoTitle', title: '', url: 'https://il.linkedin.com/jobs/view/9' }, { name: 'Q', title: 'PM', url: 'https://il.linkedin.com/jobs/view/1?trk=x' }];
const r = await post(KEY, { action: 'feed', source: 'linkedin', roles: rows, queries: 16, pages: 37 });
ok('feed accepted', r.status === 200 && r.body.feed && r.body.feed.sent === rows.length, JSON.stringify(r.body));
ok('clipped to 400, bad urls / empty titles dropped', r.body.feed.rows === 400, r.body.feed.rows);
const st = await state();
const fd = st.hunt.feed && st.hunt.feed.linkedin;
ok('stored on the board with its time and counts', fd && fd.rows.length === 400 && fd.queries === 16 && fd.pages === 37 && !Number.isNaN(Date.parse(fd.at)));
ok('rows cleaned', fd.rows.every(x => /^https:\/\/il\.linkedin\.com\/jobs\/view\/product-manager-\d+$/.test(x.url) && x.title && x.ageDays === 2));

// the finder's linkedin step, in-process on a copy of that state
const realFetch = globalThis.fetch; let fetched = 0;
globalThis.fetch = async () => { fetched++; return new Response('', { status: 999 }); };   // LinkedIn refusing the cloud
const runAt = st => { st.hunt.find = { status: 'running', runId: 'hunt-feed-test', startedAt: new Date().toISOString(), step: 'linkedin', cursor: 0, raw: [], funnel: { found: 0, dropped: {} }, errors: [], log: [] }; return st; };
const s1 = runAt(JSON.parse(JSON.stringify(st)));
const t1 = await findStep(s1, 'http://localhost:8899', { manual: true });
ok('fresh feed used: no LinkedIn request from the step', fetched === 0 && t1.step === 'linkedin', JSON.stringify({ fetched, t1 }));
ok('feed rows offered like any LinkedIn hit', s1.hunt.find.raw.length === 400 && s1.hunt.find.raw.every(c => c.ats === 'linkedin' && c.source === 'linkedin'), s1.hunt.find.raw.length);
ok('log says PC feed, readable by supply.mjs', /^linkedin \(PC feed \d{4}Z\): 400 roles seen$/.test(s1.hunt.find.log.find(l => /linkedin/.test(l)) || ''), s1.hunt.find.log.join(' | '));
const s2 = runAt(JSON.parse(JSON.stringify(st))); s2.hunt.feed.linkedin.at = new Date(Date.now() - (FEED_FRESH_H + 1) * 3600000).toISOString();
await findStep(s2, 'http://localhost:8899', { manual: true });
ok('stale feed: the cloud search runs instead (and its refusal is logged)', fetched === 3 && s2.hunt.find.raw.length === 0 && s2.hunt.find.errors.some(e => /^linkedin/.test(e)) && /PC feed stale/.test(s2.hunt.find.log.join(' ')), JSON.stringify({ fetched, log: s2.hunt.find.log }));
globalThis.fetch = realFetch;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
