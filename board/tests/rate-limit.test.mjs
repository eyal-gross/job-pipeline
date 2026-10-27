// Routine rate limit (27 Oct 2026): a 429 from the routine trigger must pause firing, not burn both attempts of every waiting card
// in the same second (11 cards failed that way at 12:49 UTC on 27 Oct). Pure unit test, fetch is stubbed:
//   node tests/rate-limit.test.mjs
process.env.ROUTINE_FIRE_URL = "https://example.invalid/fire"; process.env.ROUTINE_TOKEN = "test";
const { kick, retryAfterMs, reviveRateLimited } = await import("../netlify/functions/hunt.mjs");
let pass = 0, fail = 0;
const ok = (name, c, extra = "") => { if (c) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra); } };

ok("retry: 11m23s", retryAfterMs("Try again in 11m23s.") === (11 * 60 + 23 + 30) * 1000);
ok("retry: 45s", retryAfterMs("try again in 45s") === 75 * 1000);
ok("retry: no time named -> 15 min", retryAfterMs("rate limited") === 15 * 60 * 1000 + 30 * 1000);

const co = (id, status, extra = {}) => ({ id, name: id, links: "", tier: "practice", hunt: { status, foundAt: `2026-10-27T12:0${id.length}:00Z`, attempts: 0, ...extra } });
const role = (id, companyId, status, reason) => ({ id, companyId, title: "Product Manager", stage: "lead", tier: "practice", apply: { status, url: "https://x", ats: "comeet", ...(reason ? { reason } : {}) } });
const mk = () => ({ hunt: { concurrency: 1, caps: { prepared: 25 }, killSwitch: false }, companies: [co("a", "candidate"), co("bb", "candidate"), co("ccc", "candidate")], roles: [role("ra", "a", "candidate"), role("rb", "bb", "candidate"), role("rc", "ccc", "candidate")] });

let calls = 0;
globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ error: { message: "This routine's fire rate limit has been reached. Try again in 11m23s.", type: "rate_limit_error" } }), { status: 429 }); };
const st = mk();
const k = await kick(st, "https://board.test");
ok("429: one fire only, then stop", calls === 1, `calls ${calls}`);
ok("429: no card failed", st.companies.every(c => c.hunt.status === "candidate") && st.roles.every(r => r.apply.status === "candidate"));
ok("429: no attempt burned", st.companies.every(c => c.hunt.attempts === 0));
ok("429: backoff set ~11.9 min ahead", st.hunt.fireBackoffUntil && Math.abs(Date.parse(st.hunt.fireBackoffUntil) - Date.now() - 713000) < 5000, st.hunt.fireBackoffUntil);
ok("429: event says paused", k.events.some(e => /rate limit/.test(e)));

calls = 0;
await kick(st, "https://board.test");
ok("backoff: kick fires nothing while paused", calls === 0);

st.hunt.fireBackoffUntil = new Date(Date.now() - 1000).toISOString();
globalThis.fetch = async () => { calls++; return new Response("{}", { status: 200 }); };
const k2 = await kick(st, "https://board.test");
ok("backoff over: fires again", calls === 1 && k2.fired.length === 1 && !st.hunt.fireBackoffUntil, JSON.stringify(k2));

// cards the old code failed on a 429 come back
const old = mk();
old.companies[0].hunt = { ...old.companies[0].hunt, status: "failed", error: "fire failed (429)", attempts: 2 };
old.roles[0].apply = { ...old.roles[0].apply, status: "failed", reason: "fire failed (429)", failedAt: "2026-10-27T12:49:40Z" };
old.companies[1].hunt = { ...old.companies[1].hunt, status: "failed", error: "preparer did not return", attempts: 2 };
old.roles[1].apply = { ...old.roles[1].apply, status: "failed", reason: "preparer did not return" };
const n = reviveRateLimited(old);
ok("revive: only the 429 card", n === 1 && old.companies[0].hunt.status === "candidate" && old.roles[0].apply.status === "candidate" && old.companies[0].hunt.attempts === 0);
ok("revive: other failures untouched", old.companies[1].hunt.status === "failed" && old.roles[1].apply.status === "failed");
const graded = mk(); graded.companies[0].research = { fit: { grade: 5 } };
graded.companies[0].hunt = { ...graded.companies[0].hunt, status: "failed", error: "fire failed (429)" }; graded.roles[0].apply.status = "failed"; graded.roles[0].apply.reason = "fire failed (429)";
reviveRateLimited(graded);
ok("revive: a graded company goes back to the preparer line", graded.companies[0].hunt.status === "graded");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
