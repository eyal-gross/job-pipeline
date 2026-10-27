import { readDoc, saveDoc, authed } from "./state.mjs";
import { hunt, ingestCandidates, kick, sweepApply, nameKey, roleKey, denyLists, knownCtx, knownReason, TITLE_EXCLUDE, TITLE_INCLUDE, TITLE_CORE, ISRAEL } from "./hunt.mjs";
import { fireRoutine } from "./research.mjs";
import { withObs, emit, error as obsError, tag, setRun, step } from "./lib/obs.mjs";

// The night FINDER, built into the board (no claude.ai routine, no PC). Netlify runs it on a schedule: every 5 minutes
// during the 00:00 UTC hour (02:00-02:55 Israel in winter). Each tick does ONE step inside the function's time budget and
// saves its progress in state.hunt.find; when the run is done the remaining ticks are no-ops. "Hunt now" on the board
// (x-key action "find" on hunt.mjs) runs the same steps back to back.
// Steps: drushim -> alljobs -> linkedin -> ats (seed + learned boards) -> resolve (aggregator hits -> the company's own
// ATS posting) -> finalize: one role per company, top `caps.offered` go to the SORTER agent (kind hunt-sort), which judges the
// postings, finds each company's real form and posts back `caps.found` picks -> ingestCandidates -> first grader. If the sorter
// does not answer within 30 min, kick() falls back to the finder's own top picks.
// From the cloud, LinkedIn and Comeet usually refuse; they are tried, failures are logged, the night goes on without them.

export const config = { schedule: "*/5 0-1,11-12 * * *" };   // two windows (Eyal, 21 Oct 2026): the night run 00:00-01:55 UTC and a day run 11:00-12:55 UTC (14:00-15:55 Israel in summer, 13:00-14:55 in winter); each window is its own run with its own prepared cap   // 02:00-03:55 Israel winter: finder steps, then the sorter agent, then the fallback if it never answers

const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const clean = (s, n = 400) => String(s ?? "").replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, "\"").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", "accept": "text/html,application/json;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9,he;q=0.8" };
const BUDGET_MS = 6500, DAY = 86400000;
const STEPS = ["drushim", "alljobs", "linkedin", "techmap", "ats", "resolve", "finalize"];   // techmap added 26 Oct 2026 (supply widening item 2)
export const QUERIES = ["AI engineer", "GenAI engineer", "LLM engineer", "solutions engineer", "product manager", "technical product manager", "product owner", "AI product", "integration engineer", "implementation engineer",   // last four added 23 Oct 2026 (Eyal)
  "software engineer AI", "backend engineer", "full stack engineer", "customer success engineer", "technical account manager", "growth product manager"];   // wider titles, 26 Oct 2026 (supply widening item 4)
const AGENCY = /השמה|כ(ו)?ח אדם|גיוס|חסוי|confidential|recruit|staffing|headhunt|manpower|placement|experis|ethosia|nisha|sqlink|unilink|יונילינק|calanit|קלאניט|dataway|visual ?dg|peax|infinity labs|gotfriends|jobinfo|comblack|hightech company|דנאל|danel|see ?v|סי ?וי/i;   // placement firms and training-and-placement shops; the big IT integrators stay
const CLIENT_SEAT = /^(לארגון|לחברה|למשרד|לסטארטאפ|לבנק|לחברת).*דרוש|לקוח|for (a|our) (leading|global|large) (client|organization|company)/i;   // "for a leading organization we need..." = hidden employer
const HEBREW_SENIOR = /ראש צוות|מנהל ?[\/.]?ת? (פיתוח|צוות)|ארכיטקט/;   // 23 Oct 2026 (Eyal): סניור / בכיר allowed now, like "senior" in English   // 22 Oct 2026 (reviewer): the dot form "מנהל.ת" is as common as "מנהל/ת" on Drushim
const BOARD_LINE = /^(greenhouse|ashby|lever|comeet|smartrecruiters|workable|bamboohr)\s+(\S+)/i;   // smartrecruiters added 22 Oct 2026: the runner has a recipe for it; workable + bamboohr 26 Oct 2026 (supply widening, discover)
export const OWN_ATS = ["greenhouse", "ashby", "lever", "comeet", "smartrecruiters", "workable", "bamboohr"];   // boards the finder reads and the worker submits on

const fetchText = async (url, ms = BUDGET_MS) => {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); const t0 = Date.now();
  try { const r = await fetch(url, { headers: UA, signal: c.signal, redirect: "follow" }); const txt = await r.text(); return { status: r.status, txt, ms: Date.now() - t0, bytes: txt.length, url }; }
  catch (e) { return { status: 0, txt: "", err: String(e && e.message || e).slice(0, 80), ms: Date.now() - t0, bytes: 0, url }; }
  finally { clearTimeout(t); }
};
// one event per source request: url, status, ms, bytes, roles seen (MONITORING-PLAN §2: "per source: request url, status, ms, roles seen")
const srcEv = (source, r, rolesSeen, extra = {}) => emit({ type: "step.end", entity_type: "run", entity_id: null, outcome: r.status === 200 ? "ok" : "fail", duration_ms: r.ms, severity: r.status === 200 ? "info" : "warn", error_class: r.status === 200 ? null : "source-request", error_cause: r.status === 200 ? null : `${source}: ${r.status || r.err}`, error_handling: r.status === 200 ? null : "handled", payload: { step: `source:${source}`, source, url: r.url, status: r.status, err: r.err || null, bytes: r.bytes, rolesSeen, ...extra } });
const uniq = a => [...new Set(a)];
const slugOf = n => clean(n, 80).toLowerCase().replace(/\.(com|io|ai|co|il)\b/g, "").replace(/\b(ltd|inc|llc|corp|co|israel)\b/g, "").replace(/&/g, "and").replace(/[^a-z0-9 ]+/g, " ").trim();
const titleOk = t => TITLE_INCLUDE.test(t) && !TITLE_EXCLUDE.test(t) && !HEBREW_SENIOR.test(t);
const daysAgo = iso => iso ? (Date.now() - Date.parse(iso)) / DAY : null;

