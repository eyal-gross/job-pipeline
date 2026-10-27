// Supply widening item 4 (Eyal, 26 Oct 2026): wider titles in, Eyal's real-tier targets and non-fits still out. Pure unit test:
//   node tests/titles.test.mjs
import { TITLE_INCLUDE, TITLE_EXCLUDE, TITLE_CORE, roleFamily } from "../netlify/functions/hunt.mjs";
import { QUERIES } from "../netlify/functions/hunt-find.mjs";
let pass = 0, fail = 0;
const ok = (name, c, extra = "") => { if (c) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, extra); } };
const passes = t => TITLE_INCLUDE.test(t) && !TITLE_EXCLUDE.test(t);

// real titles from the 26 Oct day run's "title" drops that should now pass
const nowIn = ["Senior Software Engineer", "Software Engineer - Web Crawling", "Senior Backend Engineer - Python", "Backend Developer", "Full Stack Developer",
  "Senior Full-Stack Engineer", "Senior Fullstack Engineer", "Customer Success Manager", "Customer Success Engineer", "Technical Account Manager",
  "Automation Engineer", "Growth Product Manager", "Growth Manager", "מהנדס/ת תוכנה", "מפתח/ת Full Stack", "מפתח.ת בקאנד"];
for (const t of nowIn) ok(`in: ${t}`, passes(t), `include ${TITLE_INCLUDE.test(t)} exclude ${TITLE_EXCLUDE.test(t)}`);

// still out: real-tier targets, seniority, QA, chip stacks; and wide words that are not the role
const stillOut = ["Forward Deployed Engineer", "Deployment Strategist", "Founding Engineer", "Founding Software Engineer", "AI Product Engineer", "Product Engineer",
  "Staff Software Engineer", "Principal Backend Engineer", "Engineering Lead, Platform", "QA Automation Engineer", "Test Automation Engineer", "Automation Test Engineer",
  "Embedded Software Engineer", "Firmware Engineer", "C++ Software Engineer", "Verification Engineer", "Director of Customer Success", "VP Growth",
  "Growth Marketing Manager", "Account Executive", "Product Management Team Leader – Marketplace", "Engineering Team Leader", "בודק/ת תוכנה", "ראש צוות פיתוח", "Software Engineering Intern"];
for (const t of stillOut) ok(`out: ${t}`, !passes(t), `include ${TITLE_INCLUDE.test(t)} exclude ${TITLE_EXCLUDE.test(t)}`);

// nothing the old rule took is lost (sample of core titles sent by the loop)
const core = ["Product Manager", "Senior Product Manager – Agentic AI", "Technical Product Manager", "AI Engineer", "Senior GenAI Engineer", "Solutions Engineer",
  "Solution Architect", "Implementation Engineer", "Product Owner", "מנהל/ת מוצר דיגיטל", "מנהל.ת מוצר", "מנהל /ת מוצר", "AI Research Engineer, Security", "Hardware Product Manager"];
for (const t of core) ok(`core kept: ${t}`, passes(t) && TITLE_CORE.test(t), `include ${TITLE_INCLUDE.test(t)} exclude ${TITLE_EXCLUDE.test(t)}`);
ok("wide titles are not core (ranked after core inside a tier)", !TITLE_CORE.test("Senior Backend Engineer") && !TITLE_CORE.test("Customer Success Manager"));

// families for the company rule
const fam = { "Customer Success Manager": "solutions", "Technical Account Manager": "solutions", "Customer Success Engineer": "solutions", "Growth Product Manager": "product",
  "Growth Manager": "product", "Senior Backend Engineer": "engineering", "Full Stack Developer": "engineering", "Automation Engineer": "engineering", "Growth Engineer": "engineering" };
for (const [t, f] of Object.entries(fam)) ok(`family ${t} -> ${f}`, roleFamily(t) === f, roleFamily(t));

ok("finder searches the wide titles too", QUERIES.length === 16 && QUERIES.includes("backend engineer") && QUERIES.includes("technical account manager"), QUERIES.length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
