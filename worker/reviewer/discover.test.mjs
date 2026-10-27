// Supply widening item 3 (Eyal, 26 Oct 2026): discover's classifier, queue and tally, and the supply score / stall rules. Pure, no network
// (classify is only called on paths that answer from techmap's own fields):
//   node worker/reviewer/discover.test.mjs
import { judgeLinks, detectPile2, linksOf, queueOf, tallyOf, classify, parseCsv, PILE3 } from './discover.mjs';
import { scoreDay, stalled, discoverStuck } from './supply-score.mjs';
let pass = 0, fail = 0;
const ok = (name, c, extra = '') => { if (c) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra); } };
const J = o => JSON.stringify(o);

// links -> piles
const j = l => judgeLinks(l) || {};
ok('greenhouse iframe -> pile 1', J(j(['https://boards.greenhouse.io/embed/job_board?for=acme&b=x'])) === J({ pile: 1, ats: 'greenhouse', slug: 'acme', via: 'https://boards.greenhouse.io/embed/job_board?for=acme&b=x' }), J(j(['https://boards.greenhouse.io/embed/job_board?for=acme&b=x'])));
ok('greenhouse js embed -> slug', j(['https://boards.greenhouse.io/embed/job_board/js?for=woodgrove']).slug === 'woodgrove');
ok('lever / ashby / smartrecruiters', j(['https://jobs.lever.co/acmeco']).ats === 'lever' && j(['https://jobs.ashbyhq.com/hooli']).slug === 'hooli' && j(['https://jobs.smartrecruiters.com/Fabrikam2/123']).ats === 'smartrecruiters');
ok('comeet with company uid -> slug/uid', j(['https://www.comeet.com/jobs/acme/F2.004/senior-pm/D4.F64']).slug === 'acme/F2.004', j(['https://www.comeet.com/jobs/acme/F2.004/x']).slug);
ok('comeet widget uid only -> needs the name slug', j(['https://www.comeet.co/careers-api/2.0/company/88.004/positions?token=abc']).uid === '88.004' && j(['https://www.comeet.co/careers-api/2.0/company/88.004/positions?token=abc']).slug === null);
ok('bamboohr link -> pile 2', J(detectPile2('https://acme.bamboohr.com/careers')) === J({ ats: 'bamboohr', slug: 'acme' }));
ok('workable apply link -> pile 2 slug', detectPile2('https://apply.workable.com/acme-ltd/').slug === 'acme-ltd', J(detectPile2('https://apply.workable.com/acme-ltd/')));
ok('teamtailor / recruitee / breezy / personio', detectPile2('https://acme.teamtailor.com/jobs').ats === 'teamtailor' && detectPile2('https://acme.recruitee.com/').ats === 'recruitee' && detectPile2('https://acme.breezy.hr/').ats === 'breezy' && detectPile2('https://acme.jobs.personio.de/').ats === 'personio');
ok('junk subdomains are no slug', detectPile2('https://www.bamboohr.com/pricing') === null);
ok('workday -> pile 3', j(['https://paloaltonetworks.wd5.myworkdayjobs.com/en-US/x']).pile === 3);
ok('eightfold / successfactors / icims -> pile 3', PILE3.test('https://hp.eightfold.ai/careers') && PILE3.test('https://career5.successfactors.eu/x') && PILE3.test('https://careers-acme.icims.com/jobs'));
ok('a handled board wins over pile 2 on the same page', j(['https://acme.teamtailor.com/jobs', 'https://jobs.lever.co/acme']).ats === 'lever');
ok('workable + bamboohr have recipes since 26 Oct: pile 1', j(['https://acme.bamboohr.com/careers']).pile === 1 && j(['https://acme.bamboohr.com/careers']).slug === 'acme' && j(['https://apply.workable.com/acme-ltd/']).pile === 1);
ok('nothing -> null', judgeLinks(['https://acme.com/about', 'https://acme.com/careers']) === null);

