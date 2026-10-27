// Post-deploy probe for compare-and-set saves: fires N concurrent no-op settings calls at the board and expects every one to either
// succeed with a distinct rev or be refused with 409 conflict (never two successes on the same rev). Safe: a settings call with no
// fields changes nothing but updatedAt. Usage: node tests/cas-probe.mjs https://your-board.netlify.app
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const base = (process.argv[2] || 'http://localhost:8899').replace(/\/$/, '');
const H = { 'x-key': env.PIPELINE_KEY, 'content-type': 'application/json' };
const feat = await fetch(`${base}/.netlify/functions/state`, { headers: H }).then(r => r.json());
console.log(`board rev ${feat.rev}, features.cas = ${feat.features && feat.features.cas}`);
const N = 6;
const rs = await Promise.all(Array.from({ length: N }, () => fetch(`${base}/.netlify/functions/hunt`, { method: 'POST', headers: H, body: JSON.stringify({ action: 'settings' }) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))));
const okRevs = rs.filter(r => r.status === 200).map(r => r.body.rev);
const conflicts = rs.filter(r => r.status === 409).length;
const distinct = new Set(okRevs).size === okRevs.length;
console.log(`statuses: ${rs.map(r => r.status).join(' ')}  ok revs: ${okRevs.join(',')}  conflicts: ${conflicts}`);
console.log(distinct && okRevs.length + conflicts === N ? 'PASS: no two writers won the same rev' : 'FAIL: duplicate revs or unexpected statuses (lost write possible)');