// ---------- the run record ----------
function findState(h) {
  h.find = h.find && typeof h.find === "object" ? h.find : {};
  const f = h.find;
  f.status = f.status || "idle";        // idle | running | done
  f.raw = Array.isArray(f.raw) ? f.raw : [];
  f.funnel = f.funnel || { found: 0, dropped: {} };
  f.errors = Array.isArray(f.errors) ? f.errors : [];
  f.log = Array.isArray(f.log) ? f.log : [];
  h.boards = Array.isArray(h.boards) ? h.boards : [];   // learned "<ats> <slug>" lines, filled by the resolver
  return f;
}
// run id per window: hunt-YYYY-MM-DD for the night window, hunt-YYYY-MM-DD-day for the second one (UTC hour 8 or later)
const runIdFor = now => `hunt-${now.slice(0, 10)}${Number(now.slice(11, 13)) >= 8 ? "-day" : ""}`;
function startRun(h, now, reason) {
  h.find = { status: "running", runId: runIdFor(now), startedAt: now, step: STEPS[0], cursor: 0, raw: [], funnel: { found: 0, dropped: {} }, errors: [], log: [`started (${reason})`] };
  return h.find;
}
const drop = (f, why, c, detail) => { f.funnel.dropped[why] = (f.funnel.dropped[why] || 0) + 1; if (c) emit({ type: "decision", entity_type: "run", entity_id: f.runId, outcome: "skipped", payload: { step: c.source, item: clean(c.name, 80) || "(anonymous)", company: clean(c.name, 80), title: clean(c.title, 100), url: clean(c.url, 400), ats: c.ats || "other", source: c.source, location: clean(c.location, 80), ageDays: c.ageDays ?? null, decision: "dropped", reason: why, detail: detail || "" } }); };
function offer(f, c) {   // one looked-at role -> raw list, after the cheap guards (the board re-checks everything on ingest)
  f.funnel.found++;
  const title = clean(c.title, 100), name = clean(c.name, 80);
  if (!title || !c.url) return drop(f, "invalid", c, "title or url missing");
  if (!name) return drop(f, "anonymous", c, "aggregator card with no employer name");   // aggregator card with no employer name
  if (AGENCY.test(name) || c.agency) return drop(f, "agency", c, c.agency ? "card marked placement firm" : (name.match(AGENCY) || [])[0]);
  if (CLIENT_SEAT.test(title)) return drop(f, "agency", c, "hidden employer wording in the title");
  if (TITLE_EXCLUDE.test(title) || HEBREW_SENIOR.test(title)) return drop(f, "seniority", c, (title.match(TITLE_EXCLUDE) || title.match(HEBREW_SENIOR) || [])[0]);
  if (!TITLE_INCLUDE.test(title)) return drop(f, "title", c, "no target keyword in the title");
  if (c.location && !ISRAEL.test(c.location) && !ISRAEL.test(title)) return drop(f, "location", c, c.location);
  if (c.ageDays != null && c.ageDays > 60) return drop(f, "stale", c, `${Math.round(c.ageDays)} days old`);
  f.raw.push({ name, title, url: clean(c.url, 400), ats: c.ats || "other", source: c.source, location: clean(c.location || "Israel", 80), domain: clean(c.domain || "", 80), site: clean(c.site || "", 200), ageDays: c.ageDays ?? null });
}

