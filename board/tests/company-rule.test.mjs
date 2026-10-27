// Company rule (Eyal, 25 Oct 2026): at most 2 open applications per company, one role family only. Pure unit test, no localhost needed:
//   node tests/company-rule.test.mjs
import { roleFamily, onBoard, openRolesAt } from "../netlify/functions/hunt.mjs";
let pass = 0, fail = 0;
const ok = (name, c, extra = "") => { if (c) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra); } };

// families on real titles from the board
const fam = {
  "Senior Product Manager": "product", "*Technical Product Manager": "product", "Technical Product Associate": "product", "Product Owner": "product",
  "מנהל/ת מוצר דיגיטל בעולמות המסחר": "product", "Senior GenAI Engineer": "engineering", "GTM AI Engineer": "engineering",
  "AI Full-Stack Engineer": "engineering", "Fullstack AI Developer (Mid-Level)": "engineering", "AI Research Engineer, Security": "engineering",
  "Senior Solutions Engineer - Prompt": "solutions", "Solution Architect": "solutions", "Delivery Solution Engineer": "solutions",
  "AI assurance & soc 2 Consultant": "solutions", "Solution Engineer": "solutions", "Implementation Engineer": "solutions",
};
for (const [t, f] of Object.entries(fam)) ok(`family: ${t} -> ${f}`, roleFamily(t) === f, roleFamily(t));

const co = (id, name, links) => ({ id, name, links, tier: "practice", research: { fit: { grade: 5 } } });
const role = (id, companyId, title, status, stage = "applied") => ({ id, companyId, title, stage, apply: { status } });
const st = {
  hunt: {}, companies: [co("a", "Acme", "https://acme.io"), co("b", "Beta Ltd", "https://beta.com"), co("c", "Gamma", "https://gamma.co"), co("d", "Delta", "https://delta.co")],
  roles: [
    role("a1", "a", "Product Manager", "confirmed"),
    role("b1", "b", "Product Manager", "submitted"), role("b2", "b", "Technical Product Manager", "unverified"),
    role("c1", "c", "AI Engineer", "confirmed", "closed"), role("c2", "c", "Product Manager", "skipped"),
    role("d1", "d", "AI Engineer", "approved"),
  ],
};
ok("same family, under the cap -> allowed", onBoard(st, { name: "Acme", domain: "acme.io", title: "Product Owner" }) === "");
ok("other family next to an open app -> family", onBoard(st, { name: "Acme", domain: "acme.io", title: "AI Engineer" }) === "family");
ok("two open apps -> companyCap", onBoard(st, { name: "Beta", domain: "beta.com", title: "Product Owner" }) === "companyCap");
ok("matched by domain under another name -> companyCap", onBoard(st, { name: "Beta Technologies", domain: "https://beta.com/careers", title: "Product Lead" }) === "companyCap");
ok("same role still sameRole first", onBoard(st, { name: "Acme", domain: "acme.io", title: "Senior Product Manager" }) === "role");
ok("closed (rejected) and forfeited apps do not count", openRolesAt(st, { name: "Gamma" }).length === 0 && onBoard(st, { name: "Gamma", title: "Solutions Engineer" }) === "");
ok("queued (approved) app counts as open", onBoard(st, { name: "Delta", title: "Product Manager" }) === "family");
ok("new company -> allowed", onBoard(st, { name: "Newco", domain: "newco.ai", title: "Product Manager" }) === "");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
