import { getStore } from "@netlify/blobs";
import { AsyncLocalStorage } from "node:async_hooks";

// Board-side observability (MONITORING-PLAN.md §2 "Board functions", built 20 Oct 2026).
// Every function handler runs inside withObs(): events emitted during the request are buffered in memory, printed to the Netlify
// log as one JSON line each, and flushed at the end of the request into ONE blob chunk `events/<yyyy-mm-dd>/<id>.jsonl` in the
// store `job-pipeline-events`. The PC collector (obs/collect.mjs) lists, downloads and deletes the chunks through
// netlify/functions/obs.mjs; nothing on the board ever reads them back. A failed flush is logged and never fails the request.
// Event shape = obs/lib.mjs makeEvent(): ts, run_id, trace_id (= role id), span_id, actor, type, severity, entity_type, entity_id,
// outcome, duration_ms, error_class, error_cause, error_handling, payload, seq. Nothing is ever updated; corrections are new events.

export const EVENTS_STORE = "job-pipeline-events";
export const RING_DAYS = 7;   // the board keeps a week of chunks at most; the PC is the archive

// One context per request. AsyncLocalStorage keeps concurrent requests apart (netlify dev runs them in one process; Lambda would not need it).
const als = new AsyncLocalStorage();
let fallback = null;   // a context for code that runs outside withObs (tests, tools)
const cur = () => als.getStore() || fallback;
const clip = (s, n) => String(s ?? "").slice(0, n);

export function begin(actor, { run_id = null } = {}) {
  fallback = { actor, run_id, events: [], t0: Date.now(), tags: {} };
  return fallback;
}
export function setRun(run_id) { const c = cur(); if (c && run_id) c.run_id = run_id; }
export function tag(obj) { const c = cur(); if (c) Object.assign(c.tags, obj); }
export const current = cur;

// emit one canonical event; returns it. Safe to call with no context (the event is printed and dropped).
export function emit(ev) {
  const ctx = cur();
  const e = {
    ts: new Date().toISOString(), run_id: (ctx && ctx.run_id) || null, trace_id: null, span_id: null, parent_span_id: null,
    actor: (ctx && ctx.actor) || "netlify:unknown", type: "log", severity: "info", entity_type: null, entity_id: null,
    outcome: null, duration_ms: null, error_class: null, error_cause: null, error_handling: null,
    ...ev, payload: ev.payload && typeof ev.payload === "object" ? ev.payload : {},
  };
  if (e.run_id === null && ctx && ctx.run_id) e.run_id = ctx.run_id;
  try { console.log("obs " + JSON.stringify(e)); } catch { /* circular payload */ }
  if (ctx) ctx.events.push(e);
  return e;
}
// shorthands
export const error = (cls, cause, { handling = "handled", severity = "error", ...rest } = {}) =>
  emit({ type: "error", severity, outcome: "fail", error_class: clip(cls, 60), error_cause: clip(cause, 400), error_handling: handling, ...rest });
export const refused = (cls, cause, rest = {}) =>
  emit({ type: "guard.refused", severity: "warn", outcome: "refused", error_class: clip(cls, 60), error_cause: clip(cause, 400), error_handling: "refused", ...rest, payload: { reason: clip(cls, 60), ...(rest.payload || {}) } });
// step timing: const end = step("drushim"); ... end("ok", { rolesSeen: n })
export function step(name, rest = {}) {
  const t0 = Date.now(); const span_id = `${name}-${t0.toString(36)}`;
  emit({ type: "step.start", span_id, ...rest, payload: { step: name, ...(rest.payload || {}) } });
  return (outcome = "ok", extra = {}) => emit({ type: "step.end", span_id, outcome, duration_ms: Date.now() - t0, ...rest, payload: { step: name, ...(rest.payload || {}), ...extra } });
}

// write the buffered events as one chunk; returns the key or null
export async function flush() {
  const c = cur(); if (c === fallback) fallback = null;
  if (!c || !c.events.length) return null;
  const evs = c.events.splice(0);   // a second flush of the same context writes nothing
  const day = evs[0].ts.slice(0, 10);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const key = `events/${day}/${id}.jsonl`;
  evs.forEach((e, i) => { if (e.seq === undefined || e.seq === null) e.seq = `${id}#${i}`; });
  const body = evs.map(e => JSON.stringify(e)).join("\n") + "\n";
  try { await getStore(EVENTS_STORE).set(key, body, { metadata: { actor: c.actor, n: evs.length, day } }); return key; }
  catch (e) { console.log(`obs flush failed (${evs.length} events lost): ${clip(e && e.message || e, 200)}`); return null; }
}

