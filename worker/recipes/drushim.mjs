// Drushim (drushim.co.il), apply with Eyal's logged-in account in the runner Chrome.
// 20 Oct 2026 evening: the submit button carries NO type attribute (the DOM reports type=submit, the CSS [type=submit] selector does not match),
// which is why the two live attempts reported "submit button stayed disabled". Selector is now button:has-text("הגשת מועמדות").
// Verified on the logged-in profile 20 Oct 2026 (probe on a real posting, nothing sent): posting page has ONE button
// `button[class*="apply-button"]` ("הגשה"); it opens a ReactModal (`.ReactModal__Content`) that shows the profile (name, city, email,
// phone, years of experience*), a CV box with an "העלאת קו״ח" button backed by a hidden `input[type=file]` (accept .pdf,.docx), an opt-in
// checkbox "מאשר/ת שליחת קורות חיים שלי ע"י המערכת למשרות מתאימות נוספות" (checked since 25 Oct 2026, Eyal: more chances), and a
// submit button "הגשת מועמדות" (type=submit) that stays disabled until a CV is attached. The tailored PDF is attached per application.
// Profile field "שנות ניסיון" is required on the profile itself (Eyal sets it once). A posting with `externalApplyUrl` hands off to
// the company's site: the worker routes it to the matching recipe by URL or forfeits it.
import { requireFilled, Blocked, FormChanged, captchaChallengeVisible, sleep } from '../lib/forms.mjs';

export const name = 'drushim';
export const match = url => /drushim\.co\.il\//i.test(url);
const MODALS = ['.ReactModal__Content--after-open', '.ReactModal__Content'];   // not [role=dialog]: the page carries a hidden accessibility-toolbar dialog
const MODAL = MODALS.join(', ');
const within = (...sels) => MODALS.flatMap(m => sels.map(s => `${m} ${s}`)).join(', ');
// Success modal verified live 20 Oct 2026 (Monarch): "עבודה טובה! הגשת מועמדות למשרה", and the job card flips to "הוגשה". The application
// then shows under drushim.co.il/personal/applications (tab "בתהליך").
const SUCCESS = /עבודה טובה|הגשת מועמדות למשרה(?! זו)|המועמדות נשלחה|קורות החיים נשלחו|נשלח(ה|ו)? בהצלחה|הגשת המועמדות הושלמה|application sent|sent successfully/i;

