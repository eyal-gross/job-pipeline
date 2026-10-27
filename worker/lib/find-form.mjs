// Form finder: given a company and a job title that the hunt only saw on LinkedIn, find the same posting on the company's own ATS
// (Greenhouse / Lever / Ashby / Comeet, the ones the worker has recipes for) so the loop can apply there instead of forfeiting.
// Why on the PC: the board's server-side fetch gets 403 from many careers pages (Northwind, Tailspin, 21 Oct 2026); the runner
// Chrome is a normal browser and gets the page. Best practice (checked 21 Oct 2026): every big ATS publishes a public, unauthenticated
// JSON job list per company slug, so once the slug is known the match is exact and cheap:
//   Greenhouse  https://boards-api.greenhouse.io/v1/boards/<slug>/jobs
//   Lever       https://api.lever.co/v0/postings/<slug>?mode=json
//   Ashby       https://api.ashbyhq.com/posting-api/job-board/<slug>
//   SmartRecruiters https://api.smartrecruiters.com/v1/companies/<slug>/postings   (no recipe: reported as "other" with the URL)
// Order: 1) slug guesses from the domain / name against the APIs (no browser); 2) the careers page in the runner Chrome: ATS links, embeds
// and scripts give the real slug, then the API again; Comeet and own portals are matched by link text on the page. Nothing is submitted here.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const STOP = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'for', 'to', 'in', 'at', 'on', 'with', 'il', 'israel', 'tel', 'aviv', 'tlv', 'hybrid', 'remote', 'm', 'f', 'd', 'x']);
export const norm = s => String(s || '').toLowerCase().replace(/[‐-―]/g, '-').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const tokens = s => norm(s).split(' ').filter(t => t && !STOP.has(t));
export function titleScore(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const ta = new Set(tokens(a)), tb = new Set(tokens(b));
  const inter = [...ta].filter(t => tb.has(t)).length;
  return inter / Math.max(1, new Set([...ta, ...tb]).size);
}
const israeli = loc => /israel|tel aviv|tel-aviv|herzliya|haifa|jerusalem|ramat gan|petah|raanana|ra'anana|netanya|rehovot|yokneam|hod hasharon|kfar saba|beer sheva|be'er sheva|caesarea|modiin|rosh haayin|bnei brak|holon|il\b/i.test(String(loc || ''));

