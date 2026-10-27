import { readDoc, saveDoc, conflictResponse, authed } from "./state.mjs";
import { withObs, emit, error as obsError, tag, setRun } from "./lib/obs.mjs";

// Two jobs:
//  1. POST from the page  {companyId}            -> mark the company "running" and fire the Claude routine.
//  2. POST from the routine {companyId, research} -> store the finished research on the company.
// The routine authenticates with x-secret (RESEARCH_SECRET); the page with x-key (PIPELINE_KEY).

const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

// Fire one claude.ai routine run. Every attempt is an event (kind, company, HTTP status, first 500 chars of the answer, ms).
export async function fireRoutine(payload) {
  const url = process.env.ROUTINE_FIRE_URL;
  const token = process.env.ROUTINE_TOKEN;
  const base = { type: "fire", entity_type: payload && payload.roleId ? "role" : payload && payload.companyId ? "company" : "run", entity_id: (payload && (payload.roleId || payload.companyId || payload.runId)) || null, trace_id: (payload && payload.roleId) || null };
  const info = { kind: payload && payload.kind, company: payload && (payload.name || payload.company) || null, runId: payload && payload.runId || null };
  if (!url || !token) { emit({ ...base, outcome: "skipped", severity: "warn", error_class: "routine-not-configured", error_cause: "ROUTINE_FIRE_URL / ROUTINE_TOKEN not set", error_handling: "parked", payload: { ...info, reason: "routine not configured" } }); return { ok: false, error: "routine not configured" }; }
  const t0 = Date.now();
  let r, text;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: JSON.stringify(payload) }),
    });
    text = await r.text();
  } catch (e) {
    emit({ ...base, outcome: "fail", severity: "error", duration_ms: Date.now() - t0, error_class: "fire-failed", error_cause: String(e && e.message || e).slice(0, 300), error_handling: "handled", payload: { ...info, status: 0 } });
    return { ok: false, status: 0, error: String(e && e.message || e).slice(0, 120) };
  }
  const body = text.slice(0, 500);
  emit({ ...base, outcome: r.ok ? "ok" : "fail", severity: r.ok ? "info" : "error", duration_ms: Date.now() - t0, error_class: r.ok ? null : "fire-failed", error_cause: r.ok ? null : `routine trigger answered ${r.status}: ${body.slice(0, 200)}`, error_handling: r.ok ? null : "handled", payload: { ...info, status: r.status, bytes: text.length, response: body, payloadBytes: JSON.stringify(payload).length } });
  return { ok: r.ok, status: r.status, body };
}

export default withObs("netlify:research", async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const fromRoutine = (req.headers.get("x-secret") || "") === (process.env.RESEARCH_SECRET || "__unset__");

  // ---- 2. routine posting a result ----
  if (fromRoutine) {
    tag({ kind: "research-result" });
    if (!body.companyId || !body.research) return json({ error: "need companyId + research" }, 422);
    const doc = await readDoc();
    const c = doc.state.companies.find(x => x.id === body.companyId);
    if (!c) { obsError("company-not-found", `research result for unknown company ${body.companyId}`, { payload: { companyId: body.companyId } }); return json({ error: "company not found" }, 404); }
    setRun(`research-${c.id}`);
    const r = body.research;
    const prev = c.research || {};
    c.research = { ...r, status: "done", updatedAt: new Date().toISOString(), depth: prev.depth, context: prev.context || "", requestedAt: prev.requestedAt };
    // fill the plain fields only where Eyal left them empty
    if (!c.what && r.summary) c.what = r.summary;
    const hc = typeof r.headcount === "number" ? `~${r.headcount} people` : (r.headcount || "");
    if (!c.stage && r.stage) c.stage = [r.stage, hc, r.location].filter(Boolean).join(" · ");
    if (!c.ceo && Array.isArray(r.founders) && r.founders.length) {
      const ceo = r.founders.find(f => /ceo/i.test(f.role || "")) || r.founders[0];
      c.ceo = [ceo.name, ceo.role, ceo.background].filter(Boolean).join(" - ");
    }
    if (r.logo) c.logo = r.logo;
    emit({ type: "decision", actor: "agent:research", entity_type: "company", entity_id: c.id, outcome: "ok", duration_ms: prev.requestedAt ? Date.now() - Date.parse(prev.requestedAt) : null,
      payload: { company: c.name, item: c.id, decision: `grade ${r.fit && r.fit.grade}`, grade: r.fit && r.fit.grade, reason: (r.fit && (r.fit.reasons || []).join("; ")) || "", evidence: r.sources || [], depth: prev.depth, context: !!prev.context, promptVersion: r.promptVersion || null, trace: body.trace || null } });
    doc.state.updatedAt = new Date().toISOString();
    const w = await saveDoc(doc, doc.state, { what: `research result ${c.name}` });
    if (w.conflict) return conflictResponse(w);
    return json({ ok: true, rev: w.rev });
  }

  // ---- 1. page asking for research ----
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  tag({ action: "research" });
  if (!body.companyId) return json({ error: "need companyId" }, 422);
  const doc = await readDoc();
  const c = doc.state.companies.find(x => x.id === body.companyId);
  if (!c) return json({ error: "company not found" }, 404);
  setRun(`research-${c.id}`);

  const site = process.env.URL || new URL(req.url).origin;
  const people = (c.peopleIds || []).map(id => doc.state.people.find(p => p.id === id)).filter(Boolean)
    .map(p => ({ name: p.name, who: p.who, why: p.why }));
  const roles = doc.state.roles.filter(r => r.companyId === c.id).map(r => r.title);
  const context = String(body.context || "").trim().slice(0, 2000);
  const payload = {
    companyId: c.id, name: c.name, what: c.what, stage: c.stage, ceo: c.ceo, links: c.links, notes: c.notes,
    wayIn: people, rolesOfInterest: roles, context,
    depth: body.depth === "deep" ? "deep" : "standard",
    callback: `${site}/.netlify/functions/research`,
    brief: `${site}/research-brief.md`,
  };

  c.research = { ...(c.research || {}), status: "running", error: undefined, requestedAt: new Date().toISOString(), depth: payload.depth, context };
  const fire = await fireRoutine(payload);
  if (!fire.ok) c.research = { ...(c.research || {}), status: "error", error: fire.error || `fire failed (${fire.status})`, requestedAt: c.research.requestedAt };
  doc.state.updatedAt = new Date().toISOString();
  const w = await saveDoc(doc, doc.state, { what: `research request ${c.name}` });
  if (w.conflict) return conflictResponse(w);
  return json({ ok: fire.ok, fire, ...w.next }, fire.ok ? 200 : 502);
});
