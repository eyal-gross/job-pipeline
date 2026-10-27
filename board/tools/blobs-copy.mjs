// Board data move (25 Oct 2026): the first Netlify account ran out of credits, the board moves to a second Netlify account.
// Every Netlify Blobs store of a site, every key, with its metadata, to a local folder (backup) and from it to another site (restore),
// then a byte-for-byte check against the manifest. Tokens are read from the env files named on the command line and never printed.
//   node tools/blobs-copy.mjs backup  --site <siteId> --env <file with NETLIFY_AUTH_TOKEN> --dir <folder>
//   node tools/blobs-copy.mjs restore --site <siteId> --env <file> --dir <folder>      (writes every blob in the folder to that site)
//   node tools/blobs-copy.mjs verify  --site <siteId> --env <file> --dir <folder>      (reads the site back, compares with the manifest)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getStore, listStores } from "@netlify/blobs";

const [cmd, ...rest] = process.argv.slice(2);
const arg = n => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : ""; };
const siteID = arg("--site"), envFile = arg("--env"), dir = arg("--dir");
if (!["backup", "restore", "verify"].includes(cmd) || !siteID || !envFile || !dir) { console.error("usage: backup|restore|verify --site <id> --env <file> --dir <folder>"); process.exit(2); }
const token = (fs.readFileSync(envFile, "utf8").match(/^NETLIFY_AUTH_TOKEN=(.*)$/m) || [])[1]?.trim();
if (!token) { console.error(`no NETLIFY_AUTH_TOKEN in ${envFile}`); process.exit(2); }
const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");
const enc = k => encodeURIComponent(k);   // keys carry "/" (records: <roleId>/<runId>); one file per key
const store = name => getStore({ name, siteID, token, consistency: "strong" });
const MANIFEST = path.join(dir, "manifest.json");

async function keysOf(name) { const keys = []; for await (const page of store(name).list({ paginate: true })) for (const b of page.blobs) keys.push(b.key); return keys; }

if (cmd === "backup") {
  fs.mkdirSync(dir, { recursive: true });
  const { stores } = await listStores({ siteID, token });
  const manifest = { at: new Date().toISOString(), siteID, stores: {} };
  for (const name of stores) {
    const keys = await keysOf(name); const sd = path.join(dir, "stores", enc(name)); fs.mkdirSync(sd, { recursive: true });
    manifest.stores[name] = {};
    for (const key of keys) {
      const r = await store(name).getWithMetadata(key, { type: "arrayBuffer" }); if (!r) continue;
      const buf = Buffer.from(r.data);
      fs.writeFileSync(path.join(sd, enc(key)), buf);
      manifest.stores[name][key] = { sha256: sha(buf), bytes: buf.length, metadata: r.metadata || {} };
    }
    console.log(`${name}: ${Object.keys(manifest.stores[name]).length} blobs`);
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  console.log(`backup written: ${Object.keys(manifest.stores).length} stores`);
}

if (cmd === "restore") {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  for (const [name, blobs] of Object.entries(manifest.stores)) {
    let n = 0;
    for (const [key, info] of Object.entries(blobs)) {
      const buf = fs.readFileSync(path.join(dir, "stores", enc(name), enc(key)));
      if (sha(buf) !== info.sha256) throw new Error(`backup file changed on disk: ${name}/${key}`);
      await store(name).set(key, buf, { metadata: info.metadata || {} }); n++;
    }
    console.log(`${name}: ${n} blobs written`);
  }
}

if (cmd === "verify") {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  let bad = 0, total = 0;
  for (const [name, blobs] of Object.entries(manifest.stores)) {
    const live = new Set(await keysOf(name));
    for (const [key, info] of Object.entries(blobs)) {
      total++;
      const r = await store(name).get(key, { type: "arrayBuffer" });
      if (!r) { bad++; console.log(`MISSING ${name}/${key}`); continue; }
      if (sha(Buffer.from(r)) !== info.sha256) { bad++; console.log(`DIFFERENT ${name}/${key}`); }
      live.delete(key);
    }
    if (live.size) console.log(`${name}: ${live.size} extra keys on the site (written after the backup)`);
  }
  console.log(bad ? `VERIFY FAIL: ${bad} of ${total} blobs missing or different` : `VERIFY PASS: ${total} blobs identical`);
  process.exit(bad ? 1 : 0);
}
