import { getStore } from "@netlify/blobs";
import { authed } from "./state.mjs";
import { withObs, emit, refused, tag } from "./lib/obs.mjs";

// Application records (25 Oct 2026): what each worker run actually put on a form - every question and the exact answer, the CV
// version, the outcome, the confirmation text. Kept in its own store, one blob per run, so the board state (rewritten on every save)
// stays small. Text only: screenshots stay on the PC (Eyal, 25 Oct). x-key only (the worker and the page both hold PIPELINE_KEY).
//  POST {roleId, runId, ...record}  -> { ok, key }        (the same roleId + runId again replaces it: backfill and retries are idempotent)
//  GET  ?roleId=<id>                -> { records: [...] }  newest first
export const RECORDS_STORE = "job-pipeline-records";
const MAX_BYTES = 20000, MAX_FIELDS = 60;
const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const clean = (s, n = 200) => String(s ?? "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, n);
const ID_RE = /^[a-z0-9]{4,40}$/i, RUN_RE = /^[a-z0-9-]{6,60}$/i;
const OUTCOMES = new Set(["submitted", "failed", "blocked", "unverified", "dry"]);

export function shapeRecord(b) {
  const fields = (Array.isArray(b.fields) ? b.fields : []).slice(0, MAX_FIELDS).map(f => ({
    label: clean(f.label, 160), final: /password/i.test(String(f.type || "")) ? "[redacted]" : clean(f.final, 200),
    required: f.required === true, source: clean(f.source, 30), page: Number.isInteger(f.page) ? f.page : undefined, type: clean(f.type, 20),
  })).filter(f => f.label || f.final);
  const cv = b.cv && typeof b.cv === "object" ? { version: clean(b.cv.version, 30), title: clean(b.cv.title, 160), sha256: clean(b.cv.sha256, 64), file: clean(b.cv.file, 200) } : null;
  return {
    roleId: clean(b.roleId, 40), runId: clean(b.runId, 60), at: clean(b.at, 40) || new Date().toISOString(),
    company: clean(b.company, 120), title: clean(b.title, 200), url: clean(b.url, 400), ats: clean(b.ats, 30),
    outcome: OUTCOMES.has(b.outcome) ? b.outcome : "submitted", reason: clean(b.reason, 300), clicked: b.clicked === true,
    cv, fields, confirmText: clean(b.confirmText, 400), screenshots: (Array.isArray(b.screenshots) ? b.screenshots : []).slice(0, 6).map(s => clean(s, 200)),
    backfilled: b.backfilled === true,
  };
}

export default withObs("netlify:record", async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  const store = getStore(RECORDS_STORE);
  if (req.method === "GET") {
    tag({ action: "list" });
    const roleId = new URL(req.url).searchParams.get("roleId") || "";
    if (!ID_RE.test(roleId)) return json({ error: "need roleId" }, 422);
    const keys = [];
    for await (const page of store.list({ prefix: `${roleId}/`, paginate: true })) for (const b of page.blobs) keys.push(b.key);
    const records = (await Promise.all(keys.map(k => store.get(k, { type: "json" }).catch(() => null)))).filter(Boolean);
    records.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return json({ records });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  let body; try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  tag({ action: "save" });
  const rec = shapeRecord(body);
  if (!ID_RE.test(rec.roleId) || !RUN_RE.test(rec.runId)) { refused("bad-record", "record without a valid roleId / runId", { payload: { roleId: rec.roleId, runId: rec.runId } }); return json({ error: "need roleId and runId" }, 422); }
  const size = JSON.stringify(rec).length;
  if (size > MAX_BYTES) { refused("record-too-big", `record of ${size} bytes`, { trace_id: rec.roleId, payload: { size } }); return json({ error: `record too big (${size} bytes, max ${MAX_BYTES})` }, 413); }
  const key = `${rec.roleId}/${rec.runId}`;
  await store.setJSON(key, rec);
  emit({ type: "record", trace_id: rec.roleId, entity_type: "role", entity_id: rec.roleId, outcome: "ok", payload: { key, outcome: rec.outcome, fields: rec.fields.length, cv: rec.cv && rec.cv.version, backfilled: rec.backfilled } });
  return json({ ok: true, key });
});
