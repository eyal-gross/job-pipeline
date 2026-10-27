// Comeet. The application form is a cross-origin iframe (name comeet-applyform-*) from www.comeet.co, injected after
// the "Apply for this job" button on the posting page. Opening the iframe URL directly also works (then scope = main frame).
// Field ids seen on real forms (probe.mjs, Nakatomi + Spacely; live on Globex, Weyland, Gringotts 19 Oct 2026): #inputFirstName #inputLastName
// #inputEmail #inputTel input[name=cv] (file) #inputLink (website) input[name=portfolio] (file) #inputNote (textarea). Submit button text
// "Submit application". Invisible reCAPTCHA v2. Some companies add a consent checkbox (is_consent_needed): ticked when present and required.
import { fillFirst, attachFile, answerScreeners, requireFilled, Blocked, captchaChallengeVisible, loginWall, sleep } from '../lib/forms.mjs';

export const name = 'comeet';
export const match = url => /comeet\.(com|co)\/jobs\//i.test(url);

export async function open(page, card) {
  await page.goto(card.apply.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  if (/comeet\.co\/jobs\/.*\/apply/i.test(page.url())) return page.mainFrame();
  const btn = page.locator('#showApplyForm, button:has-text("Apply for this job"), a:has-text("Apply for this job")').first();
  if (await btn.count()) { await btn.click(); }
  await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some(f => (f.name || '').startsWith('comeet-applyform')), null, { timeout: 20000 }).catch(() => {});
  await sleep(2000);
  const frame = page.frames().find(f => (f.name() || '').startsWith('comeet-applyform'));
  if (!frame) throw new Blocked('bot', 'apply form iframe did not appear');
  await frame.locator('#inputFirstName').waitFor({ state: 'visible', timeout: 15000 });
  return frame;
}