// The home page shows the profile menu even after the session died (20 Oct 2026: "logged in" on the home page, login box inside the apply
// dialog). The only reliable check is the dialog itself: open a posting, click apply, look for the login form, close the dialog. Nothing is sent.
const LOGIN_BOX = /להתחבר עם|שכחתי סיסמה|טוב שחזרת|לא נרשמת עדיין/;
export async function loggedIn(page) {
  await page.goto('https://www.drushim.co.il/jobs/search/product%20manager/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(2500);
  const href = await page.evaluate(() => { const a = [...document.querySelectorAll('a[href^="/job/"]')][0]; return a ? a.getAttribute('href') : ''; }).catch(() => '');
  if (!href) return true;   // no posting to probe with: let the per-card check decide
  await page.goto('https://www.drushim.co.il' + href, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(2500);
  const btn = page.locator('button[class*="apply-button"]').first();
  if (!(await btn.count())) return true;
  await btn.click().catch(() => {});
  const modal = page.locator(MODAL).first();
  await modal.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  await sleep(1200);
  const txt = await modal.innerText().catch(() => '');
  const out = !(await page.locator(within('input[type=password]')).count()) && !LOGIN_BOX.test(txt);
  await page.keyboard.press('Escape').catch(() => {});
  return out;
}

// A removed posting answers HTTP 410 with "מצטערים, לא הצלחנו למצוא את הפעם את מה שחיפשת" and no apply button (Oscorp, 23 Oct 2026, reported as
// "apply button not found"): report it as stale so the leak count says what happened; nothing to re-queue.
const GONE = /לא הצלחנו למצוא|המשרה אינה פעילה|המשרה הוסרה|משרה זו אינה קיימת/;
export async function open(page, card) {
  const resp = await page.goto(card.apply.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  const status = resp ? resp.status() : 0;
  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (status === 410 || status === 404 || (GONE.test(bodyText) && !(await page.locator('button[class*="apply-button"]').count()))) throw Object.assign(new FormChanged(`posting is gone from Drushim (HTTP ${status || '200'}, not-found page)`), { kind: 'stale' });
  // external apply: the posting hands off to the company's own site (externalApplyUrl in __NEXT_DATA__)
  const ext = await page.evaluate(() => { const nd = document.getElementById('__NEXT_DATA__'); const m = nd && nd.textContent.match(/"externalApplyUrl":"([^"]+)"/); return m ? m[1].replace(/\\u002F/g, '/') : ''; }).catch(() => '');
  if (ext) throw Object.assign(new FormChanged(`external apply on the company site: ${ext}`), { kind: 'external', href: ext });
  const btn = page.locator('button[class*="apply-button"]').first();
  if (!(await btn.count())) throw new FormChanged('apply button (apply-button) not found on the Drushim posting');
  await btn.click();
  const modal = page.locator(MODAL).first();
  await modal.waitFor({ state: 'visible', timeout: 15000 });
  await sleep(1500);
  const txt = await modal.innerText().catch(() => '');
  // a login form inside the modal = the runner profile lost its Drushim session: nothing to send, card back to the queue, Eyal signs in once
  if (await page.locator(within('input[type=password]')).count() || LOGIN_BOX.test(txt)) throw Object.assign(new Error('runner Chrome is logged out of Drushim - run start-chrome.cmd and sign in once'), { kind: 'release', loggedOut: true });
  if (/כבר הגשת|כבר נשלח/.test(txt)) throw new FormChanged('Drushim says the CV was already sent to this posting');
  return page.mainFrame();
}
export async function fill(scope, card, profile, log) {
  const modal = scope.locator(MODAL).first();
  const txt = await modal.innerText().catch(() => '');
  if (/שנות ניסיון\*\s*-\s*לא צוין/.test(txt)) throw new FormChanged('Drushim profile is missing the required "years of experience" - set it once on the profile');
  log('drushim: identity comes from the logged-in profile');
}
// The dialog lists the CVs stored on the profile as radios (input[name=apply-cv]) inside li[data-nagish="apply-flow-cv-item"], NEWEST FIRST.
// Drushim keeps at most 4 CVs per profile: the 04:00 tick on 21 Oct 2026 (Vandelay) hit "הגעת למגבלת העלאת קורות החיים שלך (4)", the upload
// was refused and the submit click timed out behind the error box. Every stored CV is this worker's own upload of a CV tailored for an
// earlier posting, so the recipe clears them all first (each row has a menu, aria-label "פעולות על <file>", with "מחיקה"), then uploads,
// then selects the radio that was not there before (never a stale one: the old fallback "select the last stored CV" sent the wrong file).
const CV_ROWS = 'li[data-nagish="apply-flow-cv-item"]';
const CV_LIMIT = /הגעת למגבלת העלאת קורות החיים|אפשר לשמור עד \d+ קורות חיים/;
export async function clearStoredCvs(page, log = () => {}) {
  const rows = page.locator(within(CV_ROWS));
  let cleared = 0, n = await rows.count();
  for (let i = 0; i < 8 && n > 0; i++) {
    const row = rows.last();   // oldest is listed last
    const trig = row.locator('button[class*="trigger"]').first();
    if (!(await trig.count())) { log(`drushim: stored CV row has no menu (${n} left), leaving it`); break; }
    await trig.click({ force: true }).catch(() => {}); await sleep(700);
    const del = row.locator('button:has-text("מחיקה")').first();
    if (!(await del.count())) { log(`drushim: no "מחיקה" in the CV row menu (${n} left), leaving it`); await page.keyboard.press('Escape').catch(() => {}); break; }
    await del.click({ force: true }).catch(() => {});
    const t0 = Date.now(); let gone = false;
    while (Date.now() - t0 < 12000) {
      await sleep(700);
      if (await rows.count() < n) { gone = true; break; }
      // a confirm box, if Drushim adds one: a visible button saying delete/confirm that is not a row-menu item
      const confirm = page.locator('button:visible').filter({ hasText: /^(מחיקה|מחק|אישור|כן)/ }).filter({ hasNot: page.locator('[class*="item"]') }).last();
      if (Date.now() - t0 > 2500 && await confirm.count() && !(await confirm.getAttribute('class').catch(() => '') || '').includes('item')) await confirm.click({ force: true }).catch(() => {});
    }
    if (!gone) { log(`drushim: delete of a stored CV did not take within 12 s (${n} left)`); break; }
    cleared++; n = await rows.count();
  }
  if (cleared) log(`drushim: cleared ${cleared} stored CV${cleared === 1 ? '' : 's'} from the profile (this worker's uploads for earlier postings), ${n} left`);
  return { cleared, left: n };
}
export async function attachCv(scope, page, pdf, log = () => {}) {
  const input = page.locator(within('input[type=file]')).first();
  if (!(await input.count())) throw new FormChanged('no CV upload in the Drushim dialog');
  const radios = page.locator(within('input[name=apply-cv]'));
  const st = await clearStoredCvs(page, log);
  if (st.left >= 4) throw new FormChanged(`Drushim profile holds ${st.left} CVs (limit 4) and the recipe could not delete any: the upload would be refused`);
  const before = new Set(await radios.evaluateAll(els => els.map(e => e.value)));
  await input.setInputFiles(pdf);
  const t0 = Date.now(); let fresh = null;
  while (Date.now() - t0 < 30000 && !fresh) {
    await sleep(1000);
    const vals = await radios.evaluateAll(els => els.map(e => e.value)).catch(() => []);
    fresh = vals.find(v => !before.has(v)) || null;
    if (!fresh) { const txt = await scope.locator(MODAL).first().innerText().catch(() => ''); if (CV_LIMIT.test(txt)) throw new FormChanged(`Drushim refused the upload: ${(txt.match(CV_LIMIT) || [''])[0]}`); }
  }
  if (!fresh) throw new FormChanged('CV upload did not register in the Drushim dialog within 30 s (not sending a stale stored CV instead)');
  const pick = page.locator(within(`input[name=apply-cv][value="${fresh}"]`)).first();
  await pick.check({ force: true }).catch(() => {});
  if (!(await pick.isChecked().catch(() => false))) throw new FormChanged('the freshly uploaded CV could not be selected in the Drushim dialog');
  const submit = page.locator(within('button:has-text("הגשת מועמדות")')).first();
  const t1 = Date.now(); let ok = false;
  while (Date.now() - t1 < 15000) { if (await submit.isEnabled().catch(() => false)) { ok = true; break; } await sleep(500); }
  if (!ok) throw new FormChanged('CV attached and selected but the Drushim submit button stayed disabled');
  return `dialog upload (tailored CV, selected${st.cleared ? `, ${st.cleared} old stored CV${st.cleared === 1 ? '' : 's'} deleted first` : ''})`;
}
export async function screeners(scope, card, log) {
  // the only control besides the CV is the "send my CV to more matching jobs" checkbox: ON since 25 Oct 2026 (Eyal: "always allow it,
  // it is just another generator of maybe interviews"; it was kept off before)
  const cb = scope.locator(within('input[type=checkbox]')).first();
  if (await cb.count() && !(await cb.isChecked().catch(() => true))) { await cb.check({ force: true }).catch(() => {}); if (!(await cb.isChecked().catch(() => false))) await cb.dispatchEvent('click').catch(() => {}); log(`drushim: more-jobs opt-in ${await cb.isChecked().catch(() => false) ? 'checked' : 'did NOT stick'}`); }
  const q = scope.locator(within('select', 'input[type=radio]:not([name=apply-cv])', 'textarea'));
  if (await q.count()) throw new FormChanged(`Drushim dialog asks questions: ${(await q.first().innerText().catch(() => '?')).slice(0, 80)}`);
}
export async function gate(scope, log) { return requireFilled(scope, log, within('input')); }
export async function submit(scope, page) {
  const btn = page.locator(within('button:has-text("הגשת מועמדות")')).first();
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  await btn.click();
}
export async function confirmed(page, scope, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const txt = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    if (SUCCESS.test(txt)) { const m = txt.match(SUCCESS); return { ok: true, text: txt.slice(Math.max(0, m.index - 80), m.index + 160).replace(/\s+/g, ' ').trim() }; }
    if (await captchaChallengeVisible(page)) throw new Blocked('captcha', 'captcha challenge on Drushim');
    await sleep(1000);
  }
  return { ok: false };
}
export async function blocked(page) {
  if (await captchaChallengeVisible(page)) return 'captcha';
  if (/\/login|\/register|\/signin/i.test(page.url())) return 'login';
  return '';
}
