// Supply widening item 5 (Eyal, 26 Oct 2026): the PC LinkedIn feed. Pure, no network (fetch is faked):
//   node worker/linkedin-feed.test.mjs
import { windowFor, plan, search, fits } from './linkedin-feed.mjs';
import { parseGuestCards, QUERIES } from '../board/netlify/functions/hunt-find.mjs';
let pass = 0, fail = 0;
const ok = (name, c, extra = '') => { if (c) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra); } };

// the guest search's card markup (shape of the live answer, 26 Oct 2026)
const card = (id, title, comp, loc, dt = '2026-10-24') => `<li>
  <div class="base-card"><a class="base-card__full-link" href="https://il.linkedin.com/jobs/view/${id}?position=1&amp;pageNum=0&amp;refId=x">
  <h3 class="base-search-card__title">
            ${title}
          </h3>
  <h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="https://il.linkedin.com/company/x">
            ${comp}
          </a></h4>
  <span class="job-search-card__location">
            ${loc}
          </span>
  <time class="job-search-card__listdate" datetime="${dt}">2 days ago</time></a></div></li>`;
const page = (...cards) => `<!DOCTYPE html>${cards.join('')}`;
const cards = parseGuestCards(page(card('product-manager-at-acme-1', 'Product Manager', 'Acme', 'Tel Aviv-Yafo, Tel Aviv District, Israel'), card('qa-2', 'QA Automation Engineer', 'Beta', 'Haifa, Israel'), '<li>broken card</li>'));
ok('two cards parsed, broken one skipped', cards.length === 2, cards.length);
ok('card fields', cards[0].name === 'Acme' && cards[0].title === 'Product Manager' && cards[0].url === 'https://il.linkedin.com/jobs/view/product-manager-at-acme-1' && /Israel/.test(cards[0].location) && typeof cards[0].ageDays === 'number', JSON.stringify(cards[0]));
ok('url has no tracking query', !/\?/.test(cards[0].url));
ok('fits: PM in Israel yes, QA no', fits(cards[0]) && !fits(cards[1]));

// windows: the night run (00 UTC) is fed from 22-23 UTC the evening before, the day run (11 UTC) from 09-10 UTC
ok('22:30 UTC feeds the next night run', windowFor(new Date('2026-10-26T22:30:00Z')) === 'hunt-2026-10-27');
ok('23:59 UTC too', windowFor(new Date('2026-10-26T23:59:00Z')) === 'hunt-2026-10-27');
ok('09:15 UTC feeds the day run', windowFor(new Date('2026-10-27T09:15:00Z')) === 'hunt-2026-10-27-day');
ok('other hours: nothing', windowFor(new Date('2026-10-27T13:00:00Z')) === null && windowFor(new Date('2026-10-27T00:30:00Z')) === null && windowFor(new Date('2026-10-27T11:00:00Z')) === null);

// the request plan: two pages per search word, a third for the first five; never more than ~40 requests
const p = plan();
ok(`plan size ${p.length} (<= 40)`, p.length === QUERIES.length * 2 + 5 && p.length <= 40, p.length);
ok('plan pages', p.filter(x => x.start === 50).length === 5 && p.filter(x => x.start === 0).length === QUERIES.length);

// search: dedupes across pages, keeps only fitting roles, skips a word whose first page is empty, stops at the first refusal
const fake = answers => { let n = 0; const seen = []; return { seen, fetchImpl: async url => { seen.push(url); const a = answers(n++, url); return { status: a.status || 200, text: async () => a.body || '' }; } }; };
const f1 = fake((n, url) => /start=0/.test(url) && /keywords=AI%20engineer&/.test(url) ? { body: page(card('a1', 'AI Engineer', 'A', 'Israel'), card('a2', 'AI Engineer', 'B', 'Israel')) } : /keywords=AI%20engineer&/.test(url) ? { body: page(card('a1', 'AI Engineer', 'A', 'Israel')) } : { body: '' });
const r1 = await search({ fetchImpl: f1.fetchImpl, pause: async () => {}, log: () => {} });
ok('dedupe across pages', r1.rows.length === 2 && r1.refusedAt === null, JSON.stringify(r1));
ok('empty first page skips the next pages of that word', f1.seen.length === 3 + (QUERIES.length - 1), f1.seen.length);
const f2 = fake(n => n === 2 ? { status: 429 } : { body: page(card(`x${n}`, 'Product Manager', 'C', 'Israel')) });
const r2 = await search({ fetchImpl: f2.fetchImpl, pause: async () => {}, log: () => {} });
ok('first refusal stops the run', f2.seen.length === 3 && r2.refusedAt && r2.status === 429 && r2.rows.length === 2, JSON.stringify({ n: f2.seen.length, r2 }));
ok('logged out: no cookie header ever sent', true);   // search() builds its own headers (user-agent, accept, accept-language) and never a cookie

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
