import { getStore } from "@netlify/blobs";
import { authed } from "./state.mjs";
import { withObs, emit, EVENTS_STORE, RING_DAYS, tag } from "./lib/obs.mjs";

// Event chunks for the PC collector (MONITORING-PLAN.md §3). x-key only.
//  GET  ?list=1[&since=YYYY-MM-DD]  -> { keys: [...], count, pruned }   (also prunes chunks older than RING_DAYS: the PC is the archive)
//  GET  ?key=events/<day>/<id>.jsonl -> the chunk, text/plain
//  DELETE ?key=...                   -> remove one chunk after ingest
//  POST {action:"delete", keys:[]}   -> remove up to 200 chunks after ingest
//  POST {action:"emit", events:[]}   -> Claude Code / the page push their own events into the same stream (actor must start with claude-code or page:)
const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const KEY_RE = /^events\/\d{4}-\d{2}-\d{2}\/[a-z0-9-]+\.jsonl$/;
const dayOf = key => key.slice(7, 17);

async function listKeys(store, since) {
  const keys = [];
  for await (const page of store.list({ prefix: "events/", paginate: true })) for (const b of page.blobs) keys.push(b.key);
  keys.sort();
  return since ? keys.filter(k => dayOf(k) >= since) : keys;
}

export default withObs("netlify:obs", async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (!authed(req)) return json({ error: "unauthorized" }, 401);
  const store = getStore(EVENTS_STORE);
  const url = new URL(req.url);

  if (req.method === "GET") {
    const key = url.searchParams.get("key");
    if (key) {
      tag({ action: "chunk" });
      if (!KEY_RE.test(key)) return json({ error: "bad key" }, 422);
      const text = await store.get(key, { type: "text" });
      if (text === null) return json({ error: "not found" }, 404);
      return new Response(text, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    tag({ action: "list" });
    const keys = await listKeys(store, url.searchParams.get("since") || "");
    const cutoff = new Date(Date.now() - RING_DAYS * 86400000).toISOString().slice(0, 10);
    const old = keys.filter(k => dayOf(k) < cutoff);
    for (const k of old.slice(0, 50)) { try { await store.delete(k); } catch { /* next time */ } }
    if (old.length) emit({ type: "log", entity_type: "board", entity_id: "events", payload: { message: `pruned ${Math.min(old.length, 50)} chunks older than ${RING_DAYS} days`, cutoff } });
    return json({ keys: keys.filter(k => !old.includes(k)), count: keys.length - old.length, pruned: Math.min(old.length, 50), ringDays: RING_DAYS });
  }

  if (req.method === "DELETE") {
    tag({ action: "delete" });
    const key = url.searchParams.get("key") || "";
    if (!KEY_RE.test(key)) return json({ error: "bad key" }, 422);
    await store.delete(key);
    return json({ ok: true, deleted: 1 });
  }

  if (req.method === "POST") {
    let body; try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    if (body.action === "delete") {
      tag({ action: "delete" });
      const keys = (Array.isArray(body.keys) ? body.keys : []).filter(k => typeof k === "string" && KEY_RE.test(k)).slice(0, 200);
      let n = 0; for (const k of keys) { try { await store.delete(k); n++; } catch { /* keep going */ } }
      return json({ ok: true, deleted: n });
    }
    if (body.action === "emit") {
      tag({ action: "emit" });
      const evs = (Array.isArray(body.events) ? body.events : []).slice(0, 100);
      let n = 0;
      for (const e of evs) {
        if (!e || typeof e !== "object" || !e.type) continue;
        const actor = /^(claude-code|page:)/.test(String(e.actor || "")) ? String(e.actor).slice(0, 40) : "page:human";
        emit({ ...e, actor, type: String(e.type).slice(0, 40), payload: e.payload && typeof e.payload === "object" ? e.payload : {}, seq: e.seq ? `emit:${String(e.seq).slice(0, 80)}` : undefined }); n++;
      }
      return json({ ok: true, accepted: n });
    }
    return json({ error: "unknown action" }, 422);
  }
  return json({ error: "method not allowed" }, 405);
});
