// Supply widening item 1 (Eyal, 26 Oct 2026): the finder drops known roles BEFORE the offered cap, so every sorter slot is a role the
// board can still take. Pure unit test, no localhost needed:
//   node tests/prefilter.test.mjs
import { onBoard, knownCtx, knownReason } from "../netlify/functions/hunt.mjs";
import { pruneKnown } from "../netlify/functions/hunt-find.mjs";
let pass = 0, fail = 0;
const ok = (name, c, extra = "") => { if (c) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra); } };

const co = (id, name, links, extra = {}) => ({ id, name, links, tier: "practice", research: { fit: { grade: 5 } }, ...extra });
const role = (id, companyId, title, status, stage = "applied") => ({ id, companyId, title, stage, apply: { status } });
const st = {
  hunt: { applied: [{ name: "Handsent", domain: "handsent.com", at: "2026-10-01" }, { name: "Ledgerco", title: "Product Manager", at: "2026-10-02" }], denyExtra: "Dreamco" },
  companies: [
    co("a", "Acme", "https://acme.io"), co("b", "Beta Ltd", "https://beta.com"), co("c", "Gamma", "https://gamma.co"),
    co("r", "Realco", "https://realco.com", { tier: "real" }), co("g", "Gradeco", "https://gradeco.com", { research: { fit: { grade: 8 } } }),
    co("u", "Busyco", "https://busyco.com", { hunt: { status: "grading" } }),
  ],
  roles: [
    role("a1", "a", "Product Manager", "confirmed"),
    role("b1", "b", "Product Manager", "submitted"), role("b2", "b", "Technical Product Manager", "unverified"),
    role("c1", "c", "AI Engineer", "confirmed", "closed"),
  ],
};
const row = (name, title, extra = {}) => ({ name, title, url: `https://x/${name}/${title}`, ats: "greenhouse", source: "greenhouse", location: "Tel Aviv, Israel", domain: "", ...extra });

// same answers as onBoard without a context (the company rule test covers onBoard itself)
const ctx = knownCtx(st);
const probes = [row("Acme", "Senior Product Manager"), row("Acme", "AI Engineer"), row("Acme", "Product Owner"), row("Beta", "Product Lead"), row("Gamma", "Solutions Engineer"),
  row("Realco", "Product Manager"), row("Gradeco", "AI Engineer"), row("Busyco", "Product Manager"), row("Handsent", "AI Engineer"), row("Ledgerco", "Product Manager"),
  row("Ledgerco", "AI Engineer"), row("Dreamco", "Product Manager"), row("Newco", "AI Engineer"), row("Other name", "Product Owner", { domain: "beta.com" })];
for (const p of probes) ok(`ctx answers like onBoard: ${p.name} / ${p.title}`, onBoard(st, p, ctx) === onBoard(st, p), `${onBoard(st, p, ctx)} vs ${onBoard(st, p)}`);
const want = { "Acme|Senior Product Manager": "sameRole", "Acme|AI Engineer": "roleFamily", "Acme|Product Owner": "", "Beta|Product Lead": "companyCap", "Gamma|Solutions Engineer": "",
  "Realco|Product Manager": "blocked", "Gradeco|AI Engineer": "blocked", "Busyco|Product Manager": "blocked", "Handsent|AI Engineer": "blocked", "Ledgerco|Product Manager": "sameRole",
  "Ledgerco|AI Engineer": "", "Dreamco|Product Manager": "blocked", "Newco|AI Engineer": "", "Other name|Product Owner": "companyCap" };
for (const p of probes) { const w = want[`${p.name}|${p.title}`]; ok(`reason ${p.name} / ${p.title} -> ${w || "fresh"}`, knownReason(st, ctx, p) === w, knownReason(st, ctx, p)); }

// a raw list of 120 rows, 70 of them known: pruneKnown keeps the 50 fresh ones, in their order, and counts the reasons
const raw = [];
for (let i = 0; i < 70; i++) raw.push([row("Acme", "Product Manager"), row("Realco", `AI Engineer ${i}`), row("Beta", `Product Owner ${i}`), row("Acme", `AI Engineer ${i}`), row("Ledgerco", "Senior Product Manager")][i % 5]);
for (let i = 0; i < 50; i++) raw.splice(i * 2 + 1, 0, row(`Fresh ${i}`, "Product Manager"));
const f = { runId: "t", raw: raw.slice(), funnel: { found: raw.length, dropped: {} } };
const counts = pruneKnown(st, f);
ok("70 known rows dropped", Object.values(counts).reduce((a, b) => a + b, 0) === 70, JSON.stringify(counts));
ok("50 fresh rows kept, order kept", f.raw.length === 50 && f.raw.every((c, i) => c.name === `Fresh ${i}`), f.raw.length);
ok("reasons counted", counts.sameRole === 28 && counts.blocked === 14 && counts.companyCap === 14 && counts.roleFamily === 14, JSON.stringify(counts));
ok("funnel carries known:<reason>", f.funnel.dropped["known:sameRole"] === 28 && f.funnel.dropped["known:blocked"] === 14, JSON.stringify(f.funnel.dropped));
ok("droppedKnown on the run", f.droppedKnown.companyCap === 14);
pruneKnown(st, f);
ok("second pass is a no-op", f.raw.length === 50 && f.droppedKnown.sameRole === 28);

// speed: a night's raw list (2000 rows) against a board of 400 companies
const big = { hunt: { applied: [] }, companies: [], roles: [] };
for (let i = 0; i < 400; i++) { big.companies.push(co(`c${i}`, `Company ${i}`, `https://company${i}.com`)); big.roles.push(role(`r${i}`, `c${i}`, "Product Manager", "confirmed")); }
const fb = { runId: "t", raw: Array.from({ length: 2000 }, (_, i) => row(`Company ${i % 800}`, i % 3 ? "Product Manager" : "AI Engineer")), funnel: { found: 2000, dropped: {} } };
const t0 = Date.now(); pruneKnown(big, fb); const ms = Date.now() - t0;
ok(`2000 rows x 400 companies under 300 ms (${ms} ms)`, ms < 300);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