// ---------- sources ----------
// Drushim's `externalApplyUrl` (23 Oct 2026, reviewer): the posting hands off to the company's site through a tracking redirect
// (stats.the-network.com/...). The worker cannot apply on Drushim for those (Contoso failed "external apply with no recipe"), so the finder
// follows the redirect once (HEAD-less GET, short budget) and either offers the landing URL on its real ATS or drops it as "external".
export const externalAts = url => { const h = String(url || "").toLowerCase(); return /greenhouse\.io/.test(h) ? "greenhouse" : /lever\.co/.test(h) ? "lever" : /ashbyhq\.com/.test(h) ? "ashby" : /comeet\.(com|co)/.test(h) ? "comeet" : /smartrecruiters\.com/.test(h) ? "smartrecruiters" : /apply\.workable\.com|\.workable\.com\/j\//.test(h) ? "workable" : /\.bamboohr\.com/.test(h) ? "bamboohr" : /myworkdayjobs\.com|workday\.com/.test(h) ? "workday" : /linkedin\.com/.test(h) ? "linkedin" : "other"; };
const followRedirect = async (url, ms = 4000) => {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { headers: UA, signal: c.signal, redirect: "follow" }); return r.url || url; } catch { return url; } finally { clearTimeout(t); }
};
async function stepDrushim(f) {
  const rs = await Promise.all(QUERIES.map(q => fetchText(`https://www.drushim.co.il/jobs/search/${encodeURIComponent(q)}/`)));
  let n = 0; const external = [];
  rs.forEach((r, i) => {
    if (r.status !== 200) { srcEv("drushim", r, 0, { query: QUERIES[i] }); return f.errors.push(`drushim "${QUERIES[i]}": ${r.status || r.err}`); }
    const m = r.txt.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/); if (!m) { srcEv("drushim", { ...r, status: 0, err: "no data block" }, 0, { query: QUERIES[i] }); return f.errors.push(`drushim "${QUERIES[i]}": no data block`); }
    let jobs = []; try { const walk = o => { if (!o || typeof o !== "object") return; if (Array.isArray(o)) { if (o.length && o[0] && o[0].jobUrl && o[0].title) jobs.push(...o); else o.forEach(walk); } else Object.values(o).forEach(walk); }; walk(JSON.parse(m[1])); } catch { srcEv("drushim", { ...r, status: 0, err: "bad data" }, 0, { query: QUERIES[i] }); return f.errors.push(`drushim "${QUERIES[i]}": bad data`); }
    for (const j of jobs) {
      n++;
      const c = { name: j.companyName, title: j.title, url: "https://www.drushim.co.il" + j.jobUrl, ats: "other", source: "drushim", location: `${(j.cities || [j.city]).filter(Boolean).join(", ")}, Israel`, ageDays: daysAgo(j.publishedAtIso) };
      if (j.externalApplyUrl && !external.some(x => x.c.url === c.url)) external.push({ c, ext: String(j.externalApplyUrl) }); else offer(f, c);
    }
    srcEv("drushim", r, jobs.length, { query: QUERIES[i] });
  });
  if (external.length) {
    const landed = await Promise.all(external.slice(0, 12).map(x => followRedirect(x.ext)));
    external.slice(0, 12).forEach((x, k) => {
      const ats = externalAts(landed[k]);
      if (OWN_ATS.includes(ats)) { f.log.push(`${x.c.name}: Drushim external apply -> ${ats}`); offer(f, { ...x.c, url: landed[k], ats }); }
      else drop(f, "external", x.c, `Drushim external apply lands on ${ats}: ${clean(landed[k], 120)}`);
    });
    external.slice(12).forEach(x => drop(f, "external", x.c, "Drushim external apply, not followed (budget)"));
  }
  f.log.push(`drushim: ${n} roles seen${external.length ? ` (${external.length} external apply)` : ""}`);
}
async function stepAlljobs(f) {
  const rs = await Promise.all(QUERIES.map(q => fetchText(`https://www.alljobs.co.il/SearchResultsGuest.aspx?page=1&position=&type=&freetxt=${encodeURIComponent(q)}&city=&region=`)));
  let n = 0;
  rs.forEach((r, i) => {
    if (r.status !== 200) { srcEv("alljobs", r, 0, { query: QUERIES[i] }); return f.errors.push(`alljobs "${QUERIES[i]}": ${r.status || r.err}`); }
    const cards = r.txt.split(/class="job-content-top"/).slice(1);
    srcEv("alljobs", r, cards.length, { query: QUERIES[i] });
    for (const card of cards) {
      const t = card.match(/UploadSingle\.aspx\?JobID=(\d+)"[^>]*>\s*(?:<h2[^>]*>)?\s*([^<]+)</); if (!t) continue;
      const comp = card.match(/\/Employer\/HP\/Default\.aspx\?cid=\d+"[^>]*>\s*([^<]+)</);
      const cities = uniq([...card.matchAll(/city=\d+&amp;region="[^>]*>\s*([^<]+)</g)].map(x => x[1].trim())).slice(0, 4);
      const date = (card.match(/job-content-top-date">\s*([^<]+)</) || [])[1] || "";
      const dm = date.match(/(\d+)\s*(ימים|יום|שבועות|שבוע|חודש)/); const age = dm ? Number(dm[1]) * (/שבוע/.test(dm[2]) ? 7 : /חודש/.test(dm[2]) ? 30 : 1) : (/היום|אתמול|שעות/.test(date) ? 0 : null);
      n++;
      offer(f, { name: comp ? comp[1] : "", title: t[2].replace(/\*+/g, "").replace(/^דרוש\/?ה\s*/, ""), url: `https://www.alljobs.co.il/Search/UploadSingle.aspx?JobID=${t[1]}`, ats: "alljobs", source: "alljobs", location: `${cities.join(", ") || "Israel"}, Israel`, ageDays: age, agency: /חברת השמה|כח אדם/.test(card.slice(0, 1500)) });
    }
  });
  f.log.push(`alljobs: ${n} roles seen`);
}
// LinkedIn's logged-out guest search answers a page of <li> job cards; the same parser runs here and on the PC (worker/linkedin-feed.mjs)
export function parseGuestCards(html) {
  const out = [];
  for (const card of String(html || "").split(/<li>/).slice(1)) {
    const title = (card.match(/base-search-card__title">\s*([^<]+?)\s*</) || [])[1], comp = (card.match(/base-search-card__subtitle">\s*<a[^>]*>\s*([^<]+?)\s*</) || [])[1];
    const loc = (card.match(/job-search-card__location">\s*([^<]+?)\s*</) || [])[1], link = (card.match(/href="(https:\/\/[a-z]{2}\.linkedin\.com\/jobs\/view\/[^"?]+)/) || [])[1], dt = (card.match(/datetime="([^"]+)"/) || [])[1];
    if (!title || !link) continue;
    out.push({ name: clean(comp, 80), title: clean(title, 100), url: link, location: clean(loc, 80) || "Israel", ageDays: daysAgo(dt) });
  }
  return out;
}
export const FEED_FRESH_H = 16;   // a PC feed older than this is ignored and the cloud search runs instead
async function stepLinkedin(f, h) {
  // supply widening item 5 (26 Oct 2026): LinkedIn refuses the cloud address most nights (about 30 roles a night got through); the PC
  // worker runs the same logged-out guest search from home before each window and hands the rows over (hunt action "feed")
  const feed = h && h.feed && h.feed.linkedin;
  if (feed && Array.isArray(feed.rows) && Date.now() - Date.parse(feed.at || 0) < FEED_FRESH_H * 3600000) {
    for (const c of feed.rows) offer(f, { ...c, ats: "linkedin", source: "linkedin" });
    emit({ type: "step.end", entity_type: "run", entity_id: f.runId, outcome: "ok", payload: { step: "source:linkedin", source: "linkedin", feed: true, feedAt: feed.at, rolesSeen: feed.rows.length, queries: feed.queries || null, pages: feed.pages || null } });
    f.log.push(`linkedin (PC feed ${String(feed.at).slice(11, 16).replace(":", "")}Z): ${feed.rows.length} roles seen`);   // no colon before the count: supply.mjs reads "<source>...: N roles seen"
    return;
  }
  const qs = ["AI engineer", "solutions engineer", "product manager"];
  const rs = await Promise.all(qs.map(q => fetchText(`https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(q)}&location=Israel&f_TPR=r604800&start=0`)));
  let n = 0, blocked = 0;
  rs.forEach((r, i) => {
    if (r.status !== 200) { blocked++; srcEv("linkedin", r, 0, { query: qs[i], refused: true }); return f.errors.push(`linkedin "${qs[i]}": ${r.status || r.err}`); }
    const cards = parseGuestCards(r.txt);
    srcEv("linkedin", r, cards.length, { query: qs[i] });
    for (const c of cards) { n++; offer(f, { ...c, ats: "linkedin", source: "linkedin" }); }
  });
  f.log.push(`linkedin: ${n} roles seen${blocked ? `, ${blocked} of ${qs.length} searches refused (cloud address)` : ""}${feed ? ` (PC feed stale, ${String(feed.at).slice(0, 16)}Z)` : ""}`);
}
// techmap (github.com/mluggy/techmap, ODbL, rebuilt daily): open roles at Israeli tech companies as one CSV per category, columns
// company, category, size, title, level, city, url, updated. Every row is in Israel (the city is in Hebrew). About a fifth of the links are
// Comeet postings the worker can submit as they are; the LinkedIn links go through resolve like any aggregator hit. Read-only, plain fetch
// (supply widening item 2, Eyal 26 Oct 2026). Attribution: the data is techmap's, used privately for Eyal's own search.
export const TECHMAP_CATS = ["product", "software", "data-science", "business", "support", "project-management"];
export function parseCsv(txt) {
  const rows = []; let row = [], cell = "", q = false; const s = String(txt || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && s[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some(x => x !== "")) rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.some(x => x !== "")) rows.push(row);
  const [head, ...body] = rows; if (!head) return [];
  return body.map(r => Object.fromEntries(head.map((k, i) => [k.trim(), r[i] ?? ""])));
}
export const stripUtm = u => { try { const x = new URL(u); for (const k of [...x.searchParams.keys()]) if (/^utm_/i.test(k)) x.searchParams.delete(k); return x.toString().replace(/\?$/, ""); } catch { return String(u || ""); } };
export function techmapRows(f, cat, rows) {
  let n = 0;
  for (const j of rows) { if (!j.title || !j.url) continue; n++; const url = stripUtm(j.url); offer(f, { name: j.company, title: j.title, url, ats: externalAts(url), source: "techmap", location: `${j.city || ""}, Israel`.replace(/^, /, ""), ageDays: daysAgo(j.updated) }); }
  return n;
}
async function stepTechmap(f) {
  const rs = await Promise.all(TECHMAP_CATS.map(c => fetchText(`https://raw.githubusercontent.com/mluggy/techmap/main/jobs/${c}.csv`)));
  let n = 0;
  rs.forEach((r, i) => {
    if (r.status !== 200) { srcEv("techmap", r, 0, { category: TECHMAP_CATS[i] }); return f.errors.push(`techmap ${TECHMAP_CATS[i]}: ${r.status || r.err}`); }
    const rows = parseCsv(r.txt); srcEv("techmap", r, rows.length, { category: TECHMAP_CATS[i] });
    n += techmapRows(f, TECHMAP_CATS[i], rows);
  });
  f.log.push(`techmap: ${n} roles seen`);
}
function boardsOf(h) {
  const lines = [...String(h.seeds || "").split(/\r?\n/), ...h.boards].map(s => s.trim()).filter(Boolean);
  return uniq(lines.map(l => { const m = l.match(BOARD_LINE); return m ? `${m[1].toLowerCase()} ${m[2]}` : ""; }).filter(Boolean));
}
async function readBoard(line) {   // -> { ok, jobs:[{title, location, url, ageDays}], site }
  const t0 = Date.now(); const b = await readBoard0(line); b.ms = Date.now() - t0; b.line = line; return b;
}
async function readBoard0(line) {
  const [ats, slug] = line.split(" ");
  if (ats === "greenhouse") { const r = await fetchText(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`); try { const j = JSON.parse(r.txt); return { ok: r.status === 200, jobs: (j.jobs || []).map(x => ({ title: x.title, location: x.location && x.location.name, url: x.absolute_url, ageDays: daysAgo(x.updated_at || x.first_published) })) }; } catch { return { ok: false, status: r.status || r.err }; } }
  if (ats === "ashby") { const r = await fetchText(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=false`); try { const j = JSON.parse(r.txt); return { ok: r.status === 200, jobs: (j.jobs || []).filter(x => x.isListed !== false).map(x => ({ title: x.title, location: x.location, url: x.jobUrl || x.applyUrl, ageDays: daysAgo(x.publishedAt) })) }; } catch { return { ok: false, status: r.status || r.err }; } }
  if (ats === "lever") { const r = await fetchText(`https://api.lever.co/v0/postings/${slug}?mode=json`); try { const j = JSON.parse(r.txt); return { ok: r.status === 200 && Array.isArray(j), jobs: (Array.isArray(j) ? j : []).map(x => ({ title: x.text, location: (x.categories || {}).location, url: x.hostedUrl, ageDays: null })) }; } catch { return { ok: false, status: r.status || r.err }; } }
  if (ats === "comeet") { const r = await fetchText(`https://www.comeet.com/jobs/${slug}`); const jobs = parseComeet(r.txt || ""); return { ok: r.status === 200 && jobs.length > 0, status: r.status || r.err, jobs }; }
  if (ats === "smartrecruiters") { const r = await fetchText(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`); try { const j = JSON.parse(r.txt); return { ok: r.status === 200 && Array.isArray(j.content), jobs: (j.content || []).map(x => ({ title: x.name, location: x.location && (x.location.fullLocation || [x.location.city, x.location.country].filter(Boolean).join(", ")), url: `https://jobs.smartrecruiters.com/${slug}/${x.id}`, ageDays: daysAgo(x.releasedDate), company: x.company && x.company.name })) }; } catch { return { ok: false, status: r.status || r.err }; } }
  // workable + bamboohr (26 Oct 2026, supply widening: discover found 3+ fitting roles on each; recipes in worker/recipes)
  if (ats === "workable") { const r = await fetchText(`https://apply.workable.com/api/v1/widget/accounts/${slug}`); try { const j = JSON.parse(r.txt); return { ok: r.status === 200 && Array.isArray(j.jobs), jobs: (j.jobs || []).map(x => ({ title: x.title, location: [x.city, x.state, x.country].filter(Boolean).join(", "), url: `https://apply.workable.com/${slug}/j/${x.shortcode}/apply/`, ageDays: daysAgo(x.published_on || x.created_at), company: j.name })) }; } catch { return { ok: false, status: r.status || r.err }; } }
  if (ats === "bamboohr") { const r = await fetchText(`https://${slug}.bamboohr.com/careers/list`); try { const j = JSON.parse(r.txt); return { ok: r.status === 200 && Array.isArray(j.result), jobs: (j.result || []).map(x => ({ title: x.jobOpeningName, location: [x.location && x.location.city, x.location && x.location.state, x.atsLocation && x.atsLocation.country].filter(Boolean).join(", "), url: `https://${slug}.bamboohr.com/careers/${x.id}`, ageDays: null })) }; } catch { return { ok: false, status: r.status || r.err }; } }
  return { ok: false, status: "unknown ats" };
}
// Comeet company pages (www.comeet.com/jobs/<company>/<uid>) carry no position links: the positions are embedded as JSON, each object
// starting {"name": "<title>", "department": ... with "location": {"name": ...}, "time_updated" and "url_comeet_hosted_page".
// (22 Oct 2026: the old href scrape found nothing on a real page; same parser as worker/reviewer/seeds.mjs.)
function parseComeet(html) {
  const starts = [...html.matchAll(/\{"name": "((?:[^"\\]|\\.)+)", "department": /g)]; const jobs = []; const seen = new Set();
  for (let i = 0; i < starts.length; i++) {
    const chunk = html.slice(starts[i].index, starts[i + 1] ? starts[i + 1].index : starts[i].index + 6000);
    const url = (chunk.match(/"url_comeet_hosted_page": "([^"]+)"/) || [])[1]; if (!url || seen.has(url)) continue; seen.add(url);
    const loc = (chunk.match(/"location": \{"name": "((?:[^"\\]|\\.)*)"/) || [])[1] || "";
    const upd = (chunk.match(/"time_updated": "([^"]+)"/) || [])[1];
    const unescape = t => { try { return JSON.parse('"' + t + '"'); } catch { return t; } };
    jobs.push({ title: clean(unescape(starts[i][1]), 100), location: clean(unescape(loc), 80) || "Israel", url, ageDays: daysAgo(upd) });
  }
  return jobs;
}
async function stepAts(f, h) {
  const all = boardsOf(h); const batch = all.slice(f.cursor, f.cursor + BOARDS_PER_TICK);
  const rs = await Promise.all(batch.map(readBoard));
  let n = 0;
  rs.forEach((b, i) => {
    const [ats, slug] = batch[i].split(" ");
    srcEv(ats, { status: b.ok ? 200 : 0, err: b.ok ? null : String(b.status || "unreadable"), ms: b.ms, bytes: null, url: batch[i] }, b.ok ? b.jobs.length : 0, { board: batch[i], learned: !String(h.seeds || "").includes(batch[i]) });
    if (!b.ok) return f.errors.push(`${batch[i]}: ${b.status || "unreadable"}`);
    for (const j of b.jobs) { n++; offer(f, { name: j.company || slug.split("/")[0].replace(/[-_]+/g, " "), title: j.title, url: j.url, ats, source: ats, location: j.location || "", ageDays: j.ageDays }); }
  });
  f.cursor += batch.length; f.log.push(`boards ${f.cursor}/${all.length}: ${n} roles seen`);
  return f.cursor >= all.length;
}
// aggregator hits (drushim / alljobs / linkedin) -> the company's own ATS posting, so the runner can submit; learns the board
// Night 24 Oct 2026 never left this step: ~550 aggregator rows, resolved one ROW at a time (Vandelay's five roles = five lookups) and the
// same board-less Israeli companies probed again every night, at 6 rows per 5-minute tick, so the window closed mid-resolve. Now:
// one lookup per COMPANY (the result is applied to all its rows), 10 companies a tick, and a company with no board on any of the three
// ATSs is remembered for 7 days (h.resolveMiss) and skipped without a fetch.
const MISS_DAYS = 7;
const RESOLVE_PER_TICK = 20, BOARDS_PER_TICK = 40;   // 26 Oct 2026 (supply widening): techmap + more boards; was 10 and 15, all fetches run in parallel inside BUDGET_MS
export function resolvePlan(f, h, now = Date.now(), per = RESOLVE_PER_TICK) {
  h.resolveMiss = h.resolveMiss && typeof h.resolveMiss === "object" ? h.resolveMiss : {};
  for (const [k, t] of Object.entries(h.resolveMiss)) if (now - Date.parse(t) > MISS_DAYS * DAY) delete h.resolveMiss[k];
  const groups = new Map();
  // a company whose own board was already read tonight needs no lookup: its ATS row is in the list and the dedupe keeps it over the aggregator row
  const ownBoard = new Set(f.raw.filter(c => OWN_ATS.includes(c.ats)).map(c => nameKey(c.name)).filter(Boolean));
  for (const c of f.raw) {
    if (OWN_ATS.includes(c.ats) || c.resolved || !/[a-z]/i.test(c.name)) continue;
    const k = nameKey(c.name); if (!k) { c.resolved = true; continue; }
    if (h.resolveMiss[k] || ownBoard.has(k)) { c.resolved = true; continue; }
    if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c);
  }
  const keys = [...groups.keys()];
  return { batch: keys.slice(0, per).map(k => ({ key: k, rows: groups.get(k) })), done: keys.length <= per };
}
async function stepResolve(f, h, st) {
  if (!f.pruned) { pruneKnown(st, f); f.pruned = true; }
  const { batch, done } = resolvePlan(f, h);
  await Promise.all(batch.map(async ({ key, rows }) => {
    let anyBoard = false;
    for (const r of rows) r.resolved = true;
    const c = rows[0];
    const base = slugOf(c.name); if (!base) return;
    const variants = uniq([base.replace(/ /g, ""), base.replace(/ /g, "-")].filter(v => v.length >= 3));   // no first-word guesses: "north" is not Northwind
    const tries = []; for (const v of variants) for (const ats of ["greenhouse", "ashby", "lever"]) tries.push(`${ats} ${v}`);
    const rs = await Promise.all(tries.map(readBoard));
    let resolved = null;
    for (let i = 0; i < rs.length; i++) {
      if (!rs[i].ok || !rs[i].jobs.length) continue;
      if (!h.boards.includes(tries[i])) h.boards.push(tries[i]);
      anyBoard = true; let hits = 0, firstUrl = "";
      for (const r of rows) {   // every role of this company is matched against the one board read
        const want = nameKey(r.title.replace(/[^\w\s]/g, " ")); const hit = rs[i].jobs.find(j => titleOk(j.title) && (nameKey(j.title) === want || ISRAEL.test(j.location || "") && TITLE_INCLUDE.test(j.title) && j.title.toLowerCase().split(/\W+/).filter(w => w.length > 2).every(w => r.title.toLowerCase().includes(w))));
        if (hit) { r.url = hit.url; r.ats = tries[i].split(" ")[0]; r.location = hit.location || r.location; hits++; firstUrl = firstUrl || hit.url; }
      }
      if (hits) { f.log.push(`${c.name}: found on ${tries[i]} (${hits} of ${rows.length} roles)`); resolved = { board: tries[i], hit: true, url: firstUrl }; }
      else { f.log.push(`${c.name}: board ${tries[i]} known, role not listed there`); resolved = { board: tries[i], hit: false, listed: rs[i].jobs.length }; }
      break;
    }
    // remember a clean miss (every ATS answered "no such board"); a network error or a 5xx is not a miss
    if (!anyBoard && rs.every(r => r.ok || [400, 404, 410].includes(Number(r.status)))) h.resolveMiss[key] = new Date().toISOString();
    emit({ type: "decision", entity_type: "run", entity_id: f.runId, outcome: resolved && resolved.hit ? "ok" : "skipped", payload: { step: "resolve", item: c.name, company: c.name, title: c.title, source: c.source, decision: resolved ? (resolved.hit ? "resolved to own ATS" : "board known, role not listed") : "no board found", reason: resolved ? (resolved.hit ? resolved.board : `${resolved.board}: ${resolved.listed} other roles`) : `tried ${tries.length} boards`, tried: tries, url: c.url, ats: c.ats, ms: rs.reduce((a, b) => a + (b.ms || 0), 0) } });
  }));
  h.boards = h.boards.slice(-300);
  const miss = Object.entries(h.resolveMiss); if (miss.length > 600) h.resolveMiss = Object.fromEntries(miss.sort((a, b) => a[1] < b[1] ? 1 : -1).slice(0, 600));
  return done;
}
// Known roles out BEFORE the offered cap (supply widening item 1, Eyal 26 Oct 2026): the day run of 26 Oct offered 48 of 60 slots to
// companies whose role was already on the board or in the ledger, and the sorter's picks were then refused as sameRole. The same rules
// ingest applies (never-twice role, blocked company, company cap, role family) now run on the raw list: once before resolve (no lookups
// spent on known companies) and again in finalize. Ingest keeps its own checks as the safety net.
export function pruneKnown(st, f) {
  const ctx = knownCtx(st), counts = {}; const keep = [];
  for (const c of f.raw) { const why = knownReason(st, ctx, { name: c.name, domain: c.domain, title: c.title }); if (why) { counts[why] = (counts[why] || 0) + 1; drop(f, `known:${why}`, c, "already on the board, in the ledger or over the company rule"); } else keep.push(c); }
  f.raw = keep; f.droppedKnown = f.droppedKnown || {}; for (const [k, v] of Object.entries(counts)) f.droppedKnown[k] = (f.droppedKnown[k] || 0) + v;
  return counts;
}
// own-ATS first (the runner can submit), then Israeli boards, then LinkedIn; inside a tier the core titles (AI / solutions / PM) come before
// the wide ones added 26 Oct 2026 (software / backend / full stack / customer success / growth / automation), then fresher first
const rank = c => (OWN_ATS.includes(c.ats) ? 0 : ["drushim", "alljobs"].includes(c.ats) ? 1 : c.ats === "linkedin" ? 2 : 3) + (TITLE_CORE.test(c.title) ? 0 : 0.4) + (c.ageDays == null ? 0.5 : Math.min(c.ageDays, 60) / 100);
const pick = c => ({ name: c.name, site: c.site, domain: c.domain, source: c.source, title: c.title, url: c.url, ats: c.ats, location: c.location });
// finalize: one offer per ROLE (company + title, 23 Oct 2026), at most 2 per company so one big board does not fill the list; hand the top to the sorter
async function finalize(st, h, f, site) {
  pruneKnown(st, f);
  const known = Object.values(f.droppedKnown || {}).reduce((a, b) => a + b, 0);
  const seen = new Set(), perCo = {}; const offered = [];
  for (const c of [...f.raw].sort((a, b) => rank(a) - rank(b))) { const k = nameKey(c.name); const rk = roleKey(c.name, c.title); if (!k || seen.has(rk) || (perCo[k] || 0) >= 2) { drop(f, "duplicate"); continue; } seen.add(rk); perCo[k] = (perCo[k] || 0) + 1; offered.push(pick(c)); }
  f.offered = offered.slice(0, Math.max(h.caps.found, h.caps.offered || 40)); f.raw = [];
  f.brief0 = `Finder: ${f.log.filter(l => /roles seen/.test(l)).join("; ")}. ${known} known dropped before the cap. ${offered.length} companies, ${f.offered.length} offered to the sorter.`;
  f.offered.forEach((c, i) => emit({ type: "decision", entity_type: "run", entity_id: f.runId, outcome: "ok", payload: { step: "finalize", item: c.name, company: c.name, title: c.title, url: c.url, ats: c.ats, source: c.source, location: c.location, decision: "offered", rank: i + 1, reason: `rank ${i + 1} of ${offered.length}` } }));
  offered.slice(f.offered.length).forEach((c, i) => emit({ type: "decision", entity_type: "run", entity_id: f.runId, outcome: "skipped", payload: { step: "finalize", item: c.name, company: c.name, title: c.title, url: c.url, ats: c.ats, source: c.source, decision: "dropped", reason: "capOffered", rank: f.offered.length + i + 1 } }));
  emit({ type: "step.end", entity_type: "run", entity_id: f.runId, outcome: "ok", payload: { step: "finalize", found: f.funnel.found, dropped: f.funnel.dropped, droppedKnown: f.droppedKnown || {}, companies: offered.length, offered: f.offered.length, capOffered: Math.max(h.caps.found, h.caps.offered || 40), errors: f.errors } });
  f.status = "sorting"; f.firedAt = new Date().toISOString();
  st.huntRun = { status: "running", requestedAt: f.startedAt, step: "sorting (the sorter agent picks, up to 30 min)" };
  const payload = { kind: "hunt-sort", runId: f.runId, caps: h.caps, offered: f.offered, deny: denyLists(st), callback: `${site}/.netlify/functions/hunt`, board: `${site}/.netlify/functions/hunt`, brief: `${site}/hunt-sort-brief.md` };
  let r; try { r = await fireRoutine(payload); } catch (e) { r = { ok: false, error: String(e && e.message || e).slice(0, 80) }; }
  if (r.ok) { f.log.push(`sorter fired with ${f.offered.length} companies`); return { sorting: true }; }
  f.log.push(`sorter could not be fired (${r.error || r.status})`);
  return sortFallback(st, h, `sorter could not be fired (${r.error || r.status}) - used the finder's own pick`);
}
// the sorter never answered (or could not be fired): the finder's own top picks become the candidates
export function sortFallback(st, h, why) {
  const f = h.find; if (!f || f.status !== "sorting") return null;
  const candidates = (f.offered || []).slice(0, h.caps.found);
  emit({ type: "decision", entity_type: "run", entity_id: f.runId, outcome: "ok", severity: "warn", payload: { step: "sortFallback", item: f.runId, decision: "finder's own pick used", reason: why, picks: candidates.map(c => c.name) } });
  const res = ingestCandidates(st, { runId: f.runId, funnel: f.funnel, errors: [...(f.errors || []), why], brief: `${f.brief0 || ""} ${why}.`, candidates });
  f.status = "done"; f.finishedAt = new Date().toISOString(); f.offered = []; f.log.push(`fallback: offered ${candidates.length}, board created ${res.created || 0}`);
  delete st.huntRun;
  return res;
}

// one step; returns { step, done }
export async function findStep(st, site, { manual = false } = {}) {
  const h = hunt(st); const f = findState(h); const now = new Date().toISOString();
  setRun(f.runId || runIdFor(now));
  const tick = (payload, outcome = "ok") => emit({ type: "step.end", entity_type: "run", entity_id: h.find && h.find.runId || null, outcome, payload: { step: "tick", manual, ...payload } });
  if (h.killSwitch) { if (f.status === "running") { f.status = "done"; f.log.push("kill switch on - run abandoned"); delete st.huntRun; } tick({ note: "kill switch on", abandoned: f.status === "done" }, "skipped"); return { step: "killSwitch", done: true }; }
  if (f.status === "sorting") { const k = await kick(st, site); tick({ note: f.status === "sorting" ? "sorter agent is working" : "sorter fallback used", kicked: k, waitingMin: Math.round((Date.now() - Date.parse(f.firedAt || 0)) / 60000) }, "skipped"); return { step: "sorting", done: true, note: f.status === "sorting" ? "sorter agent is working" : "sorter fallback used", kicked: k }; }
  if (f.status !== "running") {
    const ranToday = f.runId === runIdFor(now) && f.status === "done";   // per window: the day run has its own id
    if (!manual && ranToday) { tick({ note: "already ran in this window", idle: true }, "skipped"); return { step: "idle", done: true, note: "already ran in this window" }; }
    startRun(h, now, manual ? "hunt now" : "schedule");
    setRun(h.find.runId);
    emit({ type: "step.start", entity_type: "run", entity_id: h.find.runId, payload: { step: "run", reason: manual ? "hunt now" : "schedule", boards: boardsOf(h).length } });
  } else if (Date.now() - Date.parse(h.find.startedAt) > 3 * 3600000 && h.find.step !== "finalize") { h.find.errors.push("run took too long - closing with what was found"); h.find.step = "finalize"; obsError("run-too-long", "run took more than 3 h - closing with what was found", { handling: "handled", severity: "warn", entity_type: "run", entity_id: h.find.runId, payload: { step: h.find.step, startedAt: h.find.startedAt } }); }
  const run = h.find; st.huntRun = { status: "running", requestedAt: run.startedAt, step: run.step };
  const t0 = Date.now(); let advance = true; const rawBefore = run.raw.length, errBefore = run.errors.length;
  const endStep = step(run.step, { entity_type: "run", entity_id: run.runId, payload: { cursor: run.cursor, manual } });
  try {
    if (run.step === "drushim") await stepDrushim(run);
    else if (run.step === "alljobs") await stepAlljobs(run);
    else if (run.step === "linkedin") await stepLinkedin(run, h);
    else if (run.step === "techmap") await stepTechmap(run);
    else if (run.step === "ats") advance = await stepAts(run, h);
    else if (run.step === "resolve") advance = await stepResolve(run, h, st);
    else if (run.step === "finalize") { const r = await finalize(st, h, run, site); await kick(st, site); sweepApply(st); endStep("ok", { next: run.status === "sorting" ? "sorting" : "done", sorting: !!(r && r.sorting), found: run.funnel.found, offered: (run.offered || []).length }); emit({ type: "step.end", entity_type: "run", entity_id: run.runId, outcome: "ok", duration_ms: Date.now() - Date.parse(run.startedAt), payload: { step: "run", next: run.status, found: run.funnel.found, dropped: run.funnel.dropped, errors: run.errors.length, log: run.log.slice(-12) } }); return { step: "finalize", next: run.status === "sorting" ? "sorting" : "done", done: true, ms: Date.now() - t0, sorting: !!(r && r.sorting) }; }
  } catch (e) { run.errors.push(`${run.step}: ${String(e && e.message || e).slice(0, 120)}`); obsError("step-threw", `${run.step}: ${String(e && e.message || e).slice(0, 300)}`, { handling: "handled", entity_type: "run", entity_id: run.runId, payload: { step: run.step, stack: String(e && e.stack || "").slice(0, 800) } }); }
  const done_step = run.step;
  if (advance) { run.step = STEPS[STEPS.indexOf(run.step) + 1] || "finalize"; run.cursor = 0; }
  st.huntRun.step = run.step;
  endStep(run.errors.length > errBefore ? "fail" : "ok", { next: run.step, advance, rawAdded: run.raw.length - rawBefore, raw: run.raw.length, found: run.funnel.found, errorsAdded: run.errors.slice(errBefore), log: run.log.slice(-3) });
  return { step: done_step, next: run.step, done: false, ms: Date.now() - t0, raw: run.raw.length };
}

export default withObs("netlify:hunt-find", async (req) => {
  // Netlify's scheduler POSTs with no auth headers; a browser or script must carry x-key. Scheduled functions are not
  // reachable over HTTP in production, so the x-key path only matters for `netlify dev`.
  let body = {}; try { body = await req.json(); } catch {}
  const scheduled = body && typeof body.next_run === "string";
  tag({ scheduled, action: "find-tick" });
  if (!scheduled && !authed(req)) return json({ error: "unauthorized" }, 401);
  const doc = await readDoc(); const st = doc.state; const site = process.env.URL || new URL(req.url).origin;
  const r = await findStep(st, site, { manual: false });
  st.updatedAt = new Date().toISOString();
  const w = await saveDoc(doc, st, { what: `finder tick ${r.step}` });
  if (w.conflict) return json({ ok: false, conflict: true, rev: w.rev, ...r, note: "board changed during the tick - the step runs again next tick" }, 200);   // the scheduler ignores the body; the step is redone next tick
  return json({ ok: true, ...r });
});
