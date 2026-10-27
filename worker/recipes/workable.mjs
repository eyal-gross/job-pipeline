// Workable (built 26 Oct 2026, supply widening: discover counted 7 fitting Israel roles on Workable boards, past the 3-role line).
// Form: apply.workable.com/<account>/j/<shortcode>/apply/ (the posting's "Apply for this job" link; a cookie dialog covers the posting page,
// so the recipe opens the apply URL directly). React form, no captcha on the mapped postings (Zorg, 26 Oct). Fields: firstname, lastname,
// email, phone (intl picker, Israel preselected from the IP), optional headline / address / summary, custom questions named CA_<n>
// (often a required "Country" and "City"), the resume input[type=file], yes / no radios named QA_<n>, "Submit application".
// Answers come only from the card (preparer) and the answer bank facts already used by other recipes (Country Israel, City Tel Aviv).
import { fillFirst, attachFile, answerScreeners, requireFilled, Blocked, captchaChallengeVisible, loginWall, sleep } from '../lib/forms.mjs';

export const name = 'workable';
export const match = url => /apply\.workable\.com\//i.test(url) || /\.workable\.com\/(j|jobs)\//i.test(url);

export function applyUrl(url) {
  const u = String(url || '').replace(/[?#].*$/, '');
  if (/\/apply\/?$/.test(u)) return u.replace(/\/?$/, '/');
  const m = u.match(/^https?:\/\/apply\.workable\.com\/([^/]+)\/j\/([0-9A-F]+)/i); if (m) return `https://apply.workable.com/${m[1]}/j/${m[2]}/apply/`;
  return u;   // a short /j/<code> link redirects to the account URL; open() follows it and goes on to /apply/
}
export async function open(page, card, log = () => {}) {
  let url = applyUrl(card.apply.url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (!/\/apply\/?$/.test(new URL(page.url()).pathname)) { url = applyUrl(page.url()); if (/\/apply\/$/.test(url)) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
  // cookie dialog: decline, never accept all
  for (const sel of ['button:has-text("Decline all")', 'button[data-ui="cookie-consent-decline"]']) { const b = page.locator(sel).first(); if (await b.count() && await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); log('cookie dialog declined'); await sleep(800); break; } }
  await page.locator('input#firstname, input[name=firstname]').first().waitFor({ state: 'visible', timeout: 25000 });
  return page.mainFrame();
}
// Workable's custom questions (CA_<n>) are labelled by aria, not always by label[for]: ask Playwright's accessible-name lookup, short timeouts
// (a missing label must not wait out the 30 s default: the first Zorg dry run hung that way, 26 Oct)
const byLabel = async (scope, re, value, log, what) => {
  const els = scope.getByLabel(re).and(scope.locator('input[name^="CA_"]'));
  const n = await els.count();
  for (let i = 0; i < n; i++) { const el = els.nth(i); if (!(await el.inputValue({ timeout: 2000 }).catch(() => 'x'))) { await el.fill(value, { timeout: 5000 }); log(`${what} filled`); return true; } }
  return false;
};
export async function fill(scope, card, profile, log) {
  await fillFirst(scope, ['input#firstname', 'input[name=firstname]'], profile.firstName, { what: 'first name' });
  await fillFirst(scope, ['input#lastname', 'input[name=lastname]'], profile.lastName, { what: 'last name' });
  await fillFirst(scope, ['input#email', 'input[name=email]'], profile.email, { what: 'email' });
  // the picker already says Israel (+972): type the national number so the country code is not doubled
  const national = String(profile.phone || '').replace(/^\+972\s*/, '0').replace(/\s+/g, '');
  await fillFirst(scope, ['input#input_phone', 'input[name=phone]', 'input[type=tel]'], national || profile.phone, { what: 'phone' });
  // the cookie banner can show up after the form loads (Ollivander, 26 Oct): decline it, never accept all
  const dec = scope.locator('button:has-text("Decline all")').first(); if (await dec.count() && await dec.isVisible().catch(() => false)) { await dec.click().catch(() => {}); log('cookie dialog declined'); }
  // Address (required on some forms) arrives pre-filled from the visitor's IP (Ollivander showed "Petah Tiqva, Israel"): the answer bank says
  // Tel Aviv, Israel. Type it, take Workable's own suggestion when one shows, else keep the typed text.
  const addr = scope.locator('input#address, input[name=address]').first();
  if (await addr.count() && await addr.isVisible().catch(() => false)) {
    await addr.fill(''); await addr.pressSequentially('Tel Aviv', { delay: 60 }); await sleep(1500);
    const opt = scope.locator('[role=option]:has-text("Tel Aviv"), li:has-text("Tel Aviv-Yafo"), li:has-text("Tel Aviv, Israel")').first();
    if (await opt.count() && await opt.isVisible().catch(() => false)) { await opt.click(); log('address: Workable suggestion picked'); } else { await addr.fill('Tel Aviv, Israel'); log('address typed'); }
  }
  // custom "Country" / "City" questions: the answer bank's facts (Israel, Tel Aviv); a screener answer from the card wins when it has one
  await byLabel(scope, /^\*?\s*country\s*\*?$/i, 'Israel', log, 'country');
  await byLabel(scope, /^\*?\s*city\s*\*?$/i, 'Tel Aviv', log, 'city');
  if (profile.linkedin) await byLabel(scope, /linkedin/i, profile.linkedin, log, 'linkedin');
  log('identity filled');
}
// The resume input is NOT always the first file input: Ollivander's form has an optional Photo upload above it, and the first dry run
// (26 Oct 2026) put the CV into Photo while the required Resume stayed empty, with the generic gate passing. So: mark the file input whose
// section is labelled Resume / CV (never Photo / cover letter), attach there, and gate() checks the file name shows under Resume.
const RESUME_MARK = 'data-runner-resume';
async function markResume(scope) {
  return scope.evaluate(mark => {
    const inputs = [...document.querySelectorAll('input[type=file]')];
    // the smallest ancestor that names a kind decides: the dropzone's own text ("Choose file or drag and drop here") names none
    const kindOf = el => { for (let p = el.parentElement, i = 0; p && i < 10; p = p.parentElement, i++) { const t = (p.innerText || '').replace(/\s+/g, ' '); const photo = /photo|picture|cover letter|תמונה/i.test(t), cv = /resume|\bcv\b|קורות חיים/i.test(t); if (photo && cv) return 'both'; if (photo) return 'photo'; if (cv) return 'resume'; } return ''; };
    const pick = inputs.find(el => kindOf(el) === 'resume');
    inputs.forEach(el => el.removeAttribute(mark)); if (pick) pick.setAttribute(mark, '1');
    return !!pick;
  }, RESUME_MARK);
}
const resumeBox = scope => scope.locator(`[${RESUME_MARK}]`).locator('xpath=ancestor::*[contains(translate(normalize-space(.), "RESUME", "resume"), "resume")][1]');
export async function attachCv(scope, page, pdf, log = () => {}) {
  if (!(await markResume(scope))) throw new Error('changed-form: no file input labelled Resume');
  await scope.locator(`input[${RESUME_MARK}]`).setInputFiles(pdf);
  await sleep(2500);
  log('cv attached to the Resume input');
  return `input[${RESUME_MARK}]`;
}
export async function screeners(scope, card, log) { return answerScreeners(scope, card, log); }
export async function submit(scope, page) { const b = scope.locator('button[type=submit]:has-text("Submit application"), button[data-ui="apply-button"]').first(); await b.waitFor({ state: 'visible', timeout: 10000 }); await b.click(); }
export async function confirmed(page, scope, ms = 30000) {
  const t0 = Date.now();
  const re = /application (has been )?(submitted|received|sent)|thank(s| you) for (applying|your application)|we.ve received your application|successfully submitted/i;
  while (Date.now() - t0 < ms) {
    const txt = await page.locator('body').innerText().catch(() => '');
    if (re.test(txt)) { const m = txt.match(re); return { ok: true, text: txt.slice(Math.max(0, m.index - 60), m.index + 160).replace(/\s+/g, ' ') }; }
    if (await captchaChallengeVisible(page)) throw new Blocked('captcha', 'captcha challenge on submit');
    await sleep(1000);
  }
  return { ok: false };
}
export async function blocked(page) { if (await captchaChallengeVisible(page)) return 'captcha'; if (await loginWall(page)) return 'login'; return ''; }
export async function gate(scope, log) {
  // the CV must show under Resume itself (the generic gate cannot tell Photo from Resume)
  const box = resumeBox(scope); const txt = await box.count() ? await box.first().innerText({ timeout: 3000 }).catch(() => '') : '';
  if (!/\.pdf\b/i.test(txt)) throw new Error('required-empty: Resume shows no file');
  log('resume shows the CV file');
  return requireFilled(scope, log);
}
