// SmartRecruiters: https://jobs.smartrecruiters.com/<Company>/<postingId>-<slug>. With ?oga=true the posting URL lands straight on the
// one-page apply form (oneclick-ui/company/<Company>/publication/<uuid>). Mapped 21 Oct 2026 on a live product manager posting:
// the whole form lives in open shadow roots (Playwright CSS pierces them). Fields: #first-name-input #last-name-input #email-input
// #confirm-email-input, input[type=tel][aria-label="Phone number"] next to a +972 country picker, City (optional, autocomplete: left alone),
// #linkedin-input (optional), Resume dropzone input[type=file] (#spl-dropzone-file-input-1; #spl-dropzone-file-input-2 is the "Easy Apply"
// autocomplete box at the top, NOT the resume), textarea #hiring-manager-message-input (optional, left empty: no cover letter, ever),
// a required privacy checkbox (.c-spl-checkbox__input), a "Submit" button. Companies may add a screening-questions section: answerScreeners
// handles the standard inputs, anything unknown stops the card as "needs Eyal". Behind Fabrikam (careers.fabrikam.example) and Northwind
// (careers.northwind.example): both own-looking careers sites hand off to SmartRecruiters.
import { fillFirst, attachFile, answerScreeners, requireFilled, Blocked, FormChanged, captchaChallengeVisible, loginWall, sleep, pageDone } from '../lib/forms.mjs';
import path from 'node:path';

export const name = 'smartrecruiters';
export const match = url => /jobs\.smartrecruiters\.com\//i.test(url);
const FIRST = 'input#first-name-input';   // the id sits on a wrapper element too: the tag keeps the locator on the real input

export async function open(page, card) {
  let url = card.apply.url;
  if (!/oneclick-ui/.test(url) && !/[?&]oga=true/.test(url)) url += (url.includes('?') ? '&' : '?') + 'oga=true';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  const txt = await page.locator('body').innerText().catch(() => '');
  if (/job is no longer available|position has been filled|no longer accepting|posting (is )?closed|not found/i.test(txt)) throw new FormChanged(`SmartRecruiters says the posting is closed: ${(txt.match(/no longer[^.]{0,60}|closed[^.]{0,40}/i) || [''])[0]}`);
  if (await loginWall(page)) throw new Blocked('login', 'SmartRecruiters asks for a sign-in');
  const first = page.locator(FIRST).first();
  await first.waitFor({ state: 'visible', timeout: 25000 }).catch(() => {});
  if (!(await first.count())) {
    // posting page instead of the form: press its apply button once
    const btn = page.locator('a:has-text("I\'m interested"), button:has-text("I\'m interested"), a:has-text("Apply"), button:has-text("Apply")').first();
    if (await btn.count()) { await btn.click().catch(() => {}); await first.waitFor({ state: 'visible', timeout: 25000 }).catch(() => {}); }
  }
  if (!(await first.count())) throw new FormChanged('SmartRecruiters apply form did not render (input#first-name-input missing)');
  return page.mainFrame();
}

export async function fill(scope, card, profile, log) {
  await fillFirst(scope, [FIRST], profile.firstName, { what: 'first name' });
  await fillFirst(scope, ['input#last-name-input'], profile.lastName, { what: 'last name' });
  await fillFirst(scope, ['input#email-input'], profile.email, { what: 'email' });
  await fillFirst(scope, ['input#confirm-email-input'], profile.email, { what: 'confirm email' });
  // the country picker preselects a code (Israel by geo): national number when it shows +972, the international one otherwise
  const code = await scope.locator('button[aria-label="Country code"]').first().innerText().catch(() => '');
  const intl = String(profile.phone).replace(/[\s-]/g, '');
  const national = intl.replace(/^\+972/, '0');
  await fillFirst(scope, ['input[type=tel][aria-label="Phone number"]', 'input[type=tel]'], /\+972/.test(code) ? national : intl, { what: 'phone' });
  if (profile.linkedin) await fillFirst(scope, ['input#linkedin-input'], profile.linkedin, { required: false, what: 'linkedin' });
  log(`identity filled (phone as ${/\+972/.test(code) ? 'national, picker shows +972' : 'international, picker shows ' + (code.trim() || '?')})`);
}

export async function attachCv(scope, page, pdf) {
  const how = await attachFile(scope, page, pdf, { inputSelectors: ['input#spl-dropzone-file-input-1', 'input[type=file]:not([name^="file-upload"]):not(#spl-dropzone-file-input-2)'], buttonTexts: ['Choose a file'] });
  // make sure the file landed in the Resume box (the top "Easy Apply" box only parses the CV): the file name must be on the page
  const base = path.basename(pdf);
  const t0 = Date.now(); let seen = false;
  while (Date.now() - t0 < 20000) { if (await page.getByText(base, { exact: false }).count().catch(() => 0)) { seen = true; break; } await sleep(1000); }
  if (!seen) throw new FormChanged(`CV uploaded but "${base}" does not show on the SmartRecruiters form (wrong dropzone?)`);
  return how + ' (file name shown on the form)';
}

