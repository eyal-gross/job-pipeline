import { readDoc, saveDoc, conflictResponse, authed } from "./state.mjs";
import { confirmApply, sweepApply, nameKey, kick } from "./hunt.mjs";
import { withObs, emit, error as obsError, tag, setRun, step } from "./lib/obs.mjs";

// Mail clerk: a scheduled Claude routine reads Gmail and files job mail on the board.
//  GET  with x-secret            -> compact board summary the clerk reads BEFORE searching Gmail.
//  POST with x-secret {items..}  -> file the classified mail: move stages, add tasks, create auto-added cards.
//  POST with x-key {}            -> "Check now" from the page: fires the routine if MAIL_FIRE_URL/MAIL_TOKEN are set.
// The clerk never deletes anything here and never touches odds, tier, lessons or Eyal's own notes.
// Observability: every item received is a `mail` event (kind, how it was matched, what it did), every stage move a `transition`,
// every confirmed application a `receipt`, every skip carries its reason; the run itself is a step.end with the counts.

const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const uid = () => Math.random().toString(36).slice(2, 9);
const clean = (s, n = 400) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const KINDS = new Set(["reply", "rejected", "update", "ack", "noise"]);
const fmt = d => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const host = u => { try { return new URL(/^https?:/.test(u) ? u : "https://" + u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const secretOk = req => (req.headers.get("x-secret") || "") === (process.env.RESEARCH_SECRET || "__unset__");

function summary(doc) {
  const st = doc.state;
  const companies = st.companies.map(c => {
    const links = String(c.links || "").split(/[\s,]+/).map(host).filter(Boolean);
    const r = c.research || {};
    const extra = [r.logo].map(host).filter(Boolean);
    const generic = /linkedin|framerusercontent|crunchbase|google|notion|github|wikipedia|techcrunch|calcalist|globes|ycombinator/i;
    return { id: c.id, name: c.name, domains: [...new Set([...links, ...extra])].filter(h => !generic.test(h)).slice(0, 4), autoAdded: !!c.autoAdded };
  });
  const roles = st.roles.map(r => ({ id: r.id, title: r.title, companyId: r.companyId, stage: r.stage, stageAt: r.stageAt || "", submittedAt: (r.apply && r.apply.submittedAt) || "" }));   // lets the clerk match receipts that name no company (AdamTotal, Top Group), 25 Oct
  const people = st.people.filter(p => p.name).map(p => ({ id: p.id, name: p.name, companies: st.companies.filter(c => (c.peopleIds || []).includes(p.id)).map(c => c.name) }));
  const m = st.mail || {};
  return { checkedAt: m.checkedAt || "", lastRun: m.lastRun || null, seen: m.seen || [], companies, roles, people };
}

export default withObs("netlify:mail", async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  const fromRoutine = secretOk(req);

  if (req.method === "GET") {
    if (!fromRoutine) return json({ error: "unauthorized" }, 401);
    return json(summary(await readDoc()));
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  // ---- clerk posting its result ----
  if (fromRoutine) {
    tag({ kind: "mail-result" });
    if (!Array.isArray(body.items)) return json({ error: "need items[]" }, 422);
    const doc = await readDoc();
    const st = doc.state;
    const now = new Date().toISOString();
    const runId = clean(body.runId, 40) || `mail-${now.slice(0, 16)}`;
    setRun(runId);
    const endRun = step("mail.file", { actor: "agent:mail-clerk", entity_type: "run", entity_id: runId, payload: { items: body.items.length, scanned: Number(body.scanned) || null, checkedAt: body.checkedAt || null } });
    st.mail = st.mail || { seen: [] };
    const seen = new Set(st.mail.seen || []);
    const counts = { reply: 0, rejected: 0, update: 0, ack: 0, noise: 0 };
    let filed = 0, created = 0, skipped = 0;
    const byName = n => st.companies.find(c => clean(c.name).toLowerCase() === clean(n).toLowerCase()) || st.companies.find(c => nameKey(c.name) && nameKey(c.name) === nameKey(n));
    const openRole = c => st.roles.filter(r => r.companyId === c.id && r.stage !== "closed").sort((a, b) => String(b.stageAt || "").localeCompare(String(a.stageAt || "")))[0] || st.roles.filter(r => r.companyId === c.id)[0];
    const mailEvent = (it, kind, extra) => emit({ type: "mail", actor: "agent:mail-clerk", trace_id: extra.roleId || null, entity_type: extra.roleId ? "role" : "run", entity_id: extra.roleId || runId, outcome: extra.outcome || "ok",
      payload: { kind, gmailId: clean(it.gmailId, 64), subject: clean(it.subject, 160), from: clean(it.from, 120), date: it.date || null, summary: clean(it.summary, 300), link: clean(it.link, 300), ...extra } });

    const ordered = body.items.slice().sort((x, y) => String(x.date || "").localeCompare(String(y.date || "")));   // oldest first, so the newest mail sets the final stage and next action
    for (const it of ordered) {
      const kind = KINDS.has(it.kind) ? it.kind : "noise";
      counts[kind]++;
      if (kind === "noise") { mailEvent(it, kind, { outcome: "skipped", reason: "noise", how: "classified noise" }); continue; }
      const gmailId = clean(it.gmailId, 64); if (!gmailId || seen.has(gmailId)) { skipped++; mailEvent(it, kind, { outcome: "skipped", reason: gmailId ? "already seen" : "no gmailId", how: "dedupe" }); continue; }

      // resolve company + role
      let c = it.companyId ? st.companies.find(x => x.id === it.companyId) : null;
      let r = it.roleId ? st.roles.find(x => x.id === it.roleId) : null;
      let how = c ? "companyId" : r ? "roleId" : "";
      if (r && !c) c = st.companies.find(x => x.id === r.companyId);
      const nc = it.newCompany && clean(it.newCompany.name, 80);
      if (!c && nc) { c = byName(nc); how = c ? "newCompany matched by name" : "newCompany created"; if (!c) { c = { id: uid(), name: nc, what: "", stage: "", ceo: "", fit: "", links: clean(it.newCompany.url || "", 200), notes: "", peopleIds: [], autoAdded: true }; st.companies.push(c); created++; emit({ type: "transition", actor: "agent:mail-clerk", entity_type: "company", entity_id: c.id, payload: { company: c.name, field: "company", from: null, to: "created", by: "mail-clerk", url: c.links } }); } }
      if (!c) { skipped++; mailEvent(it, kind, { outcome: "skipped", reason: "no company matched", how: "unmatched", companyId: it.companyId || null, roleId: it.roleId || null, newCompany: nc || null }); continue; }
      if (!r) { r = openRole(c); if (r) how += " -> open role"; }
      if (!r) {
        const title = clean((it.newCompany && it.newCompany.roleTitle) || it.roleTitle || "", 80) || "Role from email";
        r = { id: uid(), companyId: c.id, title, viaId: null, stage: "applied", stageAt: fmt(it.date || now), odds: "unknown", nextAction: "", notes: "", tier: "real", autoAdded: true };
        st.roles.push(r); created++; how += " -> role created";
        emit({ type: "transition", actor: "agent:mail-clerk", trace_id: r.id, entity_type: "role", entity_id: r.id, payload: { company: c.name, title, field: "role", from: null, to: "created", stage: "applied", by: "mail-clerk" } });
      }

      // file the mail on the role
      r.mail = r.mail || [];
      const entry = { id: uid(), gmailId, threadId: clean(it.threadId, 64), link: clean(it.link, 300), date: it.date || now, from: clean(it.from, 120), subject: clean(it.subject, 160), summary: clean(it.summary, 300), kind };
      r.mail.unshift(entry);
      seen.add(gmailId); filed++;
      const when = fmt(it.date || now);
      const stageBefore = r.stage, applyBefore = r.apply && r.apply.status;
      const effects = [];

      // effects
      if (kind === "ack") { if (r.stage === "lead" || r.stage === "in-conversation") { r.stage = "applied"; r.stageAt = when; } if (confirmApply(r)) { r.nextAction = `Receipt filed ${when} - application confirmed`; effects.push("confirmed"); emit({ type: "receipt", actor: "agent:mail-clerk", trace_id: r.id, entity_type: "role", entity_id: r.id, outcome: "ok", payload: { company: c.name, title: r.title, from: applyBefore, to: "confirmed", subject: entry.subject, sender: entry.from, date: entry.date, gmailId, submittedAt: r.apply.submittedAt || null } }); } }
      if (kind === "rejected") { if (r.stage !== "closed") { r.stage = "closed"; r.stageAt = when; } if (!/^Rejected by email/.test(r.nextAction || "")) r.nextAction = `Rejected by email, ${when}`; effects.push("closed"); }
      if (kind === "reply") {
        const text = `Reply to ${clean(it.from, 60) || "them"}: ${clean(it.summary, 160)}`;
        if (!st.tasks.some(t => t.owner && t.owner.type === "role" && t.owner.id === r.id && t.text === text)) { st.tasks.push({ id: uid(), text, done: false, owner: { type: "role", id: r.id }, createdAt: Date.now() }); effects.push("task added"); }
        r.nextAction = text;
        if (r.stage === "applied" || r.stage === "lead") { r.stage = "in-conversation"; r.stageAt = when; }
      }
      if (kind === "update" && clean(it.nextAction)) { r.nextAction = clean(it.nextAction, 160); effects.push("nextAction set"); }
      if (r.stage !== stageBefore) { effects.push(`stage ${stageBefore} -> ${r.stage}`); emit({ type: "transition", actor: "agent:mail-clerk", trace_id: r.id, entity_type: "role", entity_id: r.id, payload: { company: c.name, title: r.title, field: "stage", from: stageBefore, to: r.stage, reason: `mail: ${kind}`, by: "mail-clerk", gmailId } }); }
      mailEvent(it, kind, { roleId: r.id, company: c.name, title: r.title, how, effects, mailId: entry.id, stage: r.stage });
    }

    st.mail.checkedAt = (body.checkedAt && Date.parse(body.checkedAt) < Date.now()) ? body.checkedAt : now;   // a clerk wrote a future checkedAt on 25 Oct ("12:00Z" at 05:58Z): never keep a time ahead of the clock
    st.mail.lastRun = { at: now, scanned: Number(body.scanned) || body.items.length, counts, filed, created };
    st.mail.seen = [...seen].slice(-1000);
    delete st.mailRun;
    const swept = sweepApply(st);   // submitted + 3 days without a receipt -> unverified
    await kick(st, process.env.URL || new URL(req.url).origin).catch(e => obsError("kick-failed", e && e.message || e, { payload: { from: "mail" } }));   // nudge the hunt chain if a worker got stuck overnight
    st.updatedAt = now;
    endRun("ok", { counts, filed, created, skipped, swept, trace: body.trace || null, promptVersion: body.promptVersion || null });
    const w = await saveDoc(doc, st, { what: `mail clerk run ${runId}` });
    if (w.conflict) return conflictResponse(w);
    return json({ ok: true, rev: w.rev, counts, filed, created, skipped });
  }

  // ---- page: "Check now" ----
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  tag({ action: "check-now" });
  const url = process.env.MAIL_FIRE_URL, token = process.env.MAIL_TOKEN;
  const doc = await readDoc();
  if (!url || !token) { emit({ type: "fire", outcome: "skipped", severity: "warn", entity_type: "run", entity_id: "mail", error_class: "routine-not-configured", error_cause: "MAIL_FIRE_URL / MAIL_TOKEN not set", error_handling: "needs-human", payload: { kind: "mail", reason: "routine not configured" } }); return json({ error: "Check now is not set up: the mail routine has no API trigger yet." }, 502); }
  const site = process.env.URL || new URL(req.url).origin;
  doc.state.mailRun = { status: "running", requestedAt: new Date().toISOString() };
  const t0 = Date.now();
  const r = await fetch(url, { method: "POST", headers: { "Authorization": `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "experimental-cc-routine-2026-04-01", "Content-Type": "application/json" }, body: JSON.stringify({ text: JSON.stringify({ kind: "mail", reason: "check now", board: `${site}/.netlify/functions/mail`, brief: `${site}/mail-brief.md` }) }) }).catch(e => ({ ok: false, status: 0, text: async () => String(e) }));
  const resp = (await r.text().catch(() => "")).slice(0, 500);
  emit({ type: "fire", outcome: r.ok ? "ok" : "fail", severity: r.ok ? "info" : "error", duration_ms: Date.now() - t0, entity_type: "run", entity_id: "mail", error_class: r.ok ? null : "fire-failed", error_cause: r.ok ? null : `mail trigger answered ${r.status}: ${resp.slice(0, 200)}`, error_handling: r.ok ? null : "handled", payload: { kind: "mail", reason: "check now", status: r.status, response: resp } });
  if (!r.ok) doc.state.mailRun = { status: "error", error: `fire failed (${r.status})`, requestedAt: doc.state.mailRun.requestedAt };
  doc.state.updatedAt = new Date().toISOString();
  const w = await saveDoc(doc, doc.state, { what: "mail check now" });
  if (w.conflict) return conflictResponse(w);
  return json({ ok: r.ok, ...w.next }, r.ok ? 200 : 502);
});
