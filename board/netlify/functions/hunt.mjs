import { readDoc, saveDoc, conflictResponse, authed } from "./state.mjs";
import { fireRoutine } from "./research.mjs";
import { withObs, emit, error as obsError, refused, refused as refusedEv, tag, setRun, step } from "./lib/obs.mjs";

// Practice-tier hunt + apply loop, v2: finder -> grader per company -> preparer per role (only grade <= 6). One agent at a time.
//  GET  with x-secret                        -> board summary the finder and the workers read (deny list, caps, answer bank, titles).
//  POST with x-secret {candidates:[...]}     -> a candidate list (the built-in finder in hunt-find.mjs calls ingestCandidates directly; this path stays for a manual or agent finder). Server: never-twice, title/location guards, cap, creates
//                                               candidate cards, fires the first worker.
//  POST with x-secret {kind:"sort", ...}     -> the SORTER agent's pick from the finder's offered list -> candidate cards (fallback: finder's own pick after 30 min).
//  POST with x-secret {kind:"grade", ...}    -> one GRADER's result: research + grade -> lane. Practice lane queues the preparer.
//  POST with x-secret {kind:"prep", ...}     -> one PREPARER's result: form fields, screeners, package -> prepared or manual. Fires the next job.
//  POST with x-key {action}                  -> page / Claude Code / runner: apply {roleId,patch}, settings, kick, sweep, ledger, find (one finder step),
//                                               worker {claim:true,max} (the PC worker takes the oldest queued cards, atomically -> submitting) / worker {report} (heartbeat + today's counts).
// Hands-off mode (hunt.autoQueue, default on): a prepared card with a recipe, no open screener and no flag is queued (status approved) for the PC
// worker at prep time; anything else is forfeited (status skipped, reason "forfeited: ..."). Eyal can revive a forfeited card by hand.
// Only apply.status === 'submitted' ever moves a role to stage 'applied'. Real-tier cards are never applied to by the system.

