// BambooHR (built 26 Oct 2026, supply widening: discover counted 5 fitting Israel roles on BambooHR boards, past the 3-role line).
// Form: <company>.bamboohr.com/careers/<id>; the application form is on the posting page itself (mapped on Cogswell, 26 Oct). Fields:
// firstName, lastName, email, phone, the resume behind a "Choose File" button (input[type=file]), linkedinUrl, sometimes custom questions,
// "Submit Application". A honeypot text field ("Please leave this field blank", name nickname_*) must stay EMPTY. Captcha frames load
// passively; a visible challenge blocks the card like everywhere else.
import { fillFirst, attachFile, answerScreeners, requireFilled, Blocked, captchaChallengeVisible, loginWall, sleep } from '../lib/forms.mjs';

export const name = 'bamboohr';
export const match = url => /\.bamboohr\.com\/(careers|jobs)\//i.test(url);

export async function open(page, card, log = () => {}) {
  const url = String(card.apply.url).replace(/[?#].*$/, '').replace(/\/jobs\/view\.php\?id=(\d+)/, '/careers/$1');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // the page renders by script: wait for the form or its own "Apply for This Job" button, press the button when the form is not open yet
  const first = page.locator('input#firstName, input[name=firstName]').first();
  const apply = page.getByRole('button', { name: /apply for this job|apply now|^apply$/i }).or(page.getByRole('link', { name: /apply for this job|apply now/i })).first();
  await first.or(apply).first().waitFor({ state: 'visible', timeout: 30000 });
  if (!(await first.isVisible().catch(() => false))) { await apply.click(); log('apply button'); }
  await first.waitFor({ state: 'visible', timeout: 25000 });
  return page.mainFrame();
}
export async function fill(scope, card, profile, log) {
  await fillFirst(scope, ['input#firstName', 'input[name=firstName]'], profile.firstName, { what: 'first name' });
  await fillFirst(scope, ['input#lastName', 'input[name=lastName]'], profile.lastName, { what: 'last name' });
  await fillFirst(scope, ['input#email', 'input[name=email]'], profile.email, { what: 'email' });
  await fillFirst(scope, ['input#phone', 'input[name=phone]'], profile.phone, { what: 'phone' });
  if (profile.linkedin) await fillFirst(scope, ['input#linkedinUrl', 'input[name=linkedinUrl]'], profile.linkedin, { required: false, what: 'optional' });
  // the honeypot must be empty: a bot trap, never a question
  const trap = scope.locator('input[name^="nickname_"]'); for (let i = 0; i < await trap.count(); i++) if (await trap.nth(i).inputValue().catch(() => '')) await trap.nth(i).fill('');
  log('identity filled');
}
export async function attachCv(scope, page, pdf) { return attachFile(scope, page, pdf, { inputSelectors: ['input[type=file]'], buttonTexts: ['Choose File', 'Upload', 'Resume'] }); }
export async function screeners(scope, card, log) { return answerScreeners(scope, card, log); }
export async function submit(scope, page) { const b = scope.locator('button[type=submit]:has-text("Submit Application")').first(); await b.waitFor({ state: 'visible', timeout: 10000 }); await b.click(); }
export async function confirmed(page, scope, ms = 30000) {
  const t0 = Date.now();
  const re = /application (was |has been )?(submitted|received|sent)|thank(s| you) for (applying|your (interest|application))|we.ve received your application|successfully submitted/i;
  while (Date.now() - t0 < ms) {
    const txt = await page.locator('body').innerText().catch(() => '');
    if (re.test(txt)) { const m = txt.match(re); return { ok: true, text: txt.slice(Math.max(0, m.index - 60), m.index + 160).replace(/\s+/g, ' ') }; }
    if (await captchaChallengeVisible(page)) throw new Blocked('captcha', 'captcha challenge on submit');
    await sleep(1000);
  }
  return { ok: false };
}
export async function blocked(page) { if (await captchaChallengeVisible(page)) return 'captcha'; if (await loginWall(page)) return 'login'; return ''; }
// the generic gate reads the honeypot as an optional empty text field (not required), so it never stops a form for it
export async function gate(scope, log) { return requireFilled(scope, log); }
