// Greenhouse: boards.greenhouse.io/<co>/jobs/<id> (classic, ids #first_name #last_name #email #phone, resume input#resume or data-source=attach,
// submit input#submit_app, confirmation #application_confirmation) and job-boards.greenhouse.io (new, label-driven, button "Submit application").
// Company sites embed the same form (example.com/careers/?gh_jid=...): the form is then inside an iframe from greenhouse.io, so open()
// returns whichever frame holds the first-name field. reCAPTCHA Enterprise is common: an HTTP 428 or a visible challenge means blocked/captcha.
// Dry-run on a real card before the first live submit (not proven live yet as of 19 Oct 2026).
import { fillFirst, attachFile, answerScreeners, answerDemographics, requireFilled, Blocked, captchaChallengeVisible, loginWall, sleep, onField } from '../lib/forms.mjs';

export const name = 'greenhouse';
export const match = url => /greenhouse\.io\/|[?&]gh_jid=/i.test(url);
const FIRST = '#first_name, input[name=first_name], input[name="job_application[first_name]"], input[aria-label="First Name"], input[autocomplete="given-name"]';

async function formScope(page) {
  for (const f of page.frames()) { try { if (await f.locator(FIRST).count()) return f; } catch { /* detached */ } }
  return null;
}

export async function open(page, card, log) {
  await page.goto(card.apply.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2000);
  let scope = await formScope(page);
  if (!scope) {
    const apply = page.locator('a:has-text("Apply"), button:has-text("Apply")').first();
    if (await apply.count()) { await apply.click().catch(() => {}); await sleep(2000); scope = await formScope(page); }
  }
  if (!scope) {
    const t0 = Date.now(); while (!scope && Date.now() - t0 < 20000) { await sleep(1000); scope = await formScope(page); }
  }
  if (!scope) throw new Blocked('bot', 'application form (first-name field) did not appear');
  // Bluth (24 Oct 2026): the embed is loaded but hidden until the page's own "Apply" button is pressed, so a found-but-hidden form
  // gets the Apply click too; if it still stays hidden, open the iframe's own Greenhouse URL as the page.
  const visible = (s) => s.locator(FIRST).first().waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false);
  if (!(await visible(scope))) {
    const apply = page.locator('a:has-text("Apply"), button:has-text("Apply")').first();
    if (await apply.count()) { await apply.click().catch(() => {}); if (log) log('form hidden: clicked Apply'); await sleep(2500); scope = (await formScope(page)) || scope; }
    if (!(await visible(scope)) && scope !== page.mainFrame() && /greenhouse\.io\//i.test(scope.url())) {
      if (log) log('form still hidden: opening the embed ' + scope.url());
      await page.goto(scope.url(), { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(2000);
      scope = (await formScope(page)) || page.mainFrame();
    }
  }
  await scope.locator(FIRST).first().waitFor({ state: 'visible', timeout: 15000 });
  // cookie banner on company sites: decline / close, never "accept all"
  // The consent click can make the site re-initialise its embeds: Wayne Networks (Cookiebot) reloaded the Greenhouse iframe about a second
  // after it, and the first / last name and email typed before the reload were gone while everything typed after stayed (23 Oct 2026 dry
  // run). So after a consent click: wait, resolve the frame again, wait for the field.
  for (const sel of ['button:has-text("Reject")', 'button:has-text("Decline")', 'button:has-text("Necessary only")', '[aria-label="Close"]', '.cookie-banner button:has-text("×")']) {
    const b = page.locator(sel).first();
    if (await b.count() && await b.isVisible().catch(() => false)) {
      await b.click().catch(() => {}); if (log) log('cookie banner: ' + sel);
      await sleep(3500);
      const again = await formScope(page); if (again) scope = again;
      await scope.locator(FIRST).first().waitFor({ state: 'visible', timeout: 15000 });
      break;
    }
  }
  return scope;
}
export async function fill(scope, card, profile, log) {
  await fillFirst(scope, FIRST.split(', '), profile.firstName, { what: 'first name' });
  await fillFirst(scope, ['#last_name', 'input[name=last_name]', 'input[name="job_application[last_name]"]', 'input[aria-label="Last Name"]', 'input[autocomplete="family-name"]'], profile.lastName, { what: 'last name' });
  await fillFirst(scope, ['#email', 'input[name=email]', 'input[name="job_application[email]"]', 'input[aria-label="Email"]', 'input[type=email]'], profile.email, { what: 'email' });
  await pickCombo(scope, '#country, input[aria-label="Country"]', profile.country || 'Israel', log, 'country');
  await fillFirst(scope, ['#phone', 'input[name=phone]', 'input[name="job_application[phone]"]', 'input[aria-label="Phone"]', 'input[type=tel]'], profile.phone, { required: false, what: 'phone' });
  await pickCombo(scope, '#candidate-location, input[aria-label*="Location" i]', profile.city || 'Tel Aviv', log, 'location');
  if (profile.linkedin) {
    // the LinkedIn question is a custom field: find its label, then the input next to it
    const lab = scope.locator('label').filter({ hasText: /linkedin/i }).first();
    if (await lab.count()) {
      const forId = await lab.getAttribute('for').catch(() => '');
      const input = forId ? scope.locator(`#${CSS_escape(forId)}`) : lab.locator('xpath=following::input[1]');
      try { if (await input.count()) { await input.first().fill(profile.linkedin); log('linkedin filled'); } } catch { /* optional */ }
    } else await fillFirst(scope, ['input[aria-label*="LinkedIn" i]', 'input[name*=linkedin i]'], profile.linkedin, { required: false, what: 'linkedin' });
  }
  log('identity filled');
}
const CSS_escape = s => String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
// react-select combobox (Country*, Location (City)* on the new Greenhouse form): type, then pick the first suggestion
async function pickCombo(scope, selector, text, log, what) {
  const input = scope.locator(selector).first();
  if (!(await input.count()) || !(await input.isVisible().catch(() => false))) return false;
  await input.click({ timeout: 5000 }).catch(() => {});
  await input.fill(text);
  const opt = scope.locator('[role=option], [class*="select__option"], [class*="option"]').filter({ hasText: new RegExp(text.split(',')[0], 'i') }).first();
  let seen = false; const t0 = Date.now();
  while (Date.now() - t0 < 5000) { await sleep(600); if (await opt.count() && await opt.isVisible().catch(() => false)) { seen = true; break; } }   // a slow list + ArrowDown picked "+1" for Israel (Wayne, 23 Oct)
  if (seen) await opt.click();
  else { await input.press('ArrowDown'); await input.press('Enter'); }
  await sleep(500);
  const chosen = await input.evaluate(el => { let n = el; for (let i = 0; i < 6 && n; i++, n = n.parentElement) { const v = n.querySelector('[class*="single-value"], [class*="singleValue"]'); if (v) return v.textContent.trim(); } return ''; }).catch(() => '');
  log(`${what}: ${chosen || 'no value shown'}`);
  try { if (onField) onField({ field: what, label: what, value: chosen || text, source: 'profile', selector, kind: 'combobox' }); } catch { /* ignore */ }
  return !!chosen;
}
export async function attachCv(scope, page, pdf) { return attachFile(scope, page, pdf, { inputSelectors: ['#resume', 'input[name=resume]', 'input[name="job_application[resume]"]', 'input[type=file][name*=resume]', 'input[type=file]'], buttonTexts: ['Attach', 'Upload'] }); }
export async function screeners(scope, card, log) { await answerScreeners(scope, card, log); await answerDemographics(scope, log); }
export async function gate(scope, log) { return requireFilled(scope, log, FIRST); }
// Company sites with "Role Overview | Apply" tabs (Lucerne) can flip back to the overview tab after the form is filled (the full-page
// "filled" screenshot resizes the viewport): the iframe is then hidden and the click waits for visibility until it times out (24 Oct 2026,
// nothing sent). So: if the button is not visible, click the page's Apply tab again; the typed values stay in the hidden iframe.
// reveal() does everything but the click, so dry-run.mjs can prove the button is reachable after the full-page screenshot.
export async function reveal(scope, page) {
  const b = scope.locator('#submit_app, button[type=submit]:has-text("Submit"), button:has-text("Submit application"), input[type=submit]').first();
  if (!(await b.isVisible().catch(() => false)) && page) {
    const tab = page.locator('a, button, [role=tab], li, span, div').filter({ hasText: /^\s*Apply\s*$/ }).last();
    if (await tab.count() && await tab.isVisible().catch(() => false)) { await tab.click().catch(() => {}); await sleep(2000); }
  }
  await b.waitFor({ state: 'visible', timeout: 10000 }); await b.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  return b;
}
// The 24 Oct Lucerne failure was not the tab: the embed keeps resizing, so the button is visible but never "stable" and Playwright's
// click waits out its timeout without dispatching anything (dry run: a trial click and scrollIntoView both time out on stability).
// A click that times out in the actionability wait sent nothing, so falling back to the element's own DOM click is safe and lands once.
export async function stable(b) { try { await b.click({ trial: true, timeout: 5000 }); return true; } catch { return false; } }
export async function submit(scope, page) {
  const b = await reveal(scope, page);
  if (await stable(b)) { await b.click(); return; }
  await b.evaluate(el => el.click());
}
export async function confirmed(page, scope, ms = 30000) {
  const t0 = Date.now();
  const re = /thank you for applying|application (has been )?(submitted|received)|we have received your application|we.ve received your application|application received|thanks for applying/i;
  while (Date.now() - t0 < ms) {
    for (const f of page.frames()) {
      try {
        // embedded boards land the iframe on /embed/job_app/confirmation (Wayne, 23 Oct: the text check missed it); hosted boards
        // on /<board>/jobs/<id>/confirmation, "Your application has been received" (Piedpiper, 25 Oct: marked unverified, it went through)
        if (/\/job_app\/confirmation|\/jobs\/\d+\/confirmation|\/confirmation\?for=/.test(f.url())) return { ok: true, text: 'greenhouse confirmation page ' + f.url().split('?')[0] };
        if (await f.locator('#application_confirmation').count()) return { ok: true, text: (await f.locator('#application_confirmation').innerText().catch(() => 'application_confirmation')).slice(0, 200) };
        const txt = await f.evaluate(() => document.body ? document.body.innerText : '');
        if (re.test(txt)) { const m = txt.match(re); return { ok: true, text: txt.slice(Math.max(0, m.index - 60), m.index + 160).replace(/\s+/g, ' ') }; }
      } catch { /* frame navigated */ }
    }
    if (await captchaChallengeVisible(page)) throw new Blocked('captcha', 'captcha challenge on submit');
    await sleep(1000);
  }
  return { ok: false };
}
export async function blocked(page) { if (await captchaChallengeVisible(page)) return 'captcha'; if (await loginWall(page)) return 'login'; return ''; }
