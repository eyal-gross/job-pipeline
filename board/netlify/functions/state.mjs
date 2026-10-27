import { getStore } from "@netlify/blobs";
import { timingSafeEqual } from "node:crypto";
import { withObs, emit, refused, tag, diffState } from "./lib/obs.mjs";

// Whole-board state lives in one Blob. Every save carries the rev it was based on;
// a stale save gets a 409 with the current state so the client can adopt it.
// Since 20 Oct 2026 every server-side writer (agent callbacks, finder, mail clerk, worker claim) goes through the same check:
// saveDoc() re-reads the current rev right before writing and refuses (409 + a guard.refused event) when the board moved
// underneath the request, instead of silently overwriting the other write. Callers retry (agents: once; scheduled finder: next tick).
const STORE = "job-pipeline";
const KEY = "state";

const EMPTY = {
  updatedAt: "",
  channels: [
    { id: "ch-rel", name: "Relationships", kind: "people", snapshot: "" },
    { id: "ch-plat", name: "Platforms", kind: "platforms", snapshot: "" },
    { id: "ch-dir", name: "Direct", kind: "sources", snapshot: "" },
  ],
  people: [], companies: [], roles: [], tasks: [],
};

const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const ETAGS = new WeakMap();   // doc object -> the blob etag it was read with (compare-and-set on save)
export async function readDoc() {
  const store = getStore(STORE);
  const got = await store.getWithMetadata(KEY, { type: "json", consistency: "strong" });
  const doc = got && got.data && got.data.state ? got.data : { rev: 0, state: EMPTY };
  ETAGS.set(doc, got && got.etag ? got.etag : null);
  return doc;
}
// raw write, no check (kept for seeding / tools). Everything in the functions uses saveDoc().
export async function writeDoc(doc) {
  await getStore(STORE).setJSON(KEY, doc);
}
// Commit `st` as rev doc.rev + 1, only if the blob still carries the etag `doc` was read with (conditional write, @netlify/blobs 11).
// Returns { ok, rev, next } or { conflict: true, rev, doc }. A conflict means another writer landed in between: nothing is overwritten,
// a guard.refused event records it, the caller answers 409 and the writer retries (agents: once by their brief; finder: next tick).
export async function saveDoc(doc, st, { what = "" } = {}) {
  const store = getStore(STORE);
  const etag = ETAGS.get(doc);
  // Each save carries a stamp and the doc keeps the chain of recent stamps. 25 Oct: the store's onlyIfMatch let two simultaneous
  // writers both "win" the same rev (10 of 15 live probes) and the later one silently erased the earlier. So after writing, re-read:
  // our stamp must be in the chain (a later writer that built on us keeps it); if it is gone we were overwritten -> answer conflict.
  const wid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const next = { rev: doc.rev + 1, state: st, writes: [...(Array.isArray(doc.writes) ? doc.writes : []).slice(-40), wid] };
  let conflict = false, lost = false;
  if (etag) {   // production: compare-and-set on the etag the doc was read with
    const res = await store.setJSON(KEY, next, { onlyIfMatch: etag });
    conflict = !!(res && res.modified === false);
  } else {   // no etag (netlify dev's local store, or a brand-new board): re-read the rev right before writing (a small window remains)
    const cur = await store.get(KEY, { type: "json", consistency: "strong" });
    const curRev = cur && cur.state ? cur.rev : 0;
    if (curRev !== doc.rev) conflict = true; else await store.setJSON(KEY, next);
  }
  if (!conflict) {
    await new Promise(r => setTimeout(r, 300));   // let a racing write land before we look
    const cur = await store.get(KEY, { type: "json", consistency: "strong" });
    if (!(cur && Array.isArray(cur.writes) && cur.writes.includes(wid))) { conflict = true; lost = true; }
  }
  if (conflict) {
    const cur = await store.get(KEY, { type: "json", consistency: "strong" });
    const curRev = cur && cur.state ? cur.rev : 0;
    refused(lost ? "lost-write" : "rev-conflict", `${lost ? "this save was overwritten by a simultaneous one" : `board moved from rev ${doc.rev} to ${curRev} while this request ran`}${what ? ` (${what})` : ""}`, { entity_type: "board", entity_id: "state", payload: { baseRev: doc.rev, currentRev: curRev, what, cas: !!etag, lost } });
    return { conflict: true, rev: curRev, doc: cur };
  }
  return { ok: true, rev: next.rev, next };
}
export const conflictResponse = w => json({ error: `the board changed while this ran (rev ${w.rev}) - retry`, conflict: true, rev: w.rev }, 409);

// Fails closed (security audit 27 Oct 2026): a missing PIPELINE_KEY locks the board, except under netlify dev.
// Timing-safe compare so the key cannot be guessed byte by byte from response times.
export function authed(req) {
  const want = process.env.PIPELINE_KEY || "";
  if (!want) return process.env.NETLIFY_DEV === "true";
  const a = Buffer.from(req.headers.get("x-key") || ""), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default withObs("netlify:state", async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (!authed(req)) return json({ error: "unauthorized" }, 401);

  if (req.method === "GET") {
    const doc = await readDoc();
    const known = Number(new URL(req.url).searchParams.get("rev") || -1);
    const features = { mailCheck: !!(process.env.MAIL_FIRE_URL && process.env.MAIL_TOKEN), huntCheck: true, huntWorker: !!(process.env.ROUTINE_FIRE_URL && process.env.ROUTINE_TOKEN), obs: true, cas: !!ETAGS.get(doc) };   // cas: the store returns etags, so saves are compare-and-set
    if (known === doc.rev) return json({ rev: doc.rev, unchanged: true });
    return json({ ...doc, features });
  }

  if (req.method === "POST") {
    tag({ action: "save" });
    let body;
    try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    if (!body || !body.state || !Array.isArray(body.state.channels)) return json({ error: "invalid payload" }, 422);
    const doc = await readDoc();
    const by = body.by === "claude-code" ? "claude-code" : "page";
    const actor = by === "claude-code" ? "claude-code" : "page:human";
    if (Number(body.baseRev) !== doc.rev) {
      refused("stale-save", `client saved on rev ${body.baseRev}, board is at rev ${doc.rev}`, { entity_type: "board", entity_id: "state", payload: { baseRev: Number(body.baseRev), currentRev: doc.rev, by } });
      return json({ conflict: true, ...doc }, 409);
    }
    const d = diffState(doc.state, body.state, { by });
    const w = await saveDoc(doc, body.state, { what: `page save by ${by}` });
    if (w.conflict) return json({ conflict: true, ...w.doc }, 409);
    const bytes = JSON.stringify(body.state).length;
    emit({ type: "save", actor, entity_type: "board", entity_id: "state", outcome: "ok", payload: { rev: w.rev, baseRev: doc.rev, bytes, by, empty: d.empty, diff: d.summary } });
    for (const t of d.transitions) emit({ type: "transition", actor, ...t });
    for (const s of d.settings) emit({ type: "settings", actor, entity_type: "board", entity_id: "hunt", payload: { ...s, by } });
    return json({ rev: w.rev });
  }

  return json({ error: "method not allowed" }, 405);
});