export function slugGuesses(name, domain, site) {
  const out = new Set();
  const host = String(domain || site || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  const label = host.split('.')[0];
  if (label) out.add(label);
  const words = norm(name).split(' ').filter(w => w && !/^(ltd|inc|llc|co|corp|corporation|software|technologies|technology|tech|labs|group|global|ai|io)$/.test(w));
  if (words.length) { out.add(words.join('')); out.add(words.join('-')); out.add(words[0]); }
  const all = norm(name).split(' ').filter(Boolean);
  if (all.length) { out.add(all.join('')); out.add(all.join('-')); }
  return [...out].filter(s => s.length >= 3).slice(0, 8);
}

const fetchJson = async (url, ms = 12000) => {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) job-search form finder' } }); if (!r.ok) return { status: r.status }; return { status: r.status, json: await r.json().catch(() => null) }; }
  catch (e) { return { status: 0, error: e.message }; } finally { clearTimeout(t); }
};
// one ATS job list by slug -> [{ title, url, location }] | null (no such board)
export async function apiList(ats, slug) {
  if (ats === 'greenhouse') { const r = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`); if (!r.json || !Array.isArray(r.json.jobs)) return null; return r.json.jobs.map(j => ({ title: j.title, url: j.absolute_url, location: j.location && j.location.name })); }
  if (ats === 'lever') { const r = await fetchJson(`https://api.lever.co/v0/postings/${slug}?mode=json`); if (!Array.isArray(r.json)) return null; return r.json.map(j => ({ title: j.text, url: j.hostedUrl || j.applyUrl, location: j.categories && j.categories.location })); }
  if (ats === 'ashby') { const r = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`); if (!r.json || !Array.isArray(r.json.jobs)) return null; return r.json.jobs.map(j => ({ title: j.title, url: j.jobUrl, location: j.location })); }
  if (ats === 'smartrecruiters') { const r = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`); if (!r.json || !Array.isArray(r.json.content) || !r.json.content.length) return null; return r.json.content.map(j => ({ title: j.name, url: `https://jobs.smartrecruiters.com/${slug}/${j.id}`, location: j.location && [j.location.city, j.location.country].filter(Boolean).join(', ') })); }
  return null;
}
export function pickBest(list, title, location) {
  let best = null;
  for (const j of list || []) {
    const s = titleScore(j.title, title); if (s < 0.6) continue;
    const bonus = israeli(j.location) ? 0.05 : (israeli(location) && j.location ? -0.05 : 0);
    const score = s + bonus;
    if (!best || score > best.score) best = { ...j, score };
  }
  return best;
}
// ATS hosts seen in links / iframes / scripts of a careers page -> { ats, slug }
export const detect = href => {   // exported for reviewer/discover.mjs (26 Oct 2026)
  let m;
  if ((m = href.match(/boards(?:-api)?\.greenhouse\.io\/(?:v1\/boards\/|embed\/job_board\/?\?(?:for|token)=|embed\/job_app\?(?:for|token)=)?([a-z0-9_-]+)/i)) && !/^(embed|v1)$/.test(m[1])) return { ats: 'greenhouse', slug: m[1] };
  if ((m = href.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([a-z0-9_-]+)/i))) return { ats: 'greenhouse', slug: m[1] };
  if ((m = href.match(/greenhouse\.io\/embed\/job_board\/js\?for=([a-z0-9_-]+)/i))) return { ats: 'greenhouse', slug: m[1] };
  if ((m = href.match(/jobs\.lever\.co\/([a-z0-9_-]+)/i))) return { ats: 'lever', slug: m[1] };
  if ((m = href.match(/jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i))) return { ats: 'ashby', slug: m[1] };
  if ((m = href.match(/comeet\.com\/jobs\/([a-z0-9_-]+)\/([a-z0-9.]+)/i))) return { ats: 'comeet', slug: m[1], companyId: m[2] };
  if ((m = href.match(/comeet\.co\/(?:careers-api|jobs)\/[^/]*\/?([a-z0-9.]+)?/i))) return { ats: 'comeet', slug: m[1] || '' };
  if ((m = href.match(/(?:jobs|careers)\.smartrecruiters\.com\/([a-z0-9_-]+)/i))) return { ats: 'smartrecruiters', slug: m[1] };
  if ((m = href.match(/([a-z0-9-]+)\.(?:wd\d+\.)?myworkdayjobs\.com/i))) return { ats: 'workday', slug: m[1] };
  if (/workable\.com|bamboohr\.com|recruitee\.com|taleo\.net|successfactors|icims\.com|jobvite\.com|teamtailor\.com|breezy\.hr|personio|rippling\.com\/jobs|hirehive|freshteam/i.test(href)) return { ats: 'other', slug: '', portal: (href.match(/(workable|bamboohr|recruitee|taleo|successfactors|icims|jobvite|teamtailor|breezy|personio|rippling|hirehive|freshteam)/i) || ['', ''])[1].toLowerCase() };
  return null;
};
// an ATS form embedded in a company page (iframe src / script src) -> { ats, url } the recipe can open directly
export function embeddedForm(links) {
  for (const h of links) {
    let m;
    if ((m = h.match(/^https?:\/\/www\.comeet\.co\/jobs\/[0-9A-Za-z.]+\/[0-9A-Za-z.]+\/apply\b[^\s"']*/))) {
      // keep only the parameters the form needs (token, company-uid, company-name); the styling ones make the URL 600+ chars
      try { const u = new URL(m[0]); const keep = new URLSearchParams(); for (const k of ['token', 'company-uid', 'company-name']) if (u.searchParams.get(k)) keep.set(k, u.searchParams.get(k)); u.search = keep.toString(); return { ats: 'comeet', url: u.toString(), slug: u.searchParams.get('company-uid') || '' }; } catch { return { ats: 'comeet', url: m[0].slice(0, 400), slug: '' }; }
    }
    if ((m = h.match(/greenhouse\.io\/embed\/job_app\?(?:[^"'\s]*&)?for=([a-z0-9_-]+)(?:&[^"'\s]*)?token=(\d+)/i)) || (m = h.match(/greenhouse\.io\/embed\/job_app\?(?:[^"'\s]*&)?token=(\d+)(?:&[^"'\s]*)?for=([a-z0-9_-]+)/i) && [m[0], m[2], m[1]])) return { ats: 'greenhouse', url: `https://boards.greenhouse.io/${m[1]}/jobs/${m[2]}`, slug: m[1] };
    if ((m = h.match(/^https?:\/\/jobs\.lever\.co\/([a-z0-9_-]+)\/([0-9a-f-]{36})/i))) return { ats: 'lever', url: m[0], slug: m[1] };
    if ((m = h.match(/^https?:\/\/jobs\.ashbyhq\.com\/([a-z0-9_-]+)\/([0-9a-f-]{36})/i))) return { ats: 'ashby', url: m[0], slug: m[1] };
  }
  return null;
}
const careersUrls = (site, domain) => {
  const base = String(site || `https://www.${domain}`).replace(/\/$/, '');
  const host = String(domain || base.replace(/^https?:\/\/(www\.)?/, '')).split('/')[0];
  return [...new Set([`${base}/careers`, `${base}/careers/`, `${base}/jobs`, `https://careers.${host}`, `https://jobs.${host}`, `${base}/company/careers`, `${base}/about/careers`, `${base}/about-us/careers`, `${base}/join-us`, `${base}/career`])];
};
async function readPage(ctx, url, log, waitMs = 4500) {
  const page = await ctx.newPage();
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
    const status = res ? res.status() : 0;
    if (!res || status >= 400) return { url, status, links: [], jobLinks: [] };
    await sleep(waitMs);
    const data = await page.evaluate(() => {
      const abs = h => { try { return new URL(h, location.href).href; } catch { return ''; } };
      const links = new Set();
      for (const a of document.querySelectorAll('a[href]')) links.add(abs(a.getAttribute('href')));
      for (const f of document.querySelectorAll('iframe[src]')) links.add(abs(f.getAttribute('src')));
      for (const s of document.querySelectorAll('script[src]')) links.add(abs(s.getAttribute('src')));
      const html = document.documentElement.outerHTML;
      for (const m of html.matchAll(/https?:\/\/[^"'\s<>]*(?:greenhouse\.io|lever\.co|ashbyhq\.com|comeet\.co|comeet\.com|smartrecruiters\.com|myworkdayjobs\.com)[^"'\s<>]*/g)) links.add(m[0]);
      const jobLinks = [...document.querySelectorAll('a[href]')].map(a => ({ text: (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120), href: abs(a.getAttribute('href')) })).filter(l => l.text && l.href);
      return { final: location.href, title: document.title, links: [...links].filter(Boolean), jobLinks };
    }).catch(() => ({ final: url, title: '', links: [], jobLinks: [] }));
    return { url, status, ...data };
  } finally { await page.close().catch(() => {}); }
}

// A careers site's own keyword search: type the title into the first search box, read the result cards. Each anchor to a position is
// scored by the smallest container around it whose text carries the title (Fabrikam: the anchor text is empty, the card text is 3 levels up).
async function keywordSearch(ctx, url, title, log) {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
    await sleep(5000);
    const box = page.locator('input[type=search], input[placeholder*="earch" i], input[aria-label*="earch" i], input[name*="search" i], input[id*="search" i], input[placeholder*="keyword" i]').first();
    if (!(await box.count()) || !(await box.isVisible().catch(() => false))) return { box: false };
    await box.click({ timeout: 5000 }); await box.fill(title); await page.keyboard.press('Enter');
    await sleep(7000);
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 3000).catch(() => {}); await sleep(800); }
    const cards = await page.evaluate(() => {
      const abs = h => { try { return new URL(h, location.href).href; } catch { return ''; } };
      const out = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const href = abs(a.getAttribute('href')); if (!href) continue;
        let u; try { u = new URL(href); } catch { continue; }
        // a position link: the PATH names a position / job / opening, or the host is a known ATS (the careers site's own home link is neither)
        if (!/position|job|opening|vacanc|posting|requisition|\/p\/|\/o\//i.test(u.pathname) && !/smartrecruiters|greenhouse|lever|ashby|comeet|workday/i.test(u.hostname)) continue;
        if (/^\/?(jobs|positions|careers|openings)\/?$/i.test(u.pathname)) continue;   // the listing page itself
        const levels = []; let el = a;
        for (let i = 0; i < 5 && el; i++) { const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); if (t.length > 220) break; if (t) levels.push(t); el = el.parentElement; }
        out.push({ href, levels });
      }
      return out.slice(0, 300);
    }).catch(() => []);
    let best = null;
    for (const c of cards) for (let i = 0; i < c.levels.length; i++) { const s = titleScore(c.levels[i], title); const s2 = norm(c.levels[i]).includes(norm(title)) ? 0.95 : s; const score = Math.max(s, s2) - i * 0.01; if (score >= 0.6 && (!best || score > best.score)) best = { href: c.href, text: c.levels[i].slice(0, 120), score, level: i }; }
    log(`finder: keyword search on ${url}: ${cards.length} position links, ${best ? `best "${best.text.slice(0, 60)}" ${best.score.toFixed(2)}` : 'no match'}`);
    return { box: true, card: best };
  } finally { await page.close().catch(() => {}); }
}

// main entry. ctx: Playwright BrowserContext (runner Chrome) or null for API-only. Returns { found, ats, url, slug, via, portal, score, checked }
export async function findForm({ ctx, name, site, domain, title, location, log = () => {} }) {
  const checked = [];
  const guesses = slugGuesses(name, domain, site);
  // 1. API by slug guesses (greenhouse / lever / ashby, then smartrecruiters for the honest "own portal" verdict)
  for (const ats of ['greenhouse', 'lever', 'ashby', 'smartrecruiters']) {
    for (const slug of guesses) {
      const list = await apiList(ats, slug); checked.push(`${ats}:${slug}${list ? ` (${list.length} jobs)` : ''}`);
      if (!list) continue;
      const best = pickBest(list, title, location);
      if (best) { log(`finder: ${name} -> ${ats} board "${slug}" has "${best.title}" (${best.location || '?'}), score ${best.score.toFixed(2)}`); return { found: true, ats, url: best.url, slug, via: 'api-slug-guess', score: best.score, matchedTitle: best.title, checked }; }
      log(`finder: ${name}: ${ats} board "${slug}" exists (${list.length} jobs) but no "${title}" on it`);
    }
  }
  // 2. careers page in the runner Chrome: find the ATS and its slug, or the posting link itself
  if (ctx) {
    const seen = new Set(); let hits = []; const okPages = [];
    const queue = careersUrls(site, domain);
    for (let i = 0; i < queue.length && i < 8; i++) {
      const u = queue[i]; if (seen.has(u)) continue; seen.add(u);
      const pg = await readPage(ctx, u, log); checked.push(`page:${u} (${pg.status})`);
      if (!pg.status || pg.status >= 400) continue;
      if (pg.final && !okPages.includes(pg.final)) okPages.push(pg.final);
      const ids = pg.links.map(detect).filter(Boolean);
      for (const d of ids) if (!hits.some(h => h.ats === d.ats && h.slug === d.slug)) hits.push(d);
      // own-portal or Comeet: a link whose text is the title
      const direct = pg.jobLinks.map(l => ({ ...l, score: titleScore(l.text, title) })).filter(l => l.score >= 0.6).sort((a, b) => b.score - a.score)[0];
      if (direct) {
        const d = detect(direct.href) || {};
        const ats = d.ats && d.ats !== 'other' ? d.ats : 'other';
        log(`finder: ${name} -> link "${direct.text}" on ${u} -> ${direct.href} (${ats})`);
        if (['greenhouse', 'lever', 'ashby', 'comeet'].includes(ats)) return { found: true, ats, url: direct.href, slug: d.slug || '', via: 'careers-page-link', score: direct.score, matchedTitle: direct.text, checked };
        // the company's own position page often embeds the real ATS form (Tailspin, 21 Oct 2026: a Comeet apply iframe inside a
        // WordPress page). Open it once and look for the embed; the recipes accept the embed URL directly.
        const sub = await readPage(ctx, direct.href, log); checked.push(`page:${direct.href} (${sub.status})`);
        const embed = embeddedForm(sub.links || []);
        if (embed) { log(`finder: ${name} -> ${embed.ats} form embedded in ${direct.href}: ${embed.url}`); return { found: true, ats: embed.ats, url: embed.url, slug: embed.slug || '', via: 'own-page-embed', score: direct.score, matchedTitle: direct.text, checked }; }
        hits.unshift({ ats: 'other', slug: '', portal: d.portal || new URL(direct.href).hostname, url: direct.href, text: direct.text, score: direct.score });
      }
      // a careers page that hands off to a separate careers host: follow it once
      const hand = pg.jobLinks.map(l => l.href).find(h => /careers|jobs/i.test(h) && !seen.has(h) && new URL(h).hostname !== new URL(u).hostname && !detect(h) && /\.(com|co|io|ai|il)\b/.test(h));
      if (hand && queue.length < 10) queue.push(hand);
      if (hits.some(h => h.ats !== 'other')) break;
    }
    for (const h of hits.filter(h => ['greenhouse', 'lever', 'ashby', 'smartrecruiters'].includes(h.ats) && h.slug)) {
      const list = await apiList(h.ats, h.slug); checked.push(`${h.ats}:${h.slug}${list ? ` (${list.length} jobs)` : ' (no board)'}`);
      const best = list && pickBest(list, title, location);
      if (best) { log(`finder: ${name} -> ${h.ats} "${h.slug}" via careers page: "${best.title}" (${best.location || '?'})`); return { found: true, ats: h.ats, url: best.url, slug: h.slug, via: 'careers-page-ats', score: best.score, matchedTitle: best.title, checked }; }
    }
    // own-looking careers sites that render their list by code and hand off to an ATS from the position page (Fabrikam -> SmartRecruiters,
    // Northwind -> SmartRecruiters, 21 Oct 2026): type the title into the site's keyword search, open the matching card, read its apply link
    for (const u of okPages.slice(0, 3)) {
      const r = await keywordSearch(ctx, u, title, log).catch(e => ({ error: e.message }));
      checked.push(`search:${u}${r && r.error ? ` (error ${String(r.error).slice(0, 60)})` : r && r.card ? ` -> ${r.card.href}` : ' (no box or no match)'}`);
      if (!r || !r.card) continue;
      const d = detect(r.card.href) || {};
      if (['greenhouse', 'lever', 'ashby', 'comeet', 'smartrecruiters'].includes(d.ats)) { log(`finder: ${name} -> "${r.card.text}" via keyword search -> ${r.card.href} (${d.ats})`); return { found: true, ats: d.ats, url: r.card.href, slug: d.slug || '', via: 'careers-search', score: r.card.score, matchedTitle: r.card.text, checked }; }
      const pos = await readPage(ctx, r.card.href, log, 7000); checked.push(`page:${r.card.href} (${pos.status})`);
      const apply = (pos.jobLinks || []).map(l => ({ ...l, d: detect(l.href) })).find(l => l.d && ['greenhouse', 'lever', 'ashby', 'comeet', 'smartrecruiters'].includes(l.d.ats));
      if (apply) { log(`finder: ${name} -> "${r.card.text}" position page hands off to ${apply.d.ats}: ${apply.href}`); return { found: true, ats: apply.d.ats, url: apply.href.replace(/[?&]sid=[^&]+/, ''), slug: apply.d.slug || '', via: 'careers-search-position', score: r.card.score, matchedTitle: r.card.text, checked }; }
      const embed = embeddedForm(pos.links || []);
      if (embed) { log(`finder: ${name} -> "${r.card.text}" position page embeds ${embed.ats}: ${embed.url}`); return { found: true, ats: embed.ats, url: embed.url, slug: embed.slug || '', via: 'careers-search-embed', score: r.card.score, matchedTitle: r.card.text, checked }; }
      hits.unshift({ ats: 'other', slug: '', portal: new URL(r.card.href).hostname, url: r.card.href, text: r.card.text, score: r.card.score });
      break;
    }
    const own = hits.find(h => h.ats === 'other' && h.url);
    if (own) return { found: false, ats: 'other', portal: own.portal, url: own.url, via: 'careers-page-link', score: own.score, matchedTitle: own.text, checked };
    const portal = hits.find(h => h.ats === 'workday' || h.ats === 'other' || h.ats === 'smartrecruiters');
    if (portal) return { found: false, ats: 'other', portal: portal.portal || portal.ats, url: '', slug: portal.slug, via: 'careers-page-ats', checked };
    // a careers site that answered but showed no known ATS and no link with this title: an own portal rendered by its own code
    // (Northwind careers.northwind.example, Fabrikam careers.fabrikam.example, 21 Oct 2026). Record it so Eyal has the door, nothing more.
    const ownPage = checked.map(c => c.match(/^page:(\S+) \((2\d\d)\)$/)).filter(Boolean).map(m => m[1]).find(u => /careers\.|jobs\.|\/careers|\/jobs/.test(u));
    if (ownPage) { let host = ''; try { host = new URL(ownPage).hostname; } catch { /* ignore */ } return { found: false, ats: 'other', portal: host, url: ownPage, via: 'careers-page-own', checked }; }
  }
  return { found: false, ats: '', url: '', via: 'none', checked };
}
