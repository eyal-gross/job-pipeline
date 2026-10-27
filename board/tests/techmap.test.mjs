// Supply widening item 2 (Eyal, 26 Oct 2026): techmap's daily CSVs as a finder source. Pure unit test on a fixture of 50 real rows (company names replaced with fictional ones)
// saved 26 Oct 2026 (30 product + 20 software), no network:
//   node tests/techmap.test.mjs
import fs from "node:fs";
import { parseCsv, stripUtm, techmapRows, externalAts, resolvePlan, TECHMAP_CATS } from "../netlify/functions/hunt-find.mjs";
import { TITLE_INCLUDE, TITLE_EXCLUDE, ATS_AUTO, ATS_ALL, domainsOf } from "../netlify/functions/hunt.mjs";
let pass = 0, fail = 0;
const ok = (name, c, extra = "") => { if (c) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra); } };

// the parser: BOM, quoted commas, escaped quotes, CRLF, Hebrew, a trailing line without a newline
const t = parseCsv('﻿"company","title","city","url"\r\n"Acme, Inc","Product Manager ""AI""","תל אביב-יפו","https://x"\r\n"B","PM","חיפה","https://y"');
ok("BOM stripped from the first header", Object.keys(t[0])[0] === "company", JSON.stringify(Object.keys(t[0])));
ok("quoted comma kept in the cell", t[0].company === "Acme, Inc", t[0].company);
ok("escaped quotes", t[0].title === 'Product Manager "AI"', t[0].title);
ok("Hebrew city", t[0].city === "תל אביב-יפו");
ok("last line without a newline", t.length === 2 && t[1].url === "https://y");
ok("empty text -> no rows", parseCsv("").length === 0);

ok("utm params stripped", stripUtm("https://www.comeet.com/jobs/a/1/pm/2?utm_source=techmap&utm_medium=csv") === "https://www.comeet.com/jobs/a/1/pm/2");
ok("other params kept", stripUtm("https://jobs.lever.co/a/1?lever-source=x&utm_term=apply") === "https://jobs.lever.co/a/1?lever-source=x");
ok("bad url passes through", stripUtm("not a url") === "not a url");
ok("comeet / lever / linkedin mapped", externalAts("https://www.comeet.com/jobs/x") === "comeet" && externalAts("https://jobs.lever.co/x") === "lever" && externalAts("https://il.linkedin.com/jobs/view/123") === "linkedin");
ok("workable / bamboohr mapped (recipes since 26 Oct 2026)", externalAts("https://apply.workable.com/zorg/j/FDF3175B81/apply/") === "workable" && externalAts("https://rekall.bamboohr.com/careers/41") === "bamboohr");
ok("workable / bamboohr cards are queued for the worker", ATS_AUTO.has("workable") && ATS_AUTO.has("bamboohr") && ATS_ALL.has("workable") && ATS_ALL.has("bamboohr"));
ok("an ATS host is never a company domain", domainsOf({ links: "https://rekall.bamboohr.com/careers https://apply.workable.com/zorg https://rekall.io" }).join() === "rekall.io", domainsOf({ links: "https://rekall.bamboohr.com/careers https://apply.workable.com/zorg https://rekall.io" }).join());
ok("six categories read", TECHMAP_CATS.length === 6 && TECHMAP_CATS.includes("product") && TECHMAP_CATS.includes("software"));

// the real fixture through offer(): every kept row is a title match, in Israel, with a clean url and the right ats
const rows = parseCsv(fs.readFileSync(new URL("./fixtures/techmap-sample.csv", import.meta.url), "utf8"));
ok("fixture has 50 rows with the techmap columns", rows.length === 50 && ["company", "category", "size", "title", "level", "city", "url", "updated"].every(k => k in rows[0]), rows.length);
const f = { runId: "t", raw: [], funnel: { found: 0, dropped: {} }, errors: [], log: [] };
const seen = techmapRows(f, "product", rows);
ok("every row seen", seen === 50 && f.funnel.found === 50, seen);
ok("kept + dropped = seen", f.raw.length + Object.values(f.funnel.dropped).reduce((a, b) => a + b, 0) === 50, JSON.stringify(f.funnel.dropped));
ok("kept rows pass the title rules", f.raw.every(c => TITLE_INCLUDE.test(c.title) && !TITLE_EXCLUDE.test(c.title)));
ok("kept rows are in Israel", f.raw.every(c => /, Israel$/.test(c.location)));
ok("no utm left", f.raw.every(c => !/utm_/.test(c.url)));
ok("source techmap", f.raw.every(c => c.source === "techmap"));
ok("ats from the url", f.raw.every(c => c.ats === externalAts(c.url)));
ok("Acme Senior PM kept as comeet", f.raw.some(c => c.name === "Acme" && c.title === "Senior Product Manager" && c.ats === "comeet"));
ok("at least 15 kept from the 30 product rows", f.raw.length >= 15, f.raw.length);

// resolve skips a company whose own board was read tonight (its ATS row wins the dedupe anyway)
const f2 = { raw: [
  { name: "Acme", title: "Product Manager", ats: "linkedin", url: "https://il.linkedin.com/jobs/view/1" },
  { name: "Acme", title: "Senior Product Manager", ats: "comeet", url: "https://www.comeet.com/jobs/Acme/1" },
  { name: "Newco", title: "Product Manager", ats: "linkedin", url: "https://il.linkedin.com/jobs/view/2" },
] };
const plan = resolvePlan(f2, { resolveMiss: {} });
ok("own-board company skipped, the other one planned", plan.batch.length === 1 && plan.batch[0].rows[0].name === "Newco", JSON.stringify(plan.batch.map(b => b.key)));
ok("skipped row marked resolved", f2.raw[0].resolved === true);
ok("resolve takes 20 companies a tick", resolvePlan({ raw: Array.from({ length: 30 }, (_, i) => ({ name: `Company${i}x`, title: "PM", ats: "linkedin", url: "u" })) }, { resolveMiss: {} }).batch.length === 20);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