// links from page text: href / src / bare URLs, relative made absolute
const html = `<a href="/careers">Careers</a><iframe src="https://boards.greenhouse.io/embed/job_board?for=acme"></iframe><script>var u="https://jobs.lever.co/acme"</script>`;
const ls = linksOf(html, 'https://acme.com/');
ok('relative href made absolute', ls.includes('https://acme.com/careers'));
ok('comeet widget init in code -> uid', j(linksOf('<script>comeetInit({"company-uid": "88.004", "token": "x"})</script>', 'https://a.com/')).uid === '88.004');
ok('iframe src and bare script URL found', ls.some(x => /greenhouse/.test(x)) && ls.some(x => /jobs\.lever\.co\/acme/.test(x)));

// classify from techmap's own fields (no network on these paths)
const r1 = await classify({ name: 'Insightec', greenhouseId: 'insightec' });
ok('techmap greenhouseId -> pile 1', r1.pile === 1 && r1.ats === 'greenhouse' && r1.slug === 'insightec');
const r2 = await classify({ name: 'Aitech', comeetId: 'aitechsystems/88.004' });
ok('techmap comeetId -> comeet slug/uid', r2.ats === 'comeet' && r2.slug === 'aitechsystems/88.004');
const r3 = await classify({ name: 'Acme' }, ['https://www.comeet.com/jobs/Acme/F2.004/senior-product-manager/D4.F64?utm_source=techmap']);
ok('techmap posting URL -> comeet board', r3.ats === 'comeet' && r3.slug === 'Acme/F2.004', J(r3));
const r4 = await classify({ name: 'X', breezyId: 'XCo' });
ok('techmap breezyId -> pile 2', r4.pile === 2 && r4.ats === 'breezy' && r4.slug === 'xco');
const r5 = await classify({ name: 'Y', careersUrl: 'https://y.wd3.myworkdayjobs.com/External' });
ok('careersUrl on workday -> pile 3 without a fetch', r5.pile === 3, J(r5));

// queue: unchecked first (hiring companies, then by size), then due rechecks oldest first
const now = Date.parse('2026-10-26T12:00:00Z');
const cos = [{ id: 'a', name: 'Alpha', size: 'xs' }, { id: 'b', name: 'Beta', size: 'l' }, { id: 'c', name: 'Gamma', size: 's' }, { id: 'd', name: 'Delta', size: 'm' }, { id: 'e', name: 'Eps', size: 'm' }, { id: 'f', name: 'Zeta', size: 'm' }];
const jobs = new Map([['gamma', [{}]]]);
const state = { companies: {
  d: { pile: 'own', checkedAt: '2026-09-01T00:00:00Z' },                       // 30-day recheck due
  e: { pile: 1, active: false, checkedAt: '2026-10-24T00:00:00Z' },             // watch, 2 days: not due
  f: { pile: 1, active: false, checkedAt: '2026-10-10T00:00:00Z' },             // watch, 16 days: due
} };
const q = queueOf(cos, jobs, state, now).map(c => c.id);
ok('queue order: hiring first, then size, then due rechecks', J(q) === J(['c', 'b', 'a', 'd', 'f']), J(q));

// tally: pile 2 per ATS, ready at 3+ fitting roles
const tst = { companies: {
  1: { pile: 2, ats: 'bamboohr', name: 'A', fitting: [{ title: 'Product Manager', url: 'u1' }, { title: 'AI Engineer', url: 'u2' }] },
  2: { pile: 2, ats: 'bamboohr', name: 'B', fitting: [{ title: 'Solutions Engineer', url: 'u3' }] },
  3: { pile: 2, ats: 'teamtailor', name: 'C', fitting: [{ title: 'PM', url: 'u4' }] },
  4: { pile: 2, ats: 'hibob', name: 'D', fitting: [] },
  5: { pile: 1, ats: 'greenhouse', name: 'E' },
} };
const t = tallyOf(tst);
ok('tally per ATS', t.byAts.bamboohr.companies === 2 && t.byAts.bamboohr.fitting === 3 && t.byAts.teamtailor.fitting === 1 && t.byAts.hibob.companies === 1 && !t.byAts.greenhouse);
ok('ready at 3+ fitting roles', J(t.ready) === J([{ ats: 'bamboohr', fitting: 3, companies: 2 }]), J(t.ready));
ok('reader flags', t.byAts.bamboohr.reader === true && t.byAts.hibob.reader === false);
ok('csv twin parses a quoted comma', parseCsv('"company","title"\n"Acme, Inc","PM"')[0].company === 'Acme, Inc');

