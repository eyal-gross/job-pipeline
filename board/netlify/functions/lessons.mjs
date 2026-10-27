import { readDoc, saveDoc, conflictResponse, authed } from "./state.mjs";
import { fireRoutine } from "./research.mjs";
import { withObs, emit, tag, setRun } from "./lib/obs.mjs";

// Learning pipeline: raw debriefs -> Claude routine -> lessons.
//  1. POST from the page  {companyId}                      -> gather that company's new debrief notes, fire the routine.
//  2. POST from the routine {companyId, takeaways, lessons} -> write takeaways onto the notes, merge the lessons list.
// The routine authenticates with x-secret (RESEARCH_SECRET); the page with x-key (PIPELINE_KEY).
// The routine can add or reinforce lessons. It can never delete one or change its status - those are Eyal's.

const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const uid = () => Math.random().toString(36).slice(2, 9);
const TYPES = new Set(["do", "dont", "general"]);
const imp = v => { const n = Math.round(Number(v)); return n >= 1 && n <= 10 ? n : 5; };
const clean = s => String(s ?? "").trim();

const debriefsOf = (doc, c) => {
  const own = (c.debriefs || []).map(d => ({ d, roleId: null }));
  const viaRoles = doc.state.roles.filter(r => r.companyId === c.id).flatMap(r => (r.debriefs || []).map(d => ({ d, roleId: r.id })));
  return [...own, ...viaRoles];
};

export default withObs("netlify:lessons", async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const fromRoutine = (req.headers.get("x-secret") || "") === (process.env.RESEARCH_SECRET || "__unset__");

  // ---- 2. routine posting the result ----
  if (fromRoutine) {
    if (!body.companyId || !Array.isArray(body.lessons)) return json({ error: "need companyId + lessons[]" }, 422);
    const doc = await readDoc();
    const c = doc.state.companies.find(x => x.id === body.companyId);
    if (!c) return json({ error: "company not found" }, 404);
    const now = new Date().toISOString();

    // takeaways land on the matching notes and mark them as extracted
    const all = debriefsOf(doc, c);
    const tw = new Map((body.takeaways || []).map(t => [t.debriefId, clean(t.takeaway)]));
    let marked = 0;
    for (const { d } of all) {
      if (!tw.has(d.id)) continue;
      d.takeaway = tw.get(d.id) || d.takeaway || "";
      d.distilledAt = now; marked++;
    }
    // any note that was sent but got no takeaway back still counts as extracted (the routine judged it had nothing new)
    for (const id of body.sentIds || []) { const hit = all.find(x => x.d.id === id); if (hit && !hit.d.distilledAt) { hit.d.distilledAt = now; marked++; } }

    // merge lessons: known id -> update text/type/count/sources, keep status; unknown -> new; missing -> untouched
    doc.state.lessons = doc.state.lessons || [];
    const byId = new Map(doc.state.lessons.map(l => [l.id, l]));
    let added = 0, updated = 0;
    for (const inc of body.lessons) {
      const text = clean(inc.text), title = clean(inc.title).slice(0, 80); if (!text && !title) continue;
      const type = TYPES.has(inc.type) ? inc.type : "general";
      const importance = imp(inc.importance);
      const sources = Array.isArray(inc.sources) ? inc.sources.filter(s => s && s.companyId).map(s => ({ companyId: s.companyId, roleId: s.roleId || null, debriefId: s.debriefId || null })) : [];
      const cur = inc.id && byId.get(inc.id);
      if (cur) {
        cur.text = text || cur.text; cur.type = type; if (title) cur.title = title;
        if (cur.importanceBy !== "human") cur.importance = importance;   // Eyal's own grade sticks
        cur.count = Math.max(Number(inc.count) || 1, cur.count || 1);
        const seen = new Set((cur.sources || []).map(s => `${s.companyId}|${s.roleId}|${s.debriefId}`));
        for (const s of sources) { const k = `${s.companyId}|${s.roleId}|${s.debriefId}`; if (!seen.has(k)) { (cur.sources = cur.sources || []).push(s); seen.add(k); } }
        cur.updatedAt = now; updated++;
      } else {
        doc.state.lessons.push({ id: uid(), type, title, text, importance, count: Math.max(1, Number(inc.count) || 1), sources: sources.length ? sources : [{ companyId: c.id, roleId: null, debriefId: null }], status: "new", createdAt: now, updatedAt: now });
        added++;
      }
    }
    delete doc.state.lessonsRun;
    doc.state.updatedAt = now;
    tag({ kind: "lessons-result" }); setRun(`lessons-${c.id}`);
    emit({ type: "decision", actor: "agent:lessons", entity_type: "company", entity_id: c.id, outcome: "ok", payload: { company: c.name, item: c.id, decision: `lessons: ${added} added, ${updated} updated, ${marked} notes marked`, added, updated, marked, trace: body.trace || null } });
    const w = await saveDoc(doc, doc.state, { what: `lessons result ${c.name}` });
    if (w.conflict) return conflictResponse(w);
    return json({ ok: true, rev: w.rev, marked, added, updated });
  }

  // ---- 1. page asking to extract lessons ----
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  tag({ action: "lessons" });
  if (!body.companyId) return json({ error: "need companyId" }, 422);
  const doc = await readDoc();
  const c = doc.state.companies.find(x => x.id === body.companyId);
  if (!c) return json({ error: "company not found" }, 404);
  const all = debriefsOf(doc, c);
  const pending = all.filter(x => clean(x.d.text) && !x.d.distilledAt);
  if (!pending.length) return json({ error: "nothing new to extract" }, 422);

  const site = process.env.URL || new URL(req.url).origin;
  const roles = doc.state.roles.filter(r => r.companyId === c.id).map(r => ({ id: r.id, title: r.title, stage: r.stage }));
  const payload = {
    kind: "lessons",
    companyId: c.id, company: c.name, what: c.what, stage: c.stage,
    roles,
    debriefs: pending.map(({ d, roleId }) => ({ id: d.id, roleId, round: d.round, date: d.date, text: d.text })),
    priorTakeaways: all.filter(x => x.d.distilledAt).map(({ d, roleId }) => ({ roleId, round: d.round, takeaway: d.takeaway })),
    lessons: (doc.state.lessons || []).map(l => ({ id: l.id, type: l.type, title: l.title || "", text: l.text, importance: imp(l.importance), count: l.count || 1, sources: l.sources || [] })),
    callback: `${site}/.netlify/functions/lessons`,
    brief: `${site}/lessons-brief.md`,
  };

  doc.state.lessonsRun = { status: "running", companyId: c.id, requestedAt: new Date().toISOString(), sentIds: pending.map(x => x.d.id) };
  const fire = await fireRoutine(payload);
  if (!fire.ok) doc.state.lessonsRun = { status: "error", companyId: c.id, error: fire.error || `fire failed (${fire.status})`, requestedAt: doc.state.lessonsRun.requestedAt };
  doc.state.updatedAt = new Date().toISOString();
  setRun(`lessons-${c.id}`);
  const w = await saveDoc(doc, doc.state, { what: `lessons request ${c.name}` });
  if (w.conflict) return conflictResponse(w);
  return json({ ok: fire.ok, fire, ...w.next }, fire.ok ? 200 : 502);
});