const authKind = req => req.headers.get("x-secret") ? "secret" : req.headers.get("x-key") ? "key" : "none";

// Wrap a handler: context per request, an `error` event with the stack on any throw (-> 500), a `request` event for every write
// (and for any GET that failed), then flush. The request event carries the handler's tags (action / kind) so a question like
// "which calls hit the board tonight" is answerable without reading the Netlify log.
export function withObs(actor, handler) {
  return (req, context) => als.run({ actor, run_id: null, events: [], t0: Date.now(), tags: {} }, () => handle(actor, handler, req, context));
}
async function handle(actor, handler, req, context) {
  {
    const t0 = Date.now(); let res; let threw = null;
    try { res = await handler(req, context); }
    catch (err) {
      threw = err;
      error("unhandled", err && err.message || err, { handling: "unhandled", entity_type: "board", entity_id: actor, payload: { method: req.method, path: safePath(req), stack: clip(err && err.stack, 1500) } });
      res = Response.json({ error: "internal error", detail: clip(err && err.message || err, 300) }, { status: 500, headers: { "cache-control": "no-store" } });
    }
    const status = res ? res.status : 0;
    const quiet = actor === "netlify:obs" && status < 400;   // the collector's own list / download / delete calls must not create new chunks
    if ((req.method !== "GET" && req.method !== "OPTIONS" || status >= 400 || threw) && !quiet) {
      const c = cur() || {};
      emit({ type: "request", outcome: status < 400 ? "ok" : "fail", duration_ms: Date.now() - t0, entity_type: "board", entity_id: actor, severity: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
        payload: { method: req.method, path: safePath(req), auth: authKind(req), status, events: (c.events || []).length, scheduled: !!(c.tags && c.tags.scheduled), ...(c.tags || {}) } });
    }
    await flush();
    return res;
  }
}
const safePath = req => { try { const u = new URL(req.url); return u.pathname + (u.search ? "?" + clip(u.search.replace(/key=[^&]*/g, "key=[redacted]"), 120) : ""); } catch { return ""; } };

// ---------- diff summary for page saves (state.mjs POST): which companies / roles / fields changed, plus transition events ----------
const byId = arr => Object.fromEntries((Array.isArray(arr) ? arr : []).filter(x => x && x.id).map(x => [x.id, x]));
const changedFields = (a, b, skip = []) => { const ks = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]); const out = []; for (const k of ks) { if (skip.includes(k)) continue; if (JSON.stringify(a ? a[k] : undefined) !== JSON.stringify(b ? b[k] : undefined)) out.push(k); } return out; };
const sval = x => typeof x === "string" ? clip(x, 2000) : (x ?? null);
const gradeOf = c => { const g = c && c.research && c.research.fit && c.research.fit.grade; return Number.isInteger(g) ? g : null; };

