// Usage: node probe.mjs <url>
// Opens a job posting or apply URL, lists frames, counts inputs per frame (shadow-piercing), dumps labels.
// Never submits anything.
import { attach, COUNT_INPUTS_JS } from './lib/browser.mjs';

const url = process.argv[2];
if (!url) { console.error('usage: node probe.mjs <url>'); process.exit(2); }

const { ctx, close, mode } = await attach();
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);
// Comeet posting page: the apply form iframe is injected only after the Apply button.
const applyBtn = page.locator('#showApplyForm');
if (await applyBtn.count()) {
  await applyBtn.first().click();
  await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some(f => (f.name||'').startsWith('comeet-applyform')), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);
}
console.log(`mode=${mode} title="${await page.title()}" url=${page.url()}`);
for (const f of page.frames()) {
  let inputs = [];
  try { inputs = await f.evaluate(COUNT_INPUTS_JS); } catch (e) { console.log(`frame ${f.url()} -> evaluate failed: ${e.message}`); continue; }
  console.log(`\nframe name="${f.name()}" url=${f.url().slice(0, 120)} inputs=${inputs.length}`);
  for (const i of inputs) console.log(`  ${i.tag}${i.type ? ':' + i.type : ''} ${i.required ? '*' : ' '} name=${i.name} id=${i.id} label="${i.label}" ${i.text ? 'text="' + i.text + '"' : ''}`);
}
await page.close();
await close();