// Some companies split the form in two (Northwind, 25 Oct: page 1 ends in "Next", no privacy box; the declaration and any screening
// questions sit on page 2 with the Submit). "Next" sends nothing: gate page 1, press it once, then work on page 2.
async function nextStep(scope, log) {
  const submit = scope.locator('spl-button:has-text("Submit"), button:has-text("Submit")').first();
  if (await submit.isVisible().catch(() => false)) return;
  const next = scope.locator('spl-button:has-text("Next"), button:has-text("Next")').first();
  if (!(await next.isVisible().catch(() => false))) return;
  await gate(scope, m => log(m.replace('gate passed', 'gate passed on page 1')));
  // a press while the resume upload is still in flight does nothing (dry run 25 Oct): settle, press, and press once more if the page stays
  await sleep(4000);
  await pageDone(scope);   // the application record keeps page 1's fields
  const page1 = scope.url();
  for (let attempt = 0; attempt < 2 && !(await submit.isVisible().catch(() => false)); attempt++) {
    await next.click();
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) { if (await submit.isVisible().catch(() => false)) break; await sleep(1000); }
    if (scope.url() !== page1) { const t1 = Date.now(); while (Date.now() - t1 < 10000 && !(await submit.isVisible().catch(() => false))) await sleep(1000); break; }
  }
  if (!(await submit.isVisible().catch(() => false))) throw new FormChanged('SmartRecruiters "Next" pressed but no Submit appeared (page 1 refused, or a third step)');
  await sleep(1500);
  log('two-step form: page 1 done, on the page with the Submit');
}

export async function screeners(scope, card, log) {
  await nextStep(scope, log);
  // the privacy-notice declaration is required on every SmartRecruiters form: answer bank "Consent to store my data for recruiting: Yes"
  const cb = scope.locator('input[type=checkbox].c-spl-checkbox__input, input[type=checkbox][required], input[type=checkbox][aria-required="true"]');
  const n = await cb.count();
  for (let i = 0; i < n; i++) { const c = cb.nth(i); if (!(await c.isChecked().catch(() => false))) { await c.check({ force: true }).catch(async () => { await c.click({ force: true }).catch(() => {}); }); } }
  if (n) log(`privacy declaration ticked (${n} box${n === 1 ? '' : 'es'}, answer bank: consent = Yes)`);
  // the preparer lists that declaration as a screener ("Privacy declaration", "data processing consent"...): it is the box above, not a question block
  const CONSENT = /privacy|consent|data processing|declaration|gdpr|personal data/i;
  const a = card.apply || {}; const rest = (a.screeners || []).filter(sq => !CONSENT.test(sq.q || ''));
  if (rest.length !== (a.screeners || []).length) log(`consent screener satisfied by the privacy box, ${rest.length} real screener${rest.length === 1 ? '' : 's'} left`);
  return answerScreeners(scope, { ...card, apply: { ...a, screeners: rest } }, log);
}
// the form lives in shadow roots, which the generic gate (document.querySelectorAll) cannot see: walk them
export async function gate(scope, log) {
  const missing = await scope.evaluate(() => {
    const out = []; const seen = new Set();
    const walk = root => { for (const el of root.querySelectorAll('*')) { if (el.shadowRoot && !seen.has(el.shadowRoot)) { seen.add(el.shadowRoot); walk(el.shadowRoot); } if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.type !== 'hidden' && el.type !== 'file' && (el.required || el.getAttribute('aria-required') === 'true')) { const r = el.getBoundingClientRect(); if (r.width === 0 && r.height === 0 && el.type !== 'checkbox') continue; if (el.type === 'checkbox' ? !el.checked : !String(el.value || '').trim()) out.push((el.labels && el.labels[0] && el.labels[0].innerText.trim()) || el.getAttribute('aria-label') || el.id || el.type); } } };
    walk(document); return [...new Set(out)];
  }).catch(() => []);
  if (missing.length) throw new FormChanged(`required fields still empty: ${missing.join(', ')}`);
  log('required-field gate passed (shadow-aware)');
}
export async function submit(scope, page) {
  // the Submit is a custom element (<oc-button><spl-button type="primary"><span>Submit) with the native button inside its shadow root:
  // a plain button:has-text never matches (Fabrikam, 22 Oct, two ticks lost). Clicking the host lands on the inner button.
  const b = scope.locator('spl-button:has-text("Submit"), button:has-text("Submit"), button[type=submit]').first();
  await b.waitFor({ state: 'visible', timeout: 10000 });
  await b.click();
}
export async function confirmed(page, scope, ms = 45000) {
  const t0 = Date.now();
  const re = /thank you|your application (has been |was )?(submitted|received)|application (submitted|received|sent)|we('ve| have) received your application|successfully (applied|submitted)/i;
  while (Date.now() - t0 < ms) {
    const txt = await page.locator('body').innerText().catch(() => '');
    if (re.test(txt)) { const m = txt.match(re); return { ok: true, text: txt.slice(Math.max(0, m.index - 60), m.index + 160).replace(/\s+/g, ' ').trim() }; }
    if (/\/thank|application-submitted|applied/i.test(page.url())) return { ok: true, text: `SmartRecruiters page ${page.url()}` };
    if (await captchaChallengeVisible(page)) throw new Blocked('captcha', 'captcha challenge on submit');
    await sleep(1000);
  }
  return { ok: false };
}
export async function blocked(page) { if (await captchaChallengeVisible(page)) return 'captcha'; if (await loginWall(page)) return 'login'; return ''; }