export function diffState(prev, next, { by = "page" } = {}) {
  const d = { companies: { added: [], removed: [], changed: [] }, roles: { added: [], removed: [], changed: [] }, people: { added: 0, removed: 0, changed: 0 }, tasks: { added: 0, removed: 0, doneChanged: 0 }, hunt: [], other: [] };
  const transitions = [];
  const pc = byId(prev.companies), nc = byId(next.companies), pr = byId(prev.roles), nr = byId(next.roles);
  for (const c of Object.values(nc)) {
    const p = pc[c.id];
    if (!p) { d.companies.added.push(c.name); transitions.push({ entity_type: "company", entity_id: c.id, payload: { company: c.name, field: "company", from: null, to: "created", tier: c.tier || null, by } }); continue; }
    const f = changedFields(p, c); if (f.length) d.companies.changed.push({ id: c.id, name: c.name, fields: f });
    if ((p.tier || null) !== (c.tier || null)) transitions.push({ entity_type: "company", entity_id: c.id, payload: { company: c.name, field: "tier", from: p.tier || null, to: c.tier || null, grade: gradeOf(c), by } });
    if (gradeOf(p) !== gradeOf(c)) transitions.push({ entity_type: "company", entity_id: c.id, payload: { company: c.name, field: "grade", from: gradeOf(p), to: gradeOf(c), by } });
  }
  for (const p of Object.values(pc)) if (!nc[p.id]) { d.companies.removed.push(p.name); transitions.push({ entity_type: "company", entity_id: p.id, payload: { company: p.name, field: "company", from: "present", to: "removed", by } }); }
  for (const r of Object.values(nr)) {
    const p = pr[r.id]; const c = nc[r.companyId] || {}; const a = r.apply || {}, pa = (p && p.apply) || {};
    if (!p) { d.roles.added.push(`${c.name || "?"} / ${r.title}`); transitions.push({ trace_id: r.id, entity_type: "role", entity_id: r.id, payload: { company: c.name, title: r.title, field: "role", from: null, to: "created", stage: r.stage, status: a.status || null, by } }); continue; }
    const f = changedFields(p, r, ["apply"]); const fa = changedFields(pa, a).map(k => `apply.${k}`); const all = [...f, ...fa];
    if (all.length) d.roles.changed.push({ id: r.id, company: c.name, title: r.title, fields: all });
    if ((pa.status || null) !== (a.status || null)) transitions.push({ trace_id: r.id, entity_type: "role", entity_id: r.id, payload: { company: c.name, title: r.title, field: "apply.status", from: pa.status || null, to: a.status || null, reason: a.reason || null, by, byHuman: by === "page" } });
    if ((p.stage || null) !== (r.stage || null)) transitions.push({ trace_id: r.id, entity_type: "role", entity_id: r.id, payload: { company: c.name, title: r.title, field: "stage", from: p.stage || null, to: r.stage || null, by, byHuman: by === "page" } });
    if (JSON.stringify(pa.answers || {}) !== JSON.stringify(a.answers || {})) transitions.push({ trace_id: r.id, entity_type: "role", entity_id: r.id, payload: { company: c.name, title: r.title, field: "apply.answers", from: pa.answers || {}, to: a.answers || {}, by, byHuman: by === "page" } });
  }
  for (const p of Object.values(pr)) if (!nr[p.id]) { const c = pc[p.companyId] || {}; d.roles.removed.push(`${c.name || "?"} / ${p.title}`); transitions.push({ trace_id: p.id, entity_type: "role", entity_id: p.id, payload: { company: c.name, title: p.title, field: "apply.status", from: p.apply && p.apply.status || null, to: "removed", reason: `removed by ${by}`, by, byHuman: by === "page" } }); }
  const pp = byId(prev.people), np = byId(next.people);
  for (const x of Object.values(np)) { if (!pp[x.id]) d.people.added++; else if (changedFields(pp[x.id], x).length) d.people.changed++; }
  for (const x of Object.values(pp)) if (!np[x.id]) d.people.removed++;
  const pt = byId(prev.tasks), nt = byId(next.tasks);
  for (const x of Object.values(nt)) { if (!pt[x.id]) d.tasks.added++; else if (!!pt[x.id].done !== !!x.done) d.tasks.doneChanged++; }
  for (const x of Object.values(pt)) if (!nt[x.id]) d.tasks.removed++;
  const ph = prev.hunt || {}, nh = next.hunt || {};
  for (const k of changedFields(ph, nh, ["worker", "runs", "lastRun", "find", "applied", "boards"])) d.hunt.push(k);
  for (const k of ["channels", "mail", "lessons", "updatedAt"]) if (JSON.stringify(prev[k] ?? null) !== JSON.stringify(next[k] ?? null)) d.other.push(k);
  const settings = [];
  for (const k of ["killSwitch", "autoQueue", "concurrency", "denyExtra", "seeds", "answerBank"]) if (JSON.stringify(ph[k] ?? null) !== JSON.stringify(nh[k] ?? null)) settings.push({ field: k, from: sval(ph[k]), to: sval(nh[k]) });
  for (const k of Object.keys({ ...(ph.caps || {}), ...(nh.caps || {}) })) if ((ph.caps || {})[k] !== (nh.caps || {})[k]) settings.push({ field: `caps.${k}`, from: (ph.caps || {})[k] ?? null, to: (nh.caps || {})[k] ?? null });
  const empty = !d.companies.added.length && !d.companies.removed.length && !d.companies.changed.length && !d.roles.added.length && !d.roles.removed.length && !d.roles.changed.length && !d.people.added && !d.people.removed && !d.people.changed && !d.tasks.added && !d.tasks.removed && !d.tasks.doneChanged && !d.hunt.length && !d.other.filter(k => k !== "updatedAt").length;
  return { summary: d, transitions, settings, empty };
}