// score + stall
const st = { hunt: { seeds: 'greenhouse a\ngreenhouse b', boards: ['lever c'], caps: { found: 10 }, runs: [{ at: '2026-10-26T01:00:00Z', runId: 'hunt-2026-10-26', candidates: 6, brief: 'Finder: drushim: 200 roles seen; techmap: 900 roles seen. 40 known dropped before the cap. 120 companies, 60 offered to the sorter.' }] },
  companies: [{ tier: 'practice', autoAdded: true, hunt: { foundAt: '2026-10-26T01:10:00Z' } }, { tier: 'practice', autoAdded: true, hunt: { foundAt: '2026-10-25T01:10:00Z', history: [] } }, { tier: 'real', hunt: { foundAt: '2026-10-26T02:00:00Z' } }] };
const d = scoreDay(st, '2026-10-26', { day: '2026-10-25', boardLines: 1 }, { runs: [{ at: '2026-10-26T05:30:00Z', checked: 400, newBoards: 7, sweep: { pct: 5 } }] });
ok('score = new companies + new board lines', d.score === 3 && d.newCompanies === 1 && d.newBoards === 2 && d.boardLines === 3, J(d));
ok('run parts parsed', d.runs[0].kept === 6 && d.runs[0].known === 40 && d.runs[0].offered === 60 && d.runs[0].src.techmap === 900, J(d.runs));
ok('discover parts', d.discovered === 400 && d.discoverAdds === 7 && d.sweepPct === 5);
const H = (day, score, kept) => ({ day, score, capFound: 10, runs: kept.map(k => ({ kept: k })) });
ok('no stall with growth', stalled([H('2026-10-24', 0, [2]), H('2026-10-25', 3, [6])], '2026-10-26') === null);
ok('stall after two days at 0', /score 0/.test(stalled([H('2026-10-24', 0, [6]), H('2026-10-25', 0, [7])], '2026-10-26') || ''));
ok('stall when every run of both days kept under half', /under half/.test(stalled([H('2026-10-24', 4, [3, 4]), H('2026-10-25', 2, [2, 4])], '2026-10-26') || ''));
ok('today never counts', stalled([H('2026-10-25', 0, [1]), H('2026-10-26', 0, [1])], '2026-10-26') === null);
ok('one day of history is not a stall', stalled([H('2026-10-25', 0, [1])], '2026-10-26') === null);
ok('discover fine', discoverStuck({ runs: [{ at: '2026-10-26T05:30:00Z', checked: 400, sweep: { pct: 20 } }], pulledAt: '2026-10-26T05:30:00Z' }, now) === null);
ok('discover stuck after 48 h without a check', /48 h/.test(discoverStuck({ runs: [{ at: '2026-10-26T05:30:00Z', checked: 0, sweep: { pct: 20 } }, { at: '2026-10-23T05:30:00Z', checked: 400, sweep: { pct: 20 } }] }, now) || ''));
ok('finished sweep is not stuck', discoverStuck({ runs: [{ at: '2026-10-26T05:30:00Z', checked: 0, sweep: { pct: 100 } }, { at: '2026-10-20T05:30:00Z', checked: 10, sweep: { pct: 100 } }] }, now) === null);
ok('pull failing 48 h is stuck', /techmap copy/.test(discoverStuck({ runs: [], pullError: { msg: 'network' }, pulledAt: '2026-10-23T00:00:00Z' }, now) || ''));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