// Personal note with the role's name (Eyal, 25 Oct 2026: "make sure the English isn't getting messed up for some role names").
// The title is cleaned (no "(Mid-Level)", " - Team", location tails, leading "*", gender marks) and used only when it reads as a plain
// English job title; Hebrew, very long or odd titles fall back to "this role". Never "the X role role".
export function roleForNote(raw) {
  if (/[֐-׿]/.test(String(raw || ''))) return null;   // any Hebrew in the title: "ACME (אקמי)- מנהל/ת" read as "ACME"
  let t = String(raw || '').replace(/^[\s*•-]+/, '').replace(/\s*[([].*?[)\]]/g, ' ').replace(/\s*,.*$/, '').replace(/(\s+[-–—|@]\s*|\s*[-–—|@]\s+).*$/, '').replace(/\s+(in|at)\s+(tel aviv|israel|herzliya|haifa|jerusalem|remote|hybrid)\b.*$/i, '').replace(/\s+/g, ' ').trim();
  t = t.replace(/\s+(role|position|job|opening)$/i, '').trim();
  if (!t || /[\u0590-\u05FF]/.test(t) || t.length > 55 || t.split(' ').length > 7 || !/^[A-Za-z0-9 &/.+'#-]+$/.test(t) || !/[A-Za-z]{2}/.test(t)) return null;
  return t;
}
export function personalNote(title) {
  const r = roleForNote(title);
  return `Hey,\nI really think this is a good match for ${r ? `the ${r} role` : 'this role'}. Please reach out and let's explore this.`;
}

export async function fill(scope, card, profile, log) {
  await fillFirst(scope, ['#inputFirstName', 'input[name=firstName]'], profile.firstName, { what: 'first name' });
  await fillFirst(scope, ['#inputLastName', 'input[name=lastName]'], profile.lastName, { what: 'last name' });
  await fillFirst(scope, ['#inputEmail', 'input[name=email]'], profile.email, { what: 'email' });
  // the country picker already holds +972: type the national number (0549...), not the international one
  await fillFirst(scope, ['#inputTel', 'input[name=phone]'], String(profile.phone).replace(/^\+972\s?/, '0').replace(/[\s-]/g, ''), { what: 'phone' });
  // The default link field is "Personal website": it stays empty (Eyal, 25 Oct 2026: never put LinkedIn in a website field).
  // Some companies add a real "LinkedIn Profile" field (Globex, name=linkedin): that one gets the profile URL (Eyal, 26 Oct 2026).
  if (profile.linkedin) {
    const byLabel = scope.getByLabel(/linkedin/i).first();
    const box = (await byLabel.count().catch(() => 0)) ? byLabel : scope.locator('input[name=linkedin i], input[id*=linkedin i]').first();
    if (await box.count().catch(() => 0) && !(await box.inputValue().catch(() => 'x'))) { await box.fill(profile.linkedin).catch(() => {}); log('linkedin filled'); }
  }
  // Personal note (Eyal, 25 Oct 2026): his fixed note, from config.local.json profile.personalNote (the answer bank holds the same text)
  if (profile.personalNote) {
    const byLabel = scope.getByLabel(/personal note|note to|message to/i).first();
    const box = (await byLabel.count().catch(() => 0)) ? byLabel : (await scope.locator('textarea').count() === 1 ? scope.locator('textarea').first() : null);
    const note = personalNote(card.apply && card.apply.title || card.title);
    if (box) { await box.fill(note).catch(() => {}); log(`personal note filled: ${note.split('\n')[1].slice(0, 90)}`); } else log('no personal note box on this form');
  }
  log('identity filled');
}

export async function attachCv(scope, page, pdf) { return attachFile(scope, page, pdf, { inputSelectors: ['input[name=cv]', '#cv', 'input[type=file]'] }); }

export async function screeners(scope, card, log) {
  await answerScreeners(scope, card, log);
  // consent / privacy checkbox: tick only a required one (never a marketing opt-in)
  const consent = scope.locator('input[type=checkbox][required], input[type=checkbox][name*=consent i], input[type=checkbox][id*=consent i]').first();
  if (await consent.count() && !(await consent.isChecked().catch(() => true))) { await consent.check({ force: true }).catch(() => {}); log('consent checkbox ticked'); }
  // the privacy-policy line asked as a Yes / No radio pair instead of a checkbox (Soylent, 26 Oct 2026: the preparer cannot read the
  // Comeet iframe, so it never reached the card's screeners). Answer bank "I agree to the privacy policy / terms" = Yes. Only a group with
  // nothing picked, whose question reads as privacy / read-and-understood, and whose option is exactly "Yes".
  const picks = await scope.evaluate(() => {
    const out = []; const names = [...new Set([...document.querySelectorAll('input[type=radio]')].map(r => r.name).filter(Boolean))];
    for (const name of names) {
      const rs = [...document.querySelectorAll(`input[type=radio][name="${CSS.escape(name)}"]`)];
      if (rs.some(r => r.checked)) continue;
      let el = rs[0].parentElement; for (let i = 0; i < 6 && el && !rs.every(r => el.contains(r)); i++) el = el.parentElement;
      for (let i = 0; i < 3 && el && !/\bprivacy (policy|statement|notice)\b|read and understood/i.test(el.innerText || ''); i++) el = el.parentElement;
      if (!el || !/\bprivacy (policy|statement|notice)\b|read and understood/i.test(el.innerText || '')) continue;
      const lab = r => ((r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`)) || r.closest('label') || r.parentElement || {}).innerText || r.value || '';
      const idx = rs.findIndex(r => lab(r).trim().toLowerCase() === 'yes');
      if (idx >= 0) out.push({ name, idx });
    }
    return out;
  }).catch(() => []);
  for (const p of picks) {
    const r = scope.locator(`input[type=radio][name="${p.name}"]`).nth(p.idx);
    await r.check({ force: true }).catch(() => {});
    if (!await r.isChecked().catch(() => false)) { const id = await r.getAttribute('id'); if (id) await scope.locator(`label[for="${id}"]`).first().click().catch(() => {}); }
    log(`privacy policy radio answered Yes (${p.name})`);
  }
}

export async function gate(scope, log) { return requireFilled(scope, log, '#inputFirstName, input[name=firstName]'); }

export async function submit(scope, page) {
  const btn = scope.locator('button[type=submit]:has-text("Submit"), button:has-text("Submit application")').first();
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  await btn.click();
}

export async function confirmed(page, scope, ms = 30000) {
  const t0 = Date.now();
  const re = /thank you|thanks for applying|application (was|has been) (sent|submitted|received)|we (have )?received your application|successfully (submitted|applied)|your application was submitted/i;
  while (Date.now() - t0 < ms) {
    for (const f of page.frames()) {
      try { const txt = await f.evaluate(() => document.body ? document.body.innerText : ''); if (re.test(txt)) { const m = txt.match(re); return { ok: true, text: txt.slice(Math.max(0, m.index - 80), m.index + 200).replace(/\s+/g, ' ').trim() }; } } catch { /* frame navigated */ }
    }
    if (await captchaChallengeVisible(page)) throw new Blocked('captcha', 'reCAPTCHA challenge appeared on submit');
    await sleep(1000);
  }
  return { ok: false };
}

export async function blocked(page) {
  if (await captchaChallengeVisible(page)) return 'captcha';
  if (await loginWall(page)) return 'login';
  return '';
}