const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const uid = () => Math.random().toString(36).slice(2, 9);
const clean = (s, n = 400) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const fmt = d => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const host = u => { if (!u || typeof u !== "string") return ""; try { return new URL(/^https?:/.test(u) ? u : "https://" + u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const secretOk = req => (req.headers.get("x-secret") || "") === (process.env.RESEARCH_SECRET || "__unset__");
const GENERIC = /linkedin|framerusercontent|website-files|cdn\.|cloudfront|amazonaws|crunchbase|google|notion|github|wikipedia|techcrunch|calcalist|globes|ycombinator|comeet|lever|ashby|greenhouse|workday|workable|bamboohr|smartrecruiters|alljobs|drushim|^undefined$|^null$/i;

// Filters loosened by Eyal 23 Oct 2026: senior / sr / סניור / בכיר and "product lead" are allowed now; team / tech / engineering lead,
// AllJobs also writes the gender mark after a space ("מנהל /ת מוצר"); both regexes accept it (reviewer, 24 Oct).
// staff, principal, director, VP, chief, group stay out; head is allowed too (Eyal, 23 Oct). Added titles: product owner, product lead, implementation / integration / customer engineer.
// Wider titles (supply widening item 4, Eyal 26 Oct 2026): software / backend / full-stack engineers (the sorter keeps them only at AI
// companies), customer success / technical account seats, growth, automation. Still out: forward deployed, deployment strategist,
// founding / product engineer (Eyal's real-tier targets, LOG 11 Oct), QA / test automation, and chip / embedded stacks.
export const TITLE_EXCLUDE = /\b(staff|principal|(team|tech|engineering|development|management) lead(er)?|group|director|vp|chief|forward.?deployed|deployment strateg|researcher|ml engineer|intern|student|founding|product engineer|qa|test automation|automation test(ing)?|quality assurance|(embedded|firmware|hardware|fpga|asic|rtl|kernel|board|verification)( software)? (engineer|developer))\b|c\+\+|ראש צוות|מנהל ?[\/.]?ת? (פיתוח|צוות)|ארכיטקט|בודק|אוטומציה ל?בדיקות/i;
export const TITLE_CORE = /\b(ai|llm|genai|gen ai|generative|machine learning|solutions? (engineer|architect)|product manager|product management|product owner|product lead|technical pm|technical product|tpm|applied ai|ai builder|(implementation|integrations?|customer) engineer)\b|מנהל ?[\/.]?ת? (תחום |מחלקת )?מוצר/i;
export const TITLE_WIDE = /\b(software (engineer|developer)|back.?end (engineer|developer)|full.?stack (engineer|developer)|customer success (engineer|manager)|technical account (engineer|manager)|growth (manager|product|engineer|pm|lead)|automation (engineer|developer))\b|מהנדס ?[\/.]?ת? תוכנה|מפתח ?[\/.]?ת? (full ?stack|פול ?סטא?ק|back ?end|בק ?אנד)/i;
export const TITLE_INCLUDE = new RegExp(`${TITLE_CORE.source}|${TITLE_WIDE.source}`, "i");
export const ISRAEL = /\b(israel|tel.?aviv|tlv|jerusalem|haifa|herzliya|herzlia|petah|petach|ra.?anana|netanya|rehovot|ramat.?gan|giv.?atayim|holon|rishon|kfar.?saba|hod.?hasharon|yokneam|be.?er.?sheva|modi.?in|caesarea|rosh.?ha.?ayin|or.?yehuda|bnei.?brak|ness.?ziona|kiryat|israeli)\b|ישראל|תל.?אביב/i;
export const ATS_AUTO = new Set(["comeet", "lever", "ashby", "greenhouse", "smartrecruiters", "drushim", "alljobs", "workable", "bamboohr"]);   // workable + bamboohr 26 Oct 2026 (supply widening, recipes dry-run on 2 postings each)   // smartrecruiters added 21 Oct 2026 (Fabrikam, Northwind)   // the PC worker has a recipe for these (drushim / alljobs = one-click apply, logged in)
export const ATS_ALL = new Set(["comeet", "lever", "ashby", "greenhouse", "smartrecruiters", "workable", "bamboohr", "workday", "linkedin", "alljobs", "drushim", "other"]);
export const CVS = new Set(["engineer-big", "engineer-seed", "tpm"]);
export const APPLY_STATUSES = new Set(["candidate", "prepared", "approved", "submitting", "submitted", "confirmed", "unverified", "blocked", "failed", "skipped", "manual", "real"]);
const DAY = 86400000, MIN = 60000;
const WORKER_TIMEOUT = 30 * MIN, WORKER_ATTEMPTS = 2;
const RUNS_KEPT = 365;   // night run records kept on the board (was 30; the PC's obs.db is the archive, this is the board's own memory)

// Company name normaliser for never-twice: "Initech Technologies Ltd." and "ness technologies" are the same company.
export function nameKey(n) {
  return clean(n, 120).toLowerCase()
    .replace(/\.(com|io|ai|co|il)\b/g, " ")
    .replace(/\b(ltd|inc|llc|gmbh|corp|co|technologies|technology|tech|labs|lab|ai|io|com|israel|group|systems|software|solutions)\b/g, " ")
    .replace(/[^a-z0-9֐-׿]+/g, "").trim();
}
// Role rule (Eyal, 23 Oct 2026): one application per ROLE, not per company. A role = company + its title with gender marks, seniority words,
// a trailing location and punctuation stripped, so "Senior Product Manager - Tel Aviv" and "Product Manager" at one company are the same role.
export function titleKey(t) {
  return clean(t, 160).toLowerCase()
    .replace(/\s[-–|,]\s.*$/, " ")                       // "Product Manager - Tel Aviv", "PM | Payments"
    .replace(/\((m\/f|f\/m|m\/w|all genders?|hybrid|remote)[^)]*\)/g, " ")
    .replace(/[\/.]י?ת(?=\s|$)/g, " ")                   // מנהל/ת, מנהל.ת, מפתח/ית (\b does not work on Hebrew letters)
    .replace(/\b(senior|sr|jr|junior|mid|ii|iii|i)\b|סניור|בכיר|ה?ג'וניור/g, " ")
    .replace(/[^a-z0-9֐-׿]+/g, "").trim();
}
export const roleKey = (companyName, title) => `${nameKey(companyName)}|${titleKey(title)}`;
// Company rule (Eyal, 25 Oct 2026): at most 2 OPEN applications per company, and only in one role family (both product, both engineering,
// or both solutions), so a recruiter who sees every application in one ATS profile reads focus, not spray. Open = on its way or sent and not
// closed (rejected / closed stage, forfeited, failed, manual and blocked cards do not count). Applications already sent are never touched.
export const COMPANY_MAX_OPEN = 2;
export function roleFamily(t) {
  const s = clean(t, 160).toLowerCase();
  if (/solutions?\s*(engineer|architect|consultant)|sales engineer|pre-?sales|implementation|integrations?\b|customer engineer|customer success|technical account|delivery|consultant|assurance/.test(s)) return "solutions";   // customer success / technical account: 26 Oct 2026 (wider titles)
  if (/product\s*(manager|management|owner|lead|associate)|technical pm|\btpm\b|growth (manager|product|pm|lead)|מוצר/.test(s)) return "product";
  if (/engineer|developer|devops|full.?stack|back.?end|front.?end|architect|מפתח|מהנדס|פיתוח/.test(s)) return "engineering";
  return "other";
}
const CLOSED_APPLY = new Set(["skipped", "failed", "manual", "blocked", "real"]);
export function openRolesAt(st, { name, domain }) {
  const d = host(domain || ""), k = nameKey(name || "");
  const cos = new Set(st.companies.filter(c => (k && nameKey(c.name) === k) || (d && domainsOf(c).includes(d))).map(c => c.id));
  return st.roles.filter(r => cos.has(r.companyId) && r.apply && !CLOSED_APPLY.has(r.apply.status) && r.stage !== "closed");
}
export function domainsOf(c) {
  const links = String(c.links || "").split(/[\s,]+/).map(host).filter(Boolean);
  const r = c.research || {};
  const extra = [r.logo, r.site, c.hunt && c.hunt.domain].map(host).filter(Boolean);
  return [...new Set([...links, ...extra])].filter(h => h && !GENERIC.test(h)).slice(0, 5);
}
export function hunt(st) {
  st.hunt = st.hunt || {};
  const h = st.hunt;
  h.killSwitch = !!h.killSwitch;
  h.caps = { found: 10, prepared: 5, offered: 40, perDay: 8, ...(h.caps || {}) };   // offered = how many the finder hands the sorter agent; perDay = submissions the PC worker may make per day
  h.autoQueue = h.autoQueue !== false;   // hands-off: prepared cards are queued for the PC worker without a morning approval
  h.worker = h.worker && typeof h.worker === "object" ? h.worker : {};   // PC worker heartbeat: lastAt, machine, chrome, lastError, lastReport
  h.concurrency = Number.isInteger(h.concurrency) && h.concurrency >= 1 ? Math.min(h.concurrency, 5) : 1;   // workers at once; 1 = chain
  h.denyExtra = String(h.denyExtra || "");
  h.seeds = String(h.seeds || "");   // job boards to check first, one per line: "<ats> <slug>"
  h.answerBank = String(h.answerBank || "");
  h.answerBankAt = h.answerBankAt || "";
  h.applied = Array.isArray(h.applied) ? h.applied : [];
  h.lastRun = h.lastRun || null;
  h.runs = Array.isArray(h.runs) ? h.runs : [];
  return h;
}
// What the hunt may not offer. Since the role rule (23 Oct 2026) a company is blocked WHOLE only when it is real tier (or graded above 6),
// on the dreamlist, busy tonight (a role of it is still being graded / prepared), or in the ledger without a known role (a hand-sent application).
// Every other practice company stays open for NEW roles; `roles` lists the role keys already taken (on the board or in the ledger).
const BUSY = new Set(["candidate", "grading", "graded", "preparing"]);
const ledgerTitle = (st, a) => a.title || ((a.roleId && st.roles.find(r => r.id === a.roleId)) || {}).title || "";
export function denyLists(st) {
  const h = hunt(st);
  const domains = new Set(), names = new Set(), roles = new Set();
  const block = c => { domainsOf(c).forEach(d => domains.add(d)); if (nameKey(c.name)) names.add(nameKey(c.name)); };
  for (const c of st.companies) {
    const g = gradeOf(c);
    if (c.tier !== "practice" || (g !== null && g > 6) || (c.hunt && BUSY.has(c.hunt.status))) block(c);
  }
  for (const r of st.roles) { const c = st.companies.find(x => x.id === r.companyId); if (c && r.apply) roles.add(roleKey(c.name, r.title)); }
  for (const a of h.applied) {
    const t = ledgerTitle(st, a);
    if (t) roles.add(roleKey(a.name, t));
    else { if (a.domain) domains.add(host(a.domain) || a.domain); if (nameKey(a.name)) names.add(nameKey(a.name)); }
  }
  for (const line of h.denyExtra.split(/\r?\n/)) { const t = clean(line, 120); if (!t) continue; const d = /\./.test(t) ? host(t) : ""; if (d) domains.add(d); if (nameKey(t)) names.add(nameKey(t)); }
  return { domains: [...domains], names: [...names], roles: [...roles] };
}
// The deny lists and every company's open roles, computed once, so a loop over thousands of finder rows can ask onBoard() cheaply
// (supply widening item 1, 26 Oct 2026: the finder pre-filters known roles before the offered cap). Same answers as openRolesAt().
export function knownCtx(st) {
  const deny = denyLists(st);
  const ctx = { domains: new Set(deny.domains), names: new Set(deny.names), roles: new Set(deny.roles), openByName: new Map(), openByDomain: new Map() };
  const add = (m, k, rs) => { if (!k || !rs.length) return; m.set(k, [...(m.get(k) || []), ...rs]); };
  for (const c of st.companies) {
    const open = st.roles.filter(r => r.companyId === c.id && r.apply && !CLOSED_APPLY.has(r.apply.status) && r.stage !== "closed");
    add(ctx.openByName, nameKey(c.name), open);
    for (const d of domainsOf(c)) add(ctx.openByDomain, d, open);
  }
  return ctx;
}
const openFromCtx = (ctx, k, d) => { const seen = new Map(); for (const r of [...((k && ctx.openByName.get(k)) || []), ...((d && ctx.openByDomain.get(d)) || [])]) seen.set(r.id, r); return [...seen.values()]; };
// Is this company blocked, this exact role already taken, the company at its open cap, or the role in another family? Returns the reason
// ("domain" | "name" | "role" | "companyCap" | "family") or "".
export function onBoard(st, { name, domain, title }, ctx = knownCtx(st)) {
  const d = host(domain || ""), k = nameKey(name || "");
  if (d && ctx.domains.has(d)) return "domain";
  if (k && ctx.names.has(k)) return "name";
  if (title && ctx.roles.has(roleKey(name, title))) return "role";
  if (title) {
    const open = openFromCtx(ctx, k, d);
    if (open.length >= COMPANY_MAX_OPEN) return "companyCap";
    const fam = roleFamily(title);
    if (open.some(r => roleFamily(r.title) !== fam)) return "family";
  }
  return "";
}
// The finder's names for the same answers: blocked (real tier, grade 7+, dreamlist, busy tonight, a hand-sent ledger entry), sameRole, companyCap, roleFamily.
const KNOWN = { domain: "blocked", name: "blocked", role: "sameRole", companyCap: "companyCap", family: "roleFamily" };
export const knownReason = (st, ctx, row) => KNOWN[onBoard(st, row, ctx)] || "";
// An open practice company already on the board under this name / domain: a new role attaches to it instead of a second company card.
export function practiceCompany(st, { name, domain }) {
  const d = host(domain || ""), k = nameKey(name || "");
  return st.companies.find(c => c.tier === "practice" && ((k && nameKey(c.name) === k) || (d && domainsOf(c).includes(d)))) || null;
}
const gradeOf = c => { const g = c && c.research && c.research.fit && c.research.fit.grade; return Number.isInteger(g) && g >= 1 && g <= 10 ? g : null; };
const roleCompany = (st, r) => st.companies.find(c => c.id === r.companyId);
export function confirmApply(r) {
  const a = r.apply; if (!a) return false;
  if (a.status === "submitted" || a.status === "unverified") { a.status = "confirmed"; a.confirmedAt = new Date().toISOString(); return true; }
  return false;
}
function ledgerPush(st, r, c, at) {
  const h = hunt(st);
  if (h.applied.some(a => a.roleId === r.id)) return;
  h.applied.push({ domain: domainsOf(c)[0] || (c.hunt && c.hunt.domain) || "", name: c.name, title: r.title || "", roleKey: roleKey(c.name, r.title), at: at || new Date().toISOString(), roleId: r.id });
  emit({ type: "ledger", trace_id: r.id, entity_type: "company", entity_id: c.id, payload: { company: c.name, domain: domainsOf(c)[0] || (c.hunt && c.hunt.domain) || "", roleId: r.id, by: "board", note: "submitted" } });
}
// Time-based moves: submitted + 3 days without an ack -> unverified (never retried); submitting + 2 h -> unverified/timeout (the click may have
// happened, so the company stays blocked for never-twice; never retried).
export function sweepApply(st, now = Date.now()) {
  let moved = 0;
  const sweep = (r, from, reason, cause) => { const c = roleCompany(st, r); emit({ type: "transition", trace_id: r.id, entity_type: "role", entity_id: r.id, outcome: "unverified", error_class: "sweep", error_cause: cause, error_handling: "unverified", payload: { company: c && c.name, title: r.title, field: "apply.status", from, to: "unverified", reason, by: "sweep", ats: r.apply.ats, workerId: r.apply.workerId || null, runId: r.apply.runId || null } }); };
  for (const r of st.roles) {
    const a = r.apply; if (!a) continue;
    if (a.status === "submitted" && a.submittedAt && now - Date.parse(a.submittedAt) > 3 * DAY) {
      a.status = "unverified"; a.unverifiedAt = new Date(now).toISOString();
      r.nextAction = `Submitted ${fmt(a.submittedAt)}, no receipt after 3 days - check by hand`; moved++;
      sweep(r, "submitted", "no receipt after 3 days", `submitted ${a.submittedAt}, no receipt filed in 3 days`);
    }
    if (a.status === "submitting" && a.startedAt && now - Date.parse(a.startedAt) > 2 * 3600000) {
      a.status = "unverified"; a.unverifiedAt = new Date(now).toISOString(); a.reason = "timeout";
      r.nextAction = "Worker never reported back - unknown whether it was sent; check by hand"; moved++;
      sweep(r, "submitting", "timeout", `claimed ${a.startedAt}, worker never reported back in 2 h`);
    }
  }
  return moved;
}
const queueCounts = st => { const q = { candidate: 0, working: 0, prepared: 0, approved: 0, submitting: 0, submitted: 0, confirmed: 0, unverified: 0, blocked: 0, failed: 0, skipped: 0 }; for (const r of st.roles) { if (!r.apply) continue; const c = roleCompany(st, r); if (r.apply.status === "candidate") q[c && c.hunt && c.hunt.status !== "candidate" ? "working" : "candidate"]++; else if (q[r.apply.status] !== undefined) q[r.apply.status]++; } return q; };

function summary(st) {
  const h = hunt(st);
  const companies = st.companies.map(c => ({ id: c.id, name: c.name, domains: domainsOf(c), grade: gradeOf(c), tier: c.tier === "practice" ? "practice" : "real",
    roles: st.roles.filter(r => r.companyId === c.id).map(r => ({ id: r.id, title: r.title, stage: r.stage, apply: r.apply ? r.apply.status : null })) }));
  return { at: new Date().toISOString(), lastRun: h.lastRun, killSwitch: h.killSwitch, caps: h.caps, autoQueue: h.autoQueue, worker: h.worker, queue: queueCounts(st), companies, deny: denyLists(st), answerBank: h.answerBank, seeds: h.seeds,
    titles: { include: "AI engineer / solutions engineer in any wording, AI solutions engineer, applied AI engineer, AI builder, Solutions Architect (AI), Product Manager, Technical Product Manager; since 26 Oct 2026 also software / backend / full-stack / automation engineer (AI companies only), customer success / technical account, growth PM", exclude: TITLE_EXCLUDE.source } };
}

// ---------- the chain: one job at a time (`concurrency`), a job = grade a company, or prep a role ----------
// company.hunt.status: candidate -> grading -> graded -> preparing -> done | failed | dropped
const WAITING = { candidate: "grading", graded: "preparing" };
export async function kick(st, site) {
  const h = hunt(st), now = Date.now();
  const waiting = () => st.companies.filter(c => c.hunt && WAITING[c.hunt.status]);
  const running = () => st.companies.filter(c => c.hunt && (c.hunt.status === "grading" || c.hunt.status === "preparing"));
  const fired = [], events = [];
  const fireEv = (outcome, payload, extra = {}) => emit({ type: "fire", outcome, entity_type: "run", entity_id: h.lastRun && h.lastRun.runId || null, ...extra, payload: { step: "kick", ...payload } });
  if (h.killSwitch) { fireEv("skipped", { reason: "kill switch on", waiting: waiting().length, running: running().length }); return { fired, events: ["kill switch on"] }; }
  // routine rate limit (27 Oct 2026): a 429 from the trigger pauses all firing until the time it names; nothing is burned meanwhile
  if (h.fireBackoffUntil && now < Date.parse(h.fireBackoffUntil)) { events.push(`routine rate limit - firing paused until ${h.fireBackoffUntil}`); return { fired, events }; }
  if (h.fireBackoffUntil) delete h.fireBackoffUntil;
  reviveRateLimited(st);
  // the sorter agent never answered: use the finder's own pick so the night goes on
  if (h.find && h.find.status === "sorting" && now - Date.parse(h.find.firedAt || 0) >= WORKER_TIMEOUT) {
    const { sortFallback } = await import("./hunt-find.mjs");
    const r = sortFallback(st, h, "sorter did not answer within 30 min - used the finder's own pick");
    events.push(`sorter did not answer - finder's pick used (${r && r.created || 0} cards)`);
    obsError("sorter-timeout", "sorter agent did not answer within 30 min", { handling: "handled", entity_type: "run", entity_id: h.find.runId, payload: { step: "kick", fallbackCreated: r && r.created || 0, firedAt: h.find.firedAt } });
  }
  // stuck jobs: re-queue once, then fail
  for (const c of running()) {
    if (now - Date.parse(c.hunt.firedAt || 0) < WORKER_TIMEOUT) continue;
    const back = c.hunt.status === "grading" ? "candidate" : "graded";
    const agent = c.hunt.status === "grading" ? "grader" : "preparer";
    if ((c.hunt.attempts || 0) < WORKER_ATTEMPTS) { c.hunt.status = back; events.push(`re-queued ${c.name}`); obsError("agent-did-not-return", `${agent} did not return within 30 min (attempt ${c.hunt.attempts || 0})`, { handling: "retried", severity: "warn", entity_type: "company", entity_id: c.id, payload: { step: "kick", company: c.name, agent, attempts: c.hunt.attempts || 0, firedAt: c.hunt.firedAt, to: back } }); }
    else { failCandidate(st, c, `${agent} did not return`); events.push(`failed ${c.name}`); }
  }
  const run = h.lastRun;
  while (running().length < h.concurrency && waiting().length) {
    // preps first (they finish cards), then grades, oldest first
    const c = waiting().sort((a, b) => (a.hunt.status === "graded" ? 0 : 1) - (b.hunt.status === "graded" ? 0 : 1) || String(a.hunt.foundAt).localeCompare(String(b.hunt.foundAt)))[0];
    const r = st.roles.find(x => x.companyId === c.id && x.apply && x.apply.status === "candidate");
    if (!r) { c.hunt.status = "dropped"; fireEv("skipped", { company: c.name, reason: "no candidate role on the company card" }, { entity_type: "company", entity_id: c.id }); continue; }
    const job = WAITING[c.hunt.status];   // grading | preparing
    // prepared cap reached: nothing more is graded or prepared tonight; leftovers are removed so the finder may offer them again
    if (run && (run.prepared || []).length >= h.caps.prepared) { dropCandidate(st, c, "capPrepared"); events.push(`cap reached - ${c.name} dropped`); continue; }
    const payload = { kind: job === "grading" ? "hunt-grade" : "hunt-prep", roleId: r.id, companyId: c.id, name: c.name, site: c.links, domain: c.hunt.domain, title: r.title, url: r.apply.url, ats: r.apply.ats, location: r.apply.location, source: c.hunt.source,
      grade: gradeOf(c), summary: c.what || "", callback: `${site}/.netlify/functions/hunt`, board: `${site}/.netlify/functions/hunt`, brief: `${site}/${job === "grading" ? "hunt-grade-brief.md" : "hunt-prep-brief.md"}`, researchBrief: `${site}/research-brief.md` };
    const prev = c.hunt.status;
    c.hunt.status = job; c.hunt.firedAt = new Date(now).toISOString(); c.hunt.attempts = (c.hunt.attempts || 0) + 1;
    const f = await fireRoutine(payload);
    if (f.ok) { fired.push(`${job} ${c.name}`); fireEv("ok", { company: c.name, job, attempt: c.hunt.attempts, roleId: r.id }, { trace_id: r.id, entity_type: "company", entity_id: c.id }); }
    else if (f.error === "routine not configured") { c.hunt.status = prev; c.hunt.attempts--; events.push("routine not configured (ROUTINE_FIRE_URL/ROUTINE_TOKEN) - jobs stay queued"); break; }
    else if (f.status === 429) { c.hunt.status = prev; c.hunt.attempts--; h.fireBackoffUntil = new Date(now + retryAfterMs(f.body)).toISOString(); events.push(`routine rate limit - firing paused until ${h.fireBackoffUntil}`); fireEv("skipped", { company: c.name, job, reason: "routine rate limit (429)", until: h.fireBackoffUntil }, { trace_id: r.id, entity_type: "company", entity_id: c.id, severity: "warn" }); break; }
    else { if (c.hunt.attempts >= WORKER_ATTEMPTS) failCandidate(st, c, f.error || `fire failed (${f.status})`); else c.hunt.status = prev; events.push(`fire failed for ${c.name}: ${f.error || f.status}`); fireEv("fail", { company: c.name, job, attempt: c.hunt.attempts, reason: f.error || `fire failed (${f.status})`, failed: c.hunt.attempts >= WORKER_ATTEMPTS }, { trace_id: r.id, entity_type: "company", entity_id: c.id, severity: "warn" }); }
  }
  if (run) run.pending = pendingCount(st);
  return { fired, events };
}
// "Try again in 11m23s." -> ms (+30 s slack); 15 min when the body names no time
export function retryAfterMs(body) {
  const m = /try again in\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i.exec(String(body || ""));
  const ms = m ? ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000 : 0;
  return (ms || 15 * MIN) + 30 * 1000;
}
const rateLimited = why => String(why || "").startsWith("fire failed (429)");
// cards the old kick() failed on a 429 (both attempts burned in the same second, nothing was ever sent): back to the waiting line
export function reviveRateLimited(st) {
  let n = 0;
  for (const c of st.companies) {
    if (!c.hunt || c.hunt.status !== "failed" || !rateLimited(c.hunt.error)) continue;
    const roles = st.roles.filter(r => r.companyId === c.id && r.apply && r.apply.status === "failed" && rateLimited(r.apply.reason));
    c.hunt.status = gradeOf(c) !== null ? "graded" : "candidate"; c.hunt.attempts = 0; delete c.hunt.error;
    for (const r of roles) { r.apply.status = "candidate"; delete r.apply.failedAt; delete r.apply.reason; r.nextAction = "Hunt: waiting for the grader / preparer"; }
    emit({ type: "transition", entity_type: "company", entity_id: c.id, trace_id: roles[0] ? roles[0].id : null, payload: { company: c.name, field: "hunt.status", from: "failed", to: c.hunt.status, reason: "revived after routine rate limit", by: "board" } });
    n++;
  }
  return n;
}
const pendingCount = st => st.companies.filter(c => c.hunt && ["candidate", "grading", "graded", "preparing"].includes(c.hunt.status)).length;
function failCandidate(st, c, why) {
  const prevStatus = c.hunt.status;
  c.hunt.status = "failed"; c.hunt.error = why;
  const rid = (st.roles.find(r => r.companyId === c.id && r.apply && r.apply.status === "candidate") || {}).id || null;
  obsError("agent-did-not-return", why, { handling: "forfeited", trace_id: rid, entity_type: "company", entity_id: c.id, payload: { company: c.name, attempts: c.hunt.attempts, from: prevStatus, to: "failed", reason: why } });
  for (const r of st.roles) if (r.companyId === c.id && r.apply && r.apply.status === "candidate") { r.apply.status = "failed"; r.apply.failedAt = new Date().toISOString(); r.apply.reason = why; r.nextAction = `Hunt failed (${why}) - re-queue from the brief or skip`; }
}
function dropCandidate(st, c, why) {   // never processed: remove the cards so the finder may offer the company again another night
  const h = hunt(st);
  const roles = st.roles.filter(r => r.companyId === c.id);
  emit({ type: "transition", trace_id: roles[0] ? roles[0].id : null, entity_type: "company", entity_id: c.id, outcome: "skipped", payload: { company: c.name, field: "company", from: c.hunt && c.hunt.status || null, to: "removed", reason: why, by: "board", snapshot: { company: c, roles } } });
  if (h.lastRun) { h.lastRun.funnel = h.lastRun.funnel || {}; h.lastRun.funnel.dropped = h.lastRun.funnel.dropped || {}; h.lastRun.funnel.dropped[why] = (h.lastRun.funnel.dropped[why] || 0) + 1; h.lastRun.refused = h.lastRun.refused || {}; h.lastRun.refused[why] = (h.lastRun.refused[why] || 0) + 1; }
  // role rule (23 Oct 2026): a company that carries other roles (an earlier application, a real lead) keeps its card and those roles;
  // only tonight's unprocessed candidate role goes, and the company returns to its earlier hunt state
  const keep = roles.filter(r => !(r.apply && r.apply.status === "candidate"));
  if (keep.length) {
    st.roles = st.roles.filter(r => !(r.companyId === c.id && r.apply && r.apply.status === "candidate"));
    const prev = c.hunt && Array.isArray(c.hunt.history) && c.hunt.history.length ? c.hunt.history[c.hunt.history.length - 1] : null;
    c.hunt = { ...c.hunt, status: prev && prev.status && !BUSY.has(prev.status) ? prev.status : "done", runId: prev ? prev.runId : c.hunt.runId, foundAt: prev ? prev.foundAt : c.hunt.foundAt, addedRole: false };
    return;
  }
  st.roles = st.roles.filter(r => r.companyId !== c.id);
  st.tasks = (st.tasks || []).filter(t => !(t.owner && ((t.owner.type === "company" && t.owner.id === c.id))));
  st.companies = st.companies.filter(x => x.id !== c.id);
}

// ---------- finder: candidate list ----------
export function ingestCandidates(st, body) {
  const h = hunt(st), now = new Date().toISOString();
  const runId = clean(body.runId, 40) || `hunt-${now.slice(0, 10)}`;
  const funnel = { found: 0, ...(body.funnel || {}) };
  funnel.dropped = { ...((body.funnel && body.funnel.dropped) || {}) };
  const refused = {};
  const drop = (why, inC, detail) => { refused[why] = (refused[why] || 0) + 1; funnel.dropped[why] = (funnel.dropped[why] || 0) + 1; if (inC) emit({ type: "decision", run_id: runId, entity_type: "run", entity_id: runId, outcome: "skipped", payload: { step: "ingestCandidates", item: clean(inC.name, 80), company: clean(inC.name, 80), title: clean(inC.title, 100), url: clean(inC.url, 400), ats: inC.ats, source: clean(inC.source, 60), location: clean(inC.location, 80), decision: "refused", reason: why, detail: detail || "" } }); };
  setRun(runId);
  const endIngest = step("ingestCandidates", { entity_type: "run", entity_id: runId, payload: { offered: Array.isArray(body.candidates) ? body.candidates.length : 0, sorter: !!body.sorter } });
  const errors = Array.isArray(body.errors) ? body.errors.map(e => clean(e, 200)).slice(0, 20) : [];
  const brief = clean(body.brief, 2000);
  if (h.killSwitch) {
    const run = { at: now, ok: true, runId, noop: "killSwitch", funnel, errors: ["kill switch is on - nothing written"], brief, candidates: 0, pending: 0, prepared: [], realLeads: [], manualOnly: [], dropped: [], refused };
    h.lastRun = run; h.runs.unshift(run); h.runs = h.runs.slice(0, RUNS_KEPT); delete st.huntRun;
    endIngest("skipped", { reason: "kill switch on" });
    return { ok: true, noop: "killSwitch", created: 0, refused };
  }
  // leftovers from an earlier night that never got a worker: clear them so tonight starts clean
  for (const c of st.companies.filter(c => c.hunt && c.hunt.status === "candidate")) dropCandidate(st, c, "leftover");
  const seenDomain = new Set(), seenName = new Set();
  let created = 0; const accepted = [];
  for (const inC of (Array.isArray(body.candidates) ? body.candidates : [])) {
    const name = clean(inC.name, 80), title = clean(inC.title, 100), url = clean(inC.url, 400), location = clean(inC.location, 80);
    if (!name || !title || !url) { drop("invalid", inC, "name, title or url missing"); continue; }
    const domain = host(inC.domain || inC.site || ""), k = nameKey(name);
    if ((domain && seenDomain.has(domain)) || (k && seenName.has(k))) { drop("duplicate", inC, "same domain or name earlier in this list"); continue; }
    if (TITLE_EXCLUDE.test(title)) { drop("seniority", inC, (title.match(TITLE_EXCLUDE) || [])[0]); continue; }
    if (!TITLE_INCLUDE.test(title)) { drop("title", inC, "no target keyword in the title"); continue; }
    if (!ISRAEL.test(location) && !ISRAEL.test(title)) { drop("location", inC, location); continue; }
    const ob = onBoard(st, { name, domain, title }); if (ob) { const OB = { role: ["sameRole", "this role at this company is already on the board or in the ledger"], companyCap: ["companyCap", `${COMPANY_MAX_OPEN} open applications at this company already`], family: ["roleFamily", `a ${roleFamily(title)} role next to an open application in another family`] }[ob] || ["onBoard", `matched by ${ob}`]; drop(OB[0], inC, OB[1]); continue; }
    if (created >= h.caps.found) { drop("capFound", inC, `cap ${h.caps.found}`); continue; }
    if (domain) seenDomain.add(domain);
    if (k) seenName.add(k);   // one new role per company per night: kick() handles one candidate role per company at a time
    const ats = ATS_ALL.has(inC.ats) ? inC.ats : "other";
    // role rule: a new role at an open practice company joins that company; a company graded 1-6 skips the grader (its grade stands)
    const existing = practiceCompany(st, { name, domain });
    const c = existing || { id: uid(), name, what: "", stage: "", ceo: "", fit: "", links: clean(inC.site || (domain ? "https://" + domain : ""), 200), notes: "", peopleIds: [], tier: "practice", autoAdded: true };
    c.hunt = { ...(existing && existing.hunt ? { history: [...((existing.hunt.history) || []), { runId: existing.hunt.runId, status: existing.hunt.status, foundAt: existing.hunt.foundAt }].slice(-10) } : {}),
      status: existing && gradeOf(existing) !== null ? "graded" : "candidate", source: clean(inC.source, 60), domain: domain || (existing && existing.hunt && existing.hunt.domain) || "", foundAt: now, runId, attempts: 0, ...(existing ? { addedRole: true } : {}) };
    const r = { id: uid(), companyId: c.id, title, viaId: null, stage: "lead", stageAt: fmt(now), odds: "unknown", nextAction: c.hunt.status === "graded" ? `Another role at ${c.name} (graded ${gradeOf(c)}) - waiting for the preparer` : "Candidate - waiting for the grader", notes: `Found by the hunt ${fmt(now)} · ${ats} · ${url}${clean(inC.why, 200) ? `\nSorter: ${clean(inC.why, 200)}` : ""}`, tier: "practice", autoAdded: true,
      apply: { status: "candidate", url, ats, title, location, foundAt: now, runId, attempts: 0 } };
    if (!existing) st.companies.push(c);
    st.roles.push(r); created++; accepted.push({ roleId: r.id, companyId: c.id, company: name, title, ats, ...(existing ? { addedRole: true } : {}) });
    emit({ type: "decision", trace_id: r.id, entity_type: "role", entity_id: r.id, outcome: "ok", payload: { step: "ingestCandidates", item: r.id, company: name, title, url, ats, source: c.hunt.source, location, decision: "candidate", reason: clean(inC.why, 200), rank: created } });
    emit({ type: "transition", trace_id: r.id, entity_type: "role", entity_id: r.id, payload: { company: name, title, field: "apply.status", from: null, to: "candidate", ats, source: c.hunt.source, by: "board", companyId: c.id } });
  }
  funnel.candidates = created;
  const run = { at: now, ok: true, runId, funnel, errors, brief, candidates: created, pending: created, prepared: [], realLeads: [], manualOnly: [], dropped: [], refused };
  h.lastRun = run; h.runs.unshift(run); h.runs = h.runs.slice(0, RUNS_KEPT); delete st.huntRun;
  endIngest("ok", { created, refused, errors, funnel });
  return { ok: true, created, refused, accepted };
}

// ---------- sorter: the agent's pick from the finder's offered list ----------
function ingestSort(st, body) {
  const h = hunt(st), f = h.find, now = new Date().toISOString();
  const runId = clean(body.runId, 40);
  setRun(runId || (f && f.runId) || null);
  const picks0 = Array.isArray(body.candidates) ? body.candidates.length : 0;
  if (!f || f.status !== "sorting") { refused("sorter-not-expected", `no run is waiting for a sorter (${f ? f.status : "none"})`, { actor: "agent:sorter", entity_type: "run", entity_id: runId || null, payload: { picks: picks0, findStatus: f ? f.status : "none" } }); return { error: `no run is waiting for a sorter (${f ? f.status : "none"})`, status: 409 }; }
  if (runId && f.runId && runId !== f.runId) { refused("sorter-run-mismatch", `runId mismatch - the board is waiting on ${f.runId}`, { actor: "agent:sorter", entity_type: "run", entity_id: runId, payload: { picks: picks0, expected: f.runId } }); return { error: `runId mismatch - the board is waiting on ${f.runId}`, status: 409 }; }
  emit({ type: "step.end", actor: "agent:sorter", entity_type: "run", entity_id: f.runId, outcome: "ok", duration_ms: f.firedAt ? Date.now() - Date.parse(f.firedAt) : null, payload: { step: "sort", offered: (f.offered || []).length, picks: picks0, dropped: body.dropped || {}, errors: body.errors || [], brief: clean(body.brief, 400), trace: body.trace || null, promptVersion: body.promptVersion || null, payloadBytes: JSON.stringify(body).length } });
  for (const [why, n] of Object.entries(body.dropped && typeof body.dropped === "object" ? body.dropped : {})) if (Number.isInteger(n) && n > 0) emit({ type: "decision", actor: "agent:sorter", entity_type: "run", entity_id: f.runId, outcome: "skipped", payload: { step: "sort", item: `sorter:${clean(why, 20)}`, decision: "dropped", reason: clean(why, 20), count: n } });
  for (const d of (Array.isArray(body.droppedList) ? body.droppedList : []).slice(0, 60)) emit({ type: "decision", actor: "agent:sorter", entity_type: "run", entity_id: f.runId, outcome: "skipped", payload: { step: "sort", item: clean(d.name, 80), company: clean(d.name, 80), title: clean(d.title, 100), decision: "dropped", reason: clean(d.reason || d.why, 40), detail: clean(d.detail || d.note, 200) } });
  const funnel = { ...(f.funnel || { found: 0 }), dropped: { ...((f.funnel && f.funnel.dropped) || {}) } };
  if (body.dropped && typeof body.dropped === "object") for (const [k, v] of Object.entries(body.dropped)) if (Number.isInteger(v) && v > 0) funnel.dropped[`sorter:${clean(k, 20)}`] = v;
  const errors = [...(f.errors || []), ...(Array.isArray(body.errors) ? body.errors.map(e => clean(e, 200)) : [])].slice(0, 20);
  const picks = Array.isArray(body.candidates) ? body.candidates : [];
  const brief = `${f.brief0 || ""} Sorter: ${clean(body.brief, 400) || `${picks.length} picks`}`;
  const res = ingestCandidates(st, { runId: f.runId, funnel, errors, brief, candidates: picks, sorter: true });
  f.status = "done"; f.finishedAt = now; f.offered = []; f.log = [...(f.log || []), `sorter returned ${picks.length} picks, board created ${res.created || 0}`];
  delete st.huntRun;
  return { ...res, sorter: true };
}

// ---------- grader: one company's research + grade -> lane ----------
function jobCard(st, body, expect) {
  const agent = expect.includes("grading") ? "agent:grader" : "agent:preparer";
  const r = st.roles.find(x => x.id === body.roleId); if (!r) { refused("role-not-found", `${agent} posted for unknown role ${clean(body.roleId, 40)}`, { actor: agent, payload: { roleId: clean(body.roleId, 40), company: clean(body.name, 80) } }); return { error: "role not found", status: 404 }; }
  const c = roleCompany(st, r); if (!c) { refused("company-not-found", `${agent} posted for a role with no company`, { actor: agent, trace_id: r.id, payload: { roleId: r.id } }); return { error: "company not found", status: 404 }; }
  setRun(c.hunt && c.hunt.runId || null);
  if (!c.hunt || !expect.includes(c.hunt.status) || !r.apply || r.apply.status !== "candidate") { refused("card-not-waiting", `card is not waiting for this job (${c.hunt && c.hunt.status} / ${r.apply && r.apply.status})`, { actor: agent, trace_id: r.id, entity_type: "role", entity_id: r.id, payload: { company: c.name, huntStatus: c.hunt && c.hunt.status, applyStatus: r.apply && r.apply.status, expected: expect } }); return { error: `card is not waiting for this job (${c.hunt && c.hunt.status} / ${r.apply && r.apply.status})`, status: 409 }; }
  const h = hunt(st);
  emit({ type: "step.end", actor: agent, trace_id: r.id, entity_type: "role", entity_id: r.id, outcome: "ok", duration_ms: c.hunt.firedAt ? Date.now() - Date.parse(c.hunt.firedAt) : null, payload: { step: agent === "agent:grader" ? "grade" : "prep", company: c.name, title: r.title, attempt: c.hunt.attempts, errors: Array.isArray(body.errors) ? body.errors.map(e => clean(e, 200)).slice(0, 10) : [], trace: body.trace || null, promptVersion: body.promptVersion || null, payloadBytes: JSON.stringify(body).length } });
  const run = h.lastRun && h.lastRun.runId === c.hunt.runId ? h.lastRun : (h.runs.find(x => x.runId === c.hunt.runId) || h.lastRun);
  const tally = (list, line) => { if (run) { run[list] = run[list] || []; run[list].push(line); } };
  const count = why => { if (run) { run.refused = run.refused || {}; run.refused[why] = (run.refused[why] || 0) + 1; run.funnel = run.funnel || {}; run.funnel.dropped = run.funnel.dropped || {}; run.funnel.dropped[why] = (run.funnel.dropped[why] || 0) + 1; } };
  const errors = Array.isArray(body.errors) ? body.errors.map(e => clean(e, 200)).slice(0, 10) : [];
  if (errors.length) c.hunt.error = errors.join("; ");
  return { r, c, run, tally, count, line: { roleId: r.id, companyId: c.id, company: c.name, title: r.title, ats: r.apply.ats } };
}
function ingestGrade(st, body) {
  const j = jobCard(st, body, ["grading", "candidate"]); if (j.error) return j;
  const { r, c, run, tally, count, line } = j; const now = new Date().toISOString();
  const decide = (decision, extra) => emit({ type: "decision", actor: "agent:grader", trace_id: r.id, entity_type: "role", entity_id: r.id, outcome: decision === "dropped" ? "skipped" : "ok", payload: { step: "grade", item: r.id, company: c.name, title: r.title, ats: r.apply.ats, decision, ...extra } });
  if (body.stale || body.dropped) { const why = clean(body.dropped || "stale", 40); decide("dropped", { reason: why, detail: clean(body.sentence, 300) }); tally("dropped", { ...line, why }); count(why); dropCandidate(st, c, why); if (run) run.pending = pendingCount(st); return { ok: true, placed: "dropped", why }; }
  const research = body.research && typeof body.research === "object" ? body.research : null;
  const g = research && Number.isInteger(research.fit && research.fit.grade) ? research.fit.grade : null;
  const gradeable = body.gradeable !== false && g !== null && g >= 1 && g <= 10;
  const lane = !gradeable ? "real" : g > 6 ? "real" : "practice";
  if (research) {
    c.research = { ...research, status: "done", depth: "hunt", updatedAt: now };
    const hc = typeof research.headcount === "number" ? `~${research.headcount} people` : (research.headcount || "");
    if (!c.what && research.summary) c.what = clean(research.summary, 300);
    if (!c.stage) c.stage = [research.stage, hc, research.location].filter(Boolean).join(" · ");
    if (!c.ceo && Array.isArray(research.founders) && research.founders.length) { const ceo = research.founders.find(f => /ceo/i.test(f.role || "")) || research.founders[0]; c.ceo = [ceo.name, ceo.role, ceo.background].filter(Boolean).join(" - "); }
    if (research.logo) c.logo = research.logo;
  }
  c.tier = lane; r.tier = lane; r.apply.grade = g; c.hunt.gradedAt = now; line.grade = g;
  decide(lane === "real" ? (gradeable ? "real lead" : "could not grade") : "practice", { grade: g, lane, gradeable, reason: (research && research.fit && (research.fit.reasons || []).join("; ")) || clean(body.fitNotes, 300), sentence: clean(body.sentence, 300), evidence: (research && research.sources) || [], confidence: research && research.fit && research.fit.confidence || null });
  if (lane === "real") {
    c.hunt.status = "done"; r.apply.status = "real"; r.apply.reason = gradeable ? "gradeAbove6" : "cannotGrade"; count(r.apply.reason);
    r.apply.sentence = clean(body.sentence, 300); r.apply.fitNotes = clean(body.fitNotes, 300);
    r.nextAction = `Real lead - ${gradeable ? `grade ${g}` : "could not grade"}, you decide`;
    tally("realLeads", { ...line, status: "real", sentence: r.apply.sentence });
    return { ok: true, placed: "real", grade: g };
  }
  r.apply.sentence = clean(body.sentence, 300); r.apply.fitNotes = clean(body.fitNotes, 300);
  c.hunt.status = "graded";   // the chain fires the preparer next
  r.nextAction = `Graded ${g} - waiting for the preparer`;
  return { ok: true, placed: "graded", grade: g };
}

// ---------- preparer: one role's form + package -> prepared | manual ----------
function ingestPrep(st, body) {
  const j = jobCard(st, body, ["preparing", "graded"]); if (j.error) return j;
  const { r, c, run, tally, count, line } = j; const now = new Date().toISOString();
  c.hunt.status = "done"; c.hunt.doneAt = now;
  const decide = (decision, extra) => emit({ type: "decision", actor: "agent:preparer", trace_id: r.id, entity_type: "role", entity_id: r.id, outcome: /dropped|forfeited/.test(decision) ? "skipped" : "ok", payload: { step: "prep", item: r.id, company: c.name, title: r.title, ats: r.apply.ats, grade: r.apply.grade ?? null, decision, ...extra } });
  if (body.stale || body.dropped) { const why = clean(body.dropped || "stale", 40); decide("dropped", { reason: why }); tally("dropped", { ...line, why }); count(why); dropCandidate(st, c, why); if (run) run.pending = pendingCount(st); return { ok: true, placed: "dropped", why }; }
  const ap = body.apply && typeof body.apply === "object" ? body.apply : {};
  const a = r.apply;
  a.title = clean(ap.title, 100) || r.title;
  a.cv = CVS.has(ap.cv) ? ap.cv : (/product/i.test(r.title) ? "tpm" : "engineer-big");
  a.sentence = clean(ap.sentence, 300) || a.sentence || "";
  a.location = clean(ap.location, 80) || a.location;
  if (ATS_ALL.has(ap.ats)) a.ats = ap.ats;
  if (clean(ap.url, 400)) a.url = clean(ap.url, 400);
  a.fields = Array.isArray(ap.fields) ? ap.fields.slice(0, 40).map(f => ({ name: clean(f.name, 60), label: clean(f.label, 80), type: clean(f.type, 20), required: !!f.required })) : [];
  a.screeners = Array.isArray(ap.screeners) ? ap.screeners.slice(0, 30).map(s => ({ q: clean(s.q, 300), type: clean(s.type, 20) || "text", options: Array.isArray(s.options) ? s.options.map(o => clean(o, 80)).slice(0, 12) : [] })).filter(s => s.q) : [];
  a.answers = {}; if (ap.answers && typeof ap.answers === "object") for (const [q, v] of Object.entries(ap.answers)) if (clean(v)) a.answers[clean(q, 300)] = clean(v, 500);
  // every required field beyond the identity set needs an answer too (LinkedIn profile is the common one)
  const STANDARD = /first.?name|last.?name|^(full )?name$|preferred|e-?mail|phone|tel|resume|\bcv\b|curriculum|^country|^location|^city|linkedin/i;   // identity fields the worker fills from its profile (country / city / LinkedIn included)
  // a field label is clipped at 80 chars, so a long required question must match its screener by prefix too (24 Oct: Piedpiper, Woodgrove forfeited on their own clipped twin)
  const norm = (x) => String(x || "").toLowerCase().replace(/\s+/g, " ").replace(/[\s.:?*…]+$/, "").trim();
  // a short field label that summarises a listed question ("Previously employed/applied" for "Have you ever been employed by, applied to ...",
  // Proseware, 27 Oct: four such twins forfeited the card): most of its content words (5-letter stems) are in that screener
  const stems = (x) => (norm(x).match(/[a-z]{4,}/g) || []).map(w => w.slice(0, 5));
  const summarises = (l, q) => { const sw = stems(l); if (!sw.length || sw.length > 4) return false; const qs = new Set(stems(q)); const hit = sw.filter(w => qs.has(w)).length; return hit >= 2 && hit / sw.length >= 0.6 || (sw.length === 1 && hit === 1 && q.length > l.length + 20); };
  const isScreener = (label) => { const l = norm(label); return a.screeners.some(s => { const q = norm(s.q); return q === l || (l.length >= 30 && (q.startsWith(l) || l.startsWith(q))) || summarises(l, q); }); };
  for (const f of a.fields) { const label = f.label || f.name; if (f.required && f.type !== "file" && !STANDARD.test(label) && !STANDARD.test(f.name) && !isScreener(label)) a.screeners.push({ q: label, type: "text", options: [] }); }
  a.needsHuman = a.screeners.map(s => s.q).filter(q => !a.answers[q]);
  a.flags = { login: !!(ap.flags && ap.flags.login), captcha: !!(ap.flags && ap.flags.captcha), coverLetterRequired: !!(ap.flags && ap.flags.coverLetterRequired), formUnread: !!(ap.flags && ap.flags.formUnread) };
  a.errors = Array.isArray(body.errors) ? body.errors.map(e => clean(e, 200)).slice(0, 10) : [];
  a.preparedAt = now;
  Object.assign(line, { grade: a.grade ?? null, cv: a.cv, sentence: a.sentence, needsHuman: a.needsHuman.length, ats: a.ats });
  const pkg = { ats: a.ats, url: a.url, cv: a.cv, fields: a.fields.length, screeners: a.screeners.map(s => s.q), answered: Object.keys(a.answers), needsHuman: a.needsHuman, flags: a.flags, errors: a.errors };
  const place = (decision, status, extra = {}) => { decide(decision, { ...pkg, status, ...extra }); emit({ type: "transition", trace_id: r.id, entity_type: "role", entity_id: r.id, payload: { company: c.name, title: r.title, field: "apply.status", from: "candidate", to: status, reason: extra.reason || null, detail: extra.detail || null, by: "board", ats: a.ats, autoQueue: hunt(st).autoQueue } }); };
  let manualWhy = "";
  if (!ATS_AUTO.has(a.ats)) manualWhy = "manualOnly";
  else if (a.flags.login) manualWhy = "loginWall";
  else if (a.flags.captcha) manualWhy = "captcha";
  else if (a.flags.coverLetterRequired) manualWhy = "coverLetter";
  const h = hunt(st);
  if (!h.autoQueue) {   // manual mode: the old morning-brief flow
    if (manualWhy) {
      a.status = "manual"; a.reason = manualWhy; count(manualWhy);
      r.nextAction = `Apply by hand (${manualWhy === "manualOnly" ? a.ats : manualWhy})`;
      tally("manualOnly", { ...line, status: "manual" }); place("manual", "manual", { reason: manualWhy });
      return { ok: true, placed: "manual", why: manualWhy };
    }
    a.status = "prepared";
    r.nextAction = a.needsHuman.length ? `Prepared - ${a.needsHuman.length} screener${a.needsHuman.length === 1 ? "" : "s"} need you` : "Prepared - approve in the morning brief";
    tally("prepared", { ...line, status: "prepared" }); place("prepared", "prepared");
    return { ok: true, placed: "prepared" };
  }
  // hands-off mode: queue it for the PC worker, or forfeit it with the reason (Eyal can revive a forfeited card by hand)
  const forfeit = (why, detail) => {
    a.status = "skipped"; a.reason = `forfeited: ${why}${detail ? ` - ${clean(detail, 120)}` : ""}`; count(`forfeited:${why}`);
    r.nextAction = `Forfeited (${why}${detail ? `: ${clean(detail, 60)}` : ""}) - revive by hand if you want it`;
    tally("forfeited", { ...line, status: "skipped", why, detail: clean(detail, 120) });
    place("forfeited", "skipped", { reason: `forfeited: ${why}`, why, detail: clean(detail, 300) });
    return { ok: true, placed: "forfeited", why };
  };
  if (manualWhy) return forfeit(manualWhy, manualWhy === "manualOnly" ? a.ats : "");
  if (a.needsHuman.length) return forfeit("needsAnswer", a.needsHuman.join(" | "));
  const bad = approveGuard(st, c, r);
  if (bad && bad.error === "kill switch is on") { a.status = "prepared"; r.nextAction = "Prepared - kill switch was on, approve on the board to queue it"; tally("prepared", { ...line, status: "prepared" }); place("prepared", "prepared", { reason: "killSwitch" }); return { ok: true, placed: "prepared", why: "killSwitch" }; }
  if (bad) return forfeit(bad.error === "never-twice" ? "neverTwice" : bad.error, bad.detail || "");
  a.status = "approved"; a.approvedAt = now;
  r.nextAction = "Queued for the PC worker";
  tally("prepared", { ...line, status: "approved" }); tally("queued", { ...line, status: "approved" }); place("queued", "approved");
  return { ok: true, placed: "queued" };
}

// ---------- the one guard before anything is ever submitted: tier, grade, package, kill switch, never-twice, dreamlist, open screeners ----------
export function approveGuard(st, c, r, { needAnswers = true } = {}) {
  const h = hunt(st), a = r.apply || {};
  if (c.tier !== "practice" || r.tier !== "practice") return { error: "not practice tier", status: 409 };
  const g = gradeOf(c); if (g !== null && g > 6) return { error: "grade above 6", status: 409 };
  if (!a.url || !a.cv) return { error: "no package on this card - re-queue it for a worker instead", status: 409 };
  if (h.killSwitch) return { error: "kill switch is on", status: 409 };
  if (needAnswers && Array.isArray(a.needsHuman) && a.needsHuman.length) return { error: "open screeners", status: 409, detail: a.needsHuman.join(" | ").slice(0, 200) };
  // never twice, per ROLE since 23 Oct 2026: the same role at this company (same titleKey) already sent, or a ledger entry for it;
  // a ledger entry with no known role (hand-sent) still blocks the whole company, and so does the dreamlist
  const mine = titleKey(r.title);
  const other = st.roles.find(x => x.companyId === c.id && x.id !== r.id && x.apply && ["submitting", "submitted", "confirmed", "unverified"].includes(x.apply.status) && titleKey(x.title) === mine);
  const sameCo = x => (x.name && nameKey(x.name) === nameKey(c.name)) || (x.domain && domainsOf(c).includes(host(x.domain)));
  const ledger = h.applied.find(x => x.roleId !== r.id && sameCo(x) && (() => { const t = ledgerTitle(st, x); return !t || titleKey(t) === mine; })());
  const dream = h.denyExtra.split(/\r?\n/).map(l => clean(l, 120)).filter(Boolean).some(l => (nameKey(l) && nameKey(l) === nameKey(c.name)) || (host(l) && domainsOf(c).includes(host(l))));
  if (other || ledger || dream) return { error: "never-twice", status: 409, detail: other ? "this role at this company was already submitted" : ledger ? (ledgerTitle(st, ledger) ? "this role is in the applied ledger" : "company is in the applied ledger (hand-sent, role unknown)") : "company is on the dreamlist" };
  return null;
}
const todayKey = (d = new Date()) => d.toISOString().slice(0, 10);
// submissions that count against caps.perDay: sent today, or claimed right now
const sentToday = st => st.roles.filter(r => r.apply && (r.apply.status === "submitting" || (r.apply.submittedAt || "").slice(0, 10) === todayKey())).length;
// hourly pacing (Eyal, 23 Oct 2026): sends spread over the day, caps.perHour (default 5) in any rolling 60 minutes
const sentLastHour = st => { const t0 = Date.now() - 60 * MIN; return st.roles.filter(r => r.apply && (r.apply.status === "submitting" || (r.apply.submittedAt && Date.parse(r.apply.submittedAt) >= t0))).length; };
const perHourOf = h => Number.isInteger(h.caps.perHour) ? h.caps.perHour : 5;

// ---------- apply transitions (page, Claude Code, runner) ----------
const TRANSITIONS = {
  prepared: ["approved", "skipped"],
  approved: ["prepared", "submitting", "skipped"],
  submitting: ["submitted", "blocked", "failed", "unverified"],   // unverified = the worker cannot tell whether the click went through (never retried)
  submitted: ["confirmed", "unverified"],
};
const BY_HUMAN_ONLY = new Set(["blocked", "failed", "unverified", "manual", "real", "skipped"]);
const PATCH_EXTRA = ["pdf", "screenshot", "log", "reason", "answers", "needsHuman", "runId", "workerId", "machine", "formFinder"];
// PC form finder (worker/find-form.mjs, 21 Oct 2026): a card forfeited as LinkedIn-only comes back as a candidate with the company's
// own form when the finder located it on a recipe ATS. The object is stored as the attempt note (one attempt per card, ever).
const finderNote = f => f && typeof f === "object" ? { at: clean(f.at, 40) || new Date().toISOString(), by: clean(f.by, 60), found: f.found === true, ats: clean(f.ats, 20), url: clean(f.url, 400), portal: clean(f.portal, 60), via: clean(f.via, 40), score: typeof f.score === "number" ? f.score : null, matchedTitle: clean(f.matchedTitle, 120), checked: Array.isArray(f.checked) ? f.checked.slice(0, 20).map(x => clean(x, 160)) : [], error: clean(f.error, 200) } : null;
function applyPatch(st, body) {
  const by = body.byHuman === true ? "human" : clean(body.workerId, 60) ? "worker" : "claude-code";
  const r = st.roles.find(x => x.id === body.roleId); if (!r) { refused("role-not-found", `apply patch for unknown role ${clean(body.roleId, 40)}`, { payload: { roleId: clean(body.roleId, 40), by, patch: body.patch } }); return { error: "role not found", status: 404 }; }
  const c = roleCompany(st, r); if (!c) { refused("company-not-found", "apply patch for a role with no company", { trace_id: r.id, payload: { roleId: r.id, by } }); return { error: "company not found", status: 404 }; }
  const a = r.apply = r.apply || { status: "manual", attempts: 0 };
  const p = body.patch && typeof body.patch === "object" ? body.patch : {};
  const now = new Date().toISOString();
  const to = p.status;
  setRun(clean(body.runId || p.runId || a.runId, 60) || null);
  const base = { trace_id: r.id, entity_type: "role", entity_id: r.id };
  const info = { company: c.name, title: r.title, ats: a.ats, from: a.status, to, by, byHuman: body.byHuman === true, workerId: clean(body.workerId, 60) || null, release: body.release === true, patch: Object.keys(p), reason: clean(p.reason, 400) || null };
  const deny = (cls, msg, detail) => { refused(cls, msg, { ...base, payload: { ...info, detail: detail || "" } }); };
  if (to !== undefined) {
    if (!APPLY_STATUSES.has(to)) { deny("bad-status", `unknown status ${clean(to, 40)}`); return { error: "bad status", status: 422 }; }
    const from = a.status;
    let ok = (TRANSITIONS[from] || []).includes(to);
    if (!ok && BY_HUMAN_ONLY.has(from) && to === "prepared" && body.byHuman === true) ok = true;
    if (!ok && from === "manual" && to === "submitted" && body.byHuman === true) ok = true;   // "Mark applied by hand"
    if (!ok && ["failed", "skipped"].includes(from) && to === "candidate" && body.byHuman === true && c.hunt) ok = true;   // re-queue for a worker
    // the PC form finder found the company's own form for a LinkedIn-only card: back to candidate so the preparer reads the real form
    const fin = finderNote(p.formFinder);
    if (!ok && from === "skipped" && to === "candidate" && clean(body.workerId, 60) && fin && fin.found && ATS_AUTO.has(fin.ats) && fin.url && /manualOnly/i.test(a.reason || "") && c.hunt && !a.formFinder) ok = true;
    // release: the worker claimed the card but could not start (Chrome busy, logged out) - back to the queue, only by the same worker, only if nothing was filled
    if (!ok && from === "submitting" && to === "approved" && body.release === true && body.workerId && a.workerId === body.workerId && !a.screenshot) ok = true;
    if (!ok) { deny("illegal-transition", `illegal transition ${from} -> ${to}`); return { error: `illegal transition ${from} -> ${to}`, status: 409 }; }
    if (to === "prepared") {
      if (c.tier !== "practice" || r.tier !== "practice") { deny("not-practice-tier", "not practice tier"); return { error: "not practice tier", status: 409 }; }
      const g = gradeOf(c); if (g !== null && g > 6) { deny("grade-above-6", `grade ${g}`); return { error: "grade above 6", status: 409 }; }
      if (!a.url || !a.cv) { deny("no-package", "no package on this card"); return { error: "no package on this card - re-queue it for a worker instead", status: 409 }; }
    }
    if ((to === "approved" && from !== "submitting") || to === "submitting") {
      const bad = approveGuard(st, c, r);   // open screeners block approval too, even by hand: answer first, then approve
      if (bad) { deny(bad.error.replace(/\s+/g, "-"), bad.error, bad.detail); return bad; }
      if (to === "submitting" && sentToday(st) >= hunt(st).caps.perDay) { deny("daily-cap", `daily cap ${hunt(st).caps.perDay} reached`); return { error: "daily cap reached", status: 409 }; }
      if (to === "submitting" && sentLastHour(st) >= perHourOf(hunt(st))) { deny("hourly-cap", `hourly cap ${perHourOf(hunt(st))} reached`); return { error: "hourly cap reached", status: 409 }; }
      if (to === "approved") a.approvedAt = now;
    }
    if (to === "candidate") { c.hunt.status = gradeOf(c) !== null && gradeOf(c) <= 6 ? "graded" : "candidate"; c.hunt.attempts = 0; delete c.hunt.error; r.nextAction = "Candidate - waiting for the grader"; }
    if (to === "candidate" && fin && fin.found && fin.url && ATS_AUTO.has(fin.ats)) { a.formFinder = fin; a.url = fin.url; a.ats = fin.ats; delete a.reason; a.flags = { ...(a.flags || {}), formUnread: false }; r.nextAction = `Own ${fin.ats} form found by the PC finder - waiting for the preparer`; emit({ type: "decision", actor: "pc:finder", ...base, outcome: "ok", payload: { company: c.name, title: r.title, step: "find-form", decision: `${fin.ats} form found`, url: fin.url, via: fin.via, score: fin.score } }); }
    if (to === "submitting") { a.startedAt = now; a.attempts = (a.attempts || 0) + 1; if (clean(body.workerId, 60)) a.workerId = clean(body.workerId, 60); }
    if (to === "approved" && from === "submitting") { delete a.workerId; delete a.runId; r.nextAction = "Queued for the PC worker"; }
    if (to === "submitted") { a.submittedAt = now; r.stage = "applied"; r.stageAt = fmt(now); r.nextAction = `Submitted ${fmt(now)} - waiting for the receipt`; if (!p.reason) delete a.reason; ledgerPush(st, r, c, now); }   // a stale failure text from an earlier attempt must not sit on a submitted card (Vandelay, 21 Oct)
    if (to === "confirmed") a.confirmedAt = now;
    if (to === "unverified") a.unverifiedAt = now;
    if (to === "blocked") { a.blockedAt = now; r.nextAction = `Blocked (${clean(p.reason || a.reason || "?", 40)}) - apply by hand or skip`; }
    if (to === "failed") { a.failedAt = now; r.nextAction = `Runner failed (${clean(p.reason || a.reason || "?", 40)})`; }
    if (to === "skipped") r.nextAction = body.byHuman === true ? "Skipped by hand" : `Forfeited (${clean(p.reason || a.reason || "?", 60)})`;
    if (to === "prepared") r.nextAction = hunt(st).autoQueue ? "Prepared - approve on the board to queue it" : "Prepared - approve in the morning brief";
    if (to === "approved" && from !== "submitting") r.nextAction = "Queued for the PC worker";
    a.status = to;
    emit({ type: "transition", ...base, outcome: to === "unverified" ? "unverified" : to === "failed" ? "fail" : to === "blocked" ? "blocked" : (to === "approved" && from === "submitting") ? "released" : "ok", payload: { ...info, field: "apply.status", from, to, reason: clean(p.reason, 400) || (to === "skipped" || to === "failed" || to === "blocked" ? a.reason || null : null), screenshot: clean(p.screenshot, 400) || null, machine: clean(p.machine, 60) || null, attempts: a.attempts || 0 } });
  }
  for (const k of PATCH_EXTRA) {
    if (p[k] === undefined) continue;
    if (k === "answers") { if (p[k] && typeof p[k] === "object") a.answers = Object.fromEntries(Object.entries(p[k]).map(([q, v]) => [clean(q, 300), clean(v, 500)])); }
    else if (k === "needsHuman") { if (Array.isArray(p[k])) a.needsHuman = p[k].map(q => clean(q, 300)); }
    else if (k === "formFinder") { const f = finderNote(p[k]); if (f && !a.formFinder) { a.formFinder = f; emit({ type: "decision", actor: "pc:finder", ...base, outcome: f.found ? "ok" : "skipped", payload: { company: c.name, title: r.title, step: "find-form", decision: f.found ? `${f.ats} form found` : f.url ? `own portal (${f.portal || "?"}), no recipe` : "own form not found", url: f.url, via: f.via, checked: f.checked.length } }); } }
    else a[k] = clean(p[k], k === "log" ? 4000 : 400);
  }
  if (p.answers) { a.needsHuman = (a.screeners || []).map(s => s.q).filter(q => !(a.answers || {})[q]); emit({ type: "transition", ...base, payload: { company: c.name, title: r.title, field: "apply.answers", to: a.answers, open: a.needsHuman, by, byHuman: body.byHuman === true } }); }
  if (to === undefined && Object.keys(p).length) emit({ type: "log", ...base, payload: { company: c.name, title: r.title, message: `patch without a status change: ${Object.keys(p).join(", ")}`, by, fields: Object.keys(p), reason: clean(p.reason, 400) || null } });
  return { ok: true, role: r };
}

export default withObs("netlify:hunt", async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  const fromRoutine = secretOk(req);
  const site = process.env.URL || new URL(req.url).origin;
  if (req.method === "GET") {
    if (!fromRoutine) return json({ error: "unauthorized" }, 401);
    return json(summary((await readDoc()).state));
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!body || typeof body !== "object") return json({ error: "invalid payload" }, 422);

  if (fromRoutine) {
    tag({ kind: body.kind || (Array.isArray(body.candidates) ? "candidates" : "?"), roleId: clean(body.roleId, 40) || undefined });
    const doc = await readDoc(); const st = doc.state;
    let result;
    if (body.kind === "grade") result = ingestGrade(st, body);
    else if (body.kind === "prep") result = ingestPrep(st, body);
    else if (body.kind === "sort") result = ingestSort(st, body);
    else if (Array.isArray(body.candidates)) result = ingestCandidates(st, body);
    else return json({ error: "need candidates[] (finder), or kind:'sort' (sorter), or kind:'grade' / kind:'prep' with roleId" }, 422);
    const k = result.error ? { fired: [], events: [] } : await kick(st, site);
    sweepApply(st);
    st.updatedAt = new Date().toISOString();
    const w = await saveDoc(doc, st, { what: `agent ${body.kind || "candidates"}${body.roleId ? " " + clean(body.roleId, 40) : ""}` });
    if (w.conflict) return conflictResponse(w);
    return json({ ...result, kicked: k, rev: w.rev }, result.error ? result.status : 200);
  }

  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  tag({ action: clean(body.action, 20) });
  const doc = await readDoc(); const st = doc.state; const h = hunt(st); const now = new Date().toISOString();
  const save = async (extra = {}) => { st.updatedAt = now; const w = await saveDoc(doc, st, { what: `action ${clean(body.action, 20)}` }); if (w.conflict) return conflictResponse(w); return json({ ok: true, rev: w.rev, ...extra }); };

  if (body.action === "apply") {
    const res = applyPatch(st, body);
    if (res.error) return json(res, res.status);
    const k = res.role.apply.status === "candidate" ? await kick(st, site) : null;
    return save({ role: res.role, kicked: k });
  }
  if (body.action === "worker") {   // the PC worker: claim the oldest queued cards (atomic: they become submitting here), and/or report a run
    const workerId = clean(body.workerId, 60) || "worker", machine = clean(body.machine, 60);
    const out = {};
    setRun(clean(body.runId || (body.report && body.report.runId), 60) || null);
    if (body.report && typeof body.report === "object") {
      const rep = body.report, n = arr => Array.isArray(arr) ? arr.slice(0, 20).map(x => typeof x === "string" ? clean(x, 160) : { company: clean(x.company, 80), title: clean(x.title, 100), why: clean(x.why || x.reason, 160) }) : [];
      h.worker = { ...h.worker, lastAt: now, machine, workerId, chrome: clean(rep.chrome, 20), lastError: clean(rep.error, 200), lastReport: { at: now, runId: clean(rep.runId, 60), submitted: n(rep.submitted), failed: n(rep.failed), blocked: n(rep.blocked), unverified: n(rep.unverified), skipped: n(rep.skipped), ms: Number(rep.ms) || 0 } };
      const today = h.worker.today && h.worker.today.date === todayKey() ? h.worker.today : { date: todayKey(), submitted: 0, failed: 0, blocked: 0, unverified: 0, runs: 0 };
      today.runs++; today.submitted += n(rep.submitted).length; today.failed += n(rep.failed).length; today.blocked += n(rep.blocked).length; today.unverified += n(rep.unverified).length;
      // reviewer heartbeat (22 Oct 2026): the worker relays worker/reviewer/state.json so the board can show when the scheduled reviewer last ran
      if (rep.reviewer && typeof rep.reviewer === "object") { const rv = rep.reviewer; const iso = v => (typeof v === "string" && !Number.isNaN(Date.parse(v))) ? new Date(v).toISOString() : null; const int = v => Number.isInteger(v) ? v : (Number.isInteger(Number(v)) ? Number(v) : null); h.worker.reviewer = { at: now, lastRunAt: iso(rv.lastRunAt), startedAt: iso(rv.startedAt), open: int(rv.open), proven: int(rv.proven), digest: clean(rv.digest, 160), lastExit: int(rv.lastExit) }; }
      h.worker.today = today; out.worker = h.worker;
      // alerts (25 Oct 2026): what worker/alerts.mjs found open on the PC; the page shows them in a red "Needs you" banner
      // Netlify credit budget (25 Oct 2026), computed on the PC by worker/reviewer/credits.mjs: the System block's Credits line
      if (rep.credits && typeof rep.credits === "object") { const c = rep.credits; const num = v => Number.isFinite(Number(v)) ? Math.round(Number(v)) : null; const iso = v => (typeof v === "string" && !Number.isNaN(Date.parse(v))) ? new Date(v).toISOString() : null; h.worker.credits = { at: iso(c.at), used: num(c.used), projected: num(c.projected), budget: num(c.budget), resetAt: iso(c.resetAt), deploysLeft: num(c.deploysLeft), nextDeployAllowedAt: iso(c.nextDeployAllowedAt), lastBoardDeploy: iso(c.lastBoardDeploy) }; }
      if (Array.isArray(rep.alerts)) h.worker.alerts = rep.alerts.slice(0, 30).map(x => ({ id: clean(x && x.id, 80), sev: ["needs", "good", "info"].includes(x && x.sev) ? x.sev : "needs", text: clean(x && x.text, 300), since: clean(x && x.since, 40) })).filter(x => x.id && x.text).slice(0, 10);
      emit({ type: "heartbeat", actor: "pc:worker", entity_type: "worker", entity_id: workerId, outcome: rep.error ? "fail" : "ok", duration_ms: Number(rep.ms) || null, error_class: rep.error ? "worker-reported" : null, error_cause: clean(rep.error, 200) || null, error_handling: rep.error ? "handled" : null,
        payload: { workerId, machine, chrome: clean(rep.chrome, 20), runId: clean(rep.runId, 60), submitted: n(rep.submitted), failed: n(rep.failed), blocked: n(rep.blocked), unverified: n(rep.unverified), skipped: n(rep.skipped), today, reviewer: h.worker.reviewer || null } });
    }
    if (body.claim === true) {
      const max = Number.isInteger(body.max) && body.max >= 0 ? Math.min(body.max, 10) : 3;
      const roomDay = Math.max(0, h.caps.perDay - sentToday(st)), roomHour = Math.max(0, perHourOf(h) - sentLastHour(st));
      const room = Math.min(roomDay, roomHour);
      const claimed = [], refused = [];
      if (h.killSwitch) out.note = "kill switch is on";
      else if (!roomDay) out.note = "daily cap reached";
      else if (!roomHour) out.note = `hourly cap reached (${perHourOf(h)} per hour)`;
      else {
        const queue = st.roles.filter(r => r.apply && r.apply.status === "approved").sort((x, y) => String(x.apply.approvedAt || "").localeCompare(String(y.apply.approvedAt || "")));
        for (const r of queue) {
          if (claimed.length >= Math.min(max, room)) break;
          const c = roleCompany(st, r); if (!c) continue;
          const bad = approveGuard(st, c, r);
          if (bad) { refused.push({ roleId: r.id, company: c.name, why: bad.error, detail: bad.detail || "" }); refusedEv(bad.error.replace(/\s+/g, "-"), bad.error, { trace_id: r.id, entity_type: "role", entity_id: r.id, payload: { step: "claim", company: c.name, title: r.title, workerId, detail: bad.detail || "" } }); continue; }
          const a = r.apply; a.status = "submitting"; a.startedAt = now; a.attempts = (a.attempts || 0) + 1; a.workerId = workerId; a.runId = clean(body.runId, 60) || a.runId || ""; r.nextAction = "PC worker is submitting";
          emit({ type: "transition", trace_id: r.id, entity_type: "role", entity_id: r.id, payload: { company: c.name, title: r.title, field: "apply.status", from: "approved", to: "submitting", by: "worker", workerId, machine, runId: a.runId, attempts: a.attempts, ats: a.ats, approvedAt: a.approvedAt || null } });
          claimed.push({ roleId: r.id, companyId: c.id, company: c.name, domain: domainsOf(c)[0] || (c.hunt && c.hunt.domain) || "", title: r.title, grade: gradeOf(c), apply: { url: a.url, ats: a.ats, title: a.title, location: a.location, cv: a.cv, pdf: a.pdf || "", fields: a.fields || [], screeners: a.screeners || [], answers: a.answers || {}, flags: a.flags || {}, sentence: a.sentence || "" } });
        }
      }
      out.claimed = claimed; out.refused = refused; out.room = room; out.queue = queueCounts(st);
      h.worker = { ...h.worker, lastClaimAt: now, machine: machine || h.worker.machine, workerId };
      emit({ type: "claim", actor: "pc:worker", entity_type: "worker", entity_id: workerId, outcome: claimed.length ? "ok" : "skipped", payload: { workerId, machine, runId: clean(body.runId, 60) || null, max, room, roomDay, roomHour, perDay: h.caps.perDay, perHour: perHourOf(h), sentToday: sentToday(st), sentLastHour: sentLastHour(st), note: out.note || null, claimed: claimed.map(x => ({ roleId: x.roleId, company: x.company, ats: x.apply.ats })), refused, queue: out.queue } });
    }
    if (!out.claimed && !out.worker) return json({ error: "need claim:true and/or report:{}" }, 422);
    // the worker's 15-min tick is the clock that resumes the chain after a routine rate limit (27 Oct 2026)
    if (h.fireBackoffUntil && Date.now() >= Date.parse(h.fireBackoffUntil) || st.companies.some(c => c.hunt && c.hunt.status === "failed" && rateLimited(c.hunt.error))) out.kicked = await kick(st, site);
    const moved = sweepApply(st);
    return save({ ...out, swept: moved, killSwitch: h.killSwitch, perDay: h.caps.perDay });
  }
  if (body.action === "settings") {
    const before = JSON.parse(JSON.stringify({ killSwitch: h.killSwitch, autoQueue: h.autoQueue, caps: h.caps, concurrency: h.concurrency, denyExtra: h.denyExtra, seeds: h.seeds, answerBank: h.answerBank }));
    if (typeof body.killSwitch === "boolean") h.killSwitch = body.killSwitch;
    if (typeof body.autoQueue === "boolean") h.autoQueue = body.autoQueue;
    if (body.caps && typeof body.caps === "object") for (const k of ["found", "prepared", "offered"]) if (Number.isInteger(body.caps[k]) && body.caps[k] >= 0 && body.caps[k] <= 60) h.caps[k] = body.caps[k];
    if (body.caps && typeof body.caps === "object" && Number.isInteger(body.caps.perDay) && body.caps.perDay >= 0 && body.caps.perDay <= 20) h.caps.perDay = body.caps.perDay;
    if (body.caps && typeof body.caps === "object" && Number.isInteger(body.caps.perHour) && body.caps.perHour >= 1 && body.caps.perHour <= 20) h.caps.perHour = body.caps.perHour;
    if (Number.isInteger(body.concurrency) && body.concurrency >= 1 && body.concurrency <= 5) h.concurrency = body.concurrency;
    if (typeof body.denyExtra === "string") h.denyExtra = body.denyExtra.slice(0, 20000);
    if (typeof body.seeds === "string") h.seeds = body.seeds.slice(0, 20000);
    if (typeof body.answerBank === "string") { h.answerBank = body.answerBank.slice(0, 40000); h.answerBankAt = now; }
    const by = body.by === "claude-code" ? "claude-code" : "page";
    const sEv = (field, from, to) => emit({ type: "settings", actor: by === "claude-code" ? "claude-code" : "page:human", entity_type: "board", entity_id: "hunt", payload: { field, from, to, by } });
    for (const k of ["killSwitch", "autoQueue", "concurrency"]) if (before[k] !== h[k]) sEv(k, before[k], h[k]);
    for (const k of Object.keys({ ...before.caps, ...h.caps })) if (before.caps[k] !== h.caps[k]) sEv(`caps.${k}`, before.caps[k] ?? null, h.caps[k] ?? null);
    for (const k of ["denyExtra", "seeds"]) if (before[k] !== h[k]) sEv(k, before[k].slice(0, 2000), h[k].slice(0, 2000));
    if (before.answerBank !== h.answerBank) sEv("answerBank", `${before.answerBank.length} chars`, `${h.answerBank.length} chars`);
    return save({ hunt: { killSwitch: h.killSwitch, autoQueue: h.autoQueue, caps: h.caps, concurrency: h.concurrency, answerBankAt: h.answerBankAt } });
  }
  if (body.action === "feed") {   // supply widening item 5 (26 Oct 2026): the PC hands over LinkedIn's logged-out guest search (the cloud is refused); the finder's linkedin step reads it while fresh
    if (body.source !== "linkedin") { refused("feed-source", `unknown feed source ${clean(body.source, 20)}`, { payload: { source: clean(body.source, 20) } }); return json({ error: "unknown feed source" }, 422); }
    const sent = Array.isArray(body.roles) ? body.roles.length : 0;
    const rows = (Array.isArray(body.roles) ? body.roles : []).slice(0, 400).map(x => ({ name: clean(x && x.name, 80), title: clean(x && x.title, 100), url: clean(x && x.url, 300), location: clean(x && x.location, 80) || "Israel", ageDays: x && x.ageDays != null && Number.isFinite(Number(x.ageDays)) ? Math.round(Number(x.ageDays) * 10) / 10 : null }))
      .filter(x => x.title && /^https:\/\/[a-z]{2,3}\.linkedin\.com\/jobs\/view\/[^\s?#]+$/.test(x.url));
    h.feed = h.feed && typeof h.feed === "object" ? h.feed : {};
    h.feed.linkedin = { at: now, rows, queries: Number.isInteger(body.queries) ? body.queries : null, pages: Number.isInteger(body.pages) ? body.pages : null, refusedAt: clean(body.refusedAt, 40) || null };
    emit({ type: "log", actor: "pc:linkedin-feed", entity_type: "board", entity_id: "feed", payload: { step: "feed", source: "linkedin", sent, kept: rows.length, queries: h.feed.linkedin.queries, pages: h.feed.linkedin.pages, refusedAt: h.feed.linkedin.refusedAt } });
    return save({ feed: { source: "linkedin", at: now, rows: rows.length, sent } });
  }
  if (body.action === "kick") { const k = await kick(st, site); emit({ type: "log", entity_type: "run", entity_id: h.lastRun && h.lastRun.runId || null, payload: { step: "kick", message: `kick by hand: fired ${k.fired.length}, ${k.events.join("; ") || "no events"}`, fired: k.fired, events: k.events } }); return save({ kicked: k }); }
  if (body.action === "find") {   // "Hunt now": one step of the built-in finder (hunt-find.mjs); the page calls again until done
    const { findStep } = await import("./hunt-find.mjs");
    const r = await findStep(st, site, { manual: true });
    return save({ find: r, huntRun: st.huntRun || null, lastRun: r.done ? h.lastRun : undefined });
  }
  if (body.action === "sweep") { const moved = sweepApply(st); return save({ moved }); }
  if (body.action === "ledger") {   // hand-sent application that must count for never-twice
    const name = clean(body.name, 80); if (!name) return json({ error: "need name" }, 422);
    h.applied.push({ domain: host(body.domain || ""), name, at: now, roleId: clean(body.roleId, 20) || null });
    emit({ type: "ledger", trace_id: clean(body.roleId, 20) || null, entity_type: "company", entity_id: name, payload: { company: name, domain: host(body.domain || ""), roleId: clean(body.roleId, 20) || null, by: body.by === "claude-code" ? "claude-code" : "page", note: clean(body.note, 200) || null } });
    return save({ applied: h.applied.length });
  }
  refused("unknown-action", `unknown action ${clean(body.action, 40)}`, { payload: { action: clean(body.action, 40) } });
  return json({ error: "unknown action" }, 422);
});
