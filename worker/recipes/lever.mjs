// Lever: https://jobs.lever.co/<company>/<id>/apply. One page form: name, email, phone, org, LinkedIn URL, resume (input[name=resume]),
// optional custom questions (cards[...]), submit button #btn-submit. Confirmation: URL ends with /thanks. Sometimes hCaptcha.
import { fillFirst, attachFile, answerScreeners, requireFilled, Blocked, captchaChallengeVisible, loginWall, sleep } from '../lib/forms.mjs';

export const name = 'lever';
export const match = url => /jobs\.lever\.co\//i.test(url);

export async function open(page, card) {
  let url = card.apply.url; if (!/\/apply\b/.test(url)) url = url.replace(/\/?(\?.*)?$/, '/apply');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('input[name=name]').first().waitFor({ state: 'visible', timeout: 20000 });
  return page.mainFrame();
}
export async function fill(scope, card, profile, log) {
  await fillFirst(scope, ['input[name=name]'], `${profile.firstName} ${profile.lastName}`, { what: 'name' });
  await fillFirst(scope, ['input[name=email]'], profile.email, { what: 'email' });
  await fillFirst(scope, ['input[name=phone]'], profile.phone, { what: 'phone' });
  if (profile.linkedin) await fillFirst(scope, ['input[name="urls[LinkedIn]"]'], profile.linkedin, { required: false, what: 'optional' });
  await fillLocation(scope, profile, log);
  log('identity filled');
}
// "Current location" (#location-input, required on most Lever forms, 22 Oct: Duff and every Krusty posting): a Google Places typeahead.
// Type the city from the profile (answer bank: Tel Aviv, Israel), take the first suggestion when one shows so the hidden selectedLocation is set;
// the typed text alone satisfies the required attribute when no suggestion comes. Reviewer, 22 Oct 2026.
async function fillLocation(scope, profile, log) {
  const value = profile.city ? (profile.country ? profile.city + ', ' + profile.country : profile.city) : 'Tel Aviv, Israel';
  const sel = await fillFirst(scope, ['#location-input', 'input[name=location]'], value, { required: false, what: 'location' });
  if (!sel) return;
  // 26 Oct 2026 (Stark failed on "Current location" empty): fill() sends no key events, so Lever's own list (div.dropdown-location rows,
  // not Google Places) never opened and the unpicked text was cleared. Type the city key by key, then pick the Israel row.
  const input = scope.locator(sel).first(); const city = (value.split(',')[0] || 'Tel Aviv').trim();
  await input.fill(''); await input.click().catch(() => {}); await input.pressSequentially(city, { delay: 60 }).catch(() => {}); await sleep(2500);
  const rows = scope.locator('.dropdown-location, .pac-container .pac-item, .dropdown-results li, [class*="location-dropdown"] li');
  const n = await rows.count().catch(() => 0); let pick = null;
  for (let i = 0; i < Math.min(n, 20) && !pick; i++) { const r = rows.nth(i); if (!await r.isVisible().catch(() => false)) continue; const t = (await r.innerText().catch(() => '')).trim(); if (/\b(ISR|Israel)\b/i.test(t) && t.toLowerCase().startsWith(city.toLowerCase())) pick = { r, t }; }
  if (pick) { await pick.r.click().catch(() => {}); await sleep(600); log(`location: picked "${pick.t.slice(0, 40)}"`); }
  else { await input.fill(value); log('location: typed, no Israel row in the list'); }
}
export async function attachCv(scope, page, pdf) { return attachFile(scope, page, pdf, { inputSelectors: ['input[name=resume]', '#resume-upload-input', 'input[type=file]'] }); }
// the standard contact fields fill() already handled are skipped here: the preparer lists "Current location" / "LinkedIn URL" from the
// posting, and typing over the picked location cleared it (Stark, 26 Oct 2026; the city also landed in Full name)
const STANDARD = /^(current )?location$|^linkedin( profile)?( url)?$|^(full )?name$|^email$|^phone$/;
export async function screeners(scope, card, log) {
  const a = card.apply || {}; const screeners = (a.screeners || []).filter(sq => { const keep = !STANDARD.test(String(sq.q || '').replace(/[*✱]/g, '').trim().toLowerCase()); if (!keep) log(`screener skipped, standard field filled by the recipe: ${sq.q}`); return keep; });
  return answerScreeners(scope, { ...card, apply: { ...a, screeners } }, log);
}
export async function submit(scope, page) { const b = scope.locator('#btn-submit, button[type=submit]:has-text("Submit")').first(); await b.waitFor({ state: 'visible', timeout: 10000 }); await b.click(); }
export async function confirmed(page, scope, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (/\/thanks\b/.test(page.url())) return { ok: true, text: `Lever /thanks page: ${(await page.locator('body').innerText().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ')}` };
    if (await captchaChallengeVisible(page)) throw new Blocked('captcha', 'captcha challenge on submit');
    await sleep(1000);
  }
  return { ok: false };
}
export async function blocked(page) { if (await captchaChallengeVisible(page)) return 'captcha'; if (await loginWall(page)) return 'login'; return ''; }
// required-field gate (added by the reviewer 22 Oct 2026): same reason as Ashby, never a half form
export async function gate(scope, log) { return requireFilled(scope, log); }
