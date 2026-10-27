// Ashby: jobs.ashbyhq.com/<co>/<id>/application. React form; system fields input[name=_systemfield_name|_systemfield_email|_systemfield_phone?],
// resume via a hidden input[type=file] behind an "Upload File" button, submit button "Submit Application". Confirmation text "Application submitted" /
// "Thank you for applying". Sometimes a visible hCaptcha.
import { fillFirst, attachFile, answerScreeners, requireFilled, Blocked, captchaChallengeVisible, loginWall, sleep } from '../lib/forms.mjs';

export const name = 'ashby';
export const match = url => /jobs\.ashbyhq\.com\//i.test(url);

export async function open(page, card) {
  let url = card.apply.url; if (!/\/application\b/.test(url)) url = url.replace(/\/?(\?.*)?$/, '/application');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('input[name=_systemfield_name], input[aria-label="Full name" i], input[placeholder*="name" i]').first().waitFor({ state: 'visible', timeout: 20000 });
  return page.mainFrame();
}
export async function fill(scope, card, profile, log) {
  await fillFirst(scope, ['input[name=_systemfield_name]', 'input[aria-label="Full name" i]'], `${profile.firstName} ${profile.lastName}`, { what: 'name' });
  await fillFirst(scope, ['input[name=_systemfield_email]', 'input[type=email]'], profile.email, { what: 'email' });
  await fillFirst(scope, ['input[name=_systemfield_phone]', 'input[type=tel]'], profile.phone, { required: false, what: 'optional' });
  if (profile.linkedin) await fillFirst(scope, ['input[name*=linkedin i]', 'input[aria-label*="LinkedIn" i]'], profile.linkedin, { required: false, what: 'optional' });
  // Ashby custom 'LinkedIn Profile' fields carry a uuid name: find them by label (profile value, optional)
  if (profile.linkedin) { try { const byLabel = scope.getByLabel(/linkedin/i).first(); if (await byLabel.count() && !(await byLabel.inputValue().catch(() => 'x'))) { await byLabel.fill(profile.linkedin); log('linkedin filled by label'); } } catch { /* optional */ } }
  log('identity filled');
}
export async function attachCv(scope, page, pdf) { return attachFile(scope, page, pdf, { inputSelectors: ['input#_systemfield_resume', 'input[type=file][name*=resume i]', 'input[type=file]'], buttonTexts: ['Upload File', 'Upload', 'Attach'] }); }
export async function screeners(scope, card, log) { return answerScreeners(scope, card, log); }
export async function submit(scope, page) { const b = scope.locator('button:has-text("Submit Application"), button[type=submit]').first(); await b.waitFor({ state: 'visible', timeout: 10000 }); await b.click(); }
export async function confirmed(page, scope, ms = 30000) {
  const t0 = Date.now();
  const re = /application submitted|thank you for applying|thanks for applying|you.re all set|we have received your application|successfully submitted/i;
  while (Date.now() - t0 < ms) {
    const txt = await page.locator('body').innerText().catch(() => '');
    if (re.test(txt)) { const m = txt.match(re); return { ok: true, text: txt.slice(Math.max(0, m.index - 60), m.index + 160).replace(/\s+/g, ' ') }; }
    if (await captchaChallengeVisible(page)) throw new Blocked('captcha', 'captcha challenge on submit');
    await sleep(1000);
  }
  return { ok: false };
}
export async function blocked(page) { if (await captchaChallengeVisible(page)) return 'captcha'; if (await loginWall(page)) return 'login'; return ''; }
// required-field gate (added by the reviewer 22 Oct 2026): without it the worker clicked Submit with required custom questions empty
export async function gate(scope, log) { return requireFilled(scope, log); }
