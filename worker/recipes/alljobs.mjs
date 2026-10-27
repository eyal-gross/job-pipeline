// AllJobs (alljobs.co.il), "send CV" with Eyal's logged-in account in the runner Chrome. Verified live 20 Oct 2026 (Dunder Systems, Sterling);
// delete flow + reload confirmation fixed 20 Oct evening after the Massive Solutions / Dunder failures (see WORKER.md).
// How the site behaves:
//  - job page `Search/UploadSingle.aspx?JobID=<id>`: `a.send-cv-btn` ("הגשת מועמדות").
//  - NO CV stored on the profile -> the click opens the panel `#job-sendcv-form` (file input `#txtFileNew`, profile details, "הגש מועמדות");
//    the file attached there is sent AND becomes the stored profile CV.
//  - a CV stored on the profile -> the click SENDS INSTANTLY with that stored CV (popup "קורות החיים הועברו בהצלחה!"), no panel.
//  - after a send the job card reads "הגשת מועמדות למשרה זו בתאריך <date> בשעה <time>".
//  So, to send the tailored CV every time: before each job, delete every stored CV on `/User/UserCVsPanel/CVManagement.aspx`
//  (link "מחיקה" -> ConfirmDelete(id), a browser confirm we accept on a side page), then the panel opens and takes our file; after the
//  send the uploaded file is deleted again (cleanup) so the next job gets the panel too. If the click still sends instantly (a CV we did
//  not see), the worker records it as sent-on-open with the stored CV and says so.
//  The site shows a "Verifying your browser" interstitial on first navigation (JS check, waited out); a real CAPTCHA = blocked.
import { requireFilled, Blocked, FormChanged, captchaChallengeVisible, sleep } from '../lib/forms.mjs';

export const name = 'alljobs';
export const match = url => /alljobs\.co\.il\//i.test(url);
const PANELS = ['#job-sendcv-form', '#JobWithMailCtrl'];
const PANEL = PANELS.join(', ');
const within = (...sels) => PANELS.flatMap(p => sels.map(s => `${p} ${s}`)).join(', ');
const SENT = /קורות החיים הועברו בהצלחה|הגשת מועמדות למשרה זו בתאריך|קורות החיים נשלחו|נשלח(ה|ו)? בהצלחה|המועמדות נשלחה/;
const ALREADY = /הגשת מועמדות למשרה זו בתאריך/;
const CV_MGMT = 'https://www.alljobs.co.il/User/UserCVsPanel/CVManagement.aspx';

async function waitCheck(page, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const txt = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    if (!/Verifying your browser/i.test(txt)) return true;
    if (await captchaChallengeVisible(page)) throw new Blocked('captcha', 'AllJobs browser check turned into a captcha');
    await sleep(1500);
  }
  throw new Blocked('bot', 'AllJobs browser check did not clear');
}

export async function loggedIn(page) {
  await page.goto('https://www.alljobs.co.il/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await waitCheck(page).catch(() => {});
  await sleep(1500);
  // logged in = the account menu carries a log-off link (hidden inside the menu, so visibility is not checked); VIP "Register" links exist for everyone
  return (await page.locator('a[href*="LogOff" i], a:has-text("התנתק")').count()) > 0;
}

// Delete every CV stored on the profile (our own uploads) so the apply click opens the panel. Runs on a side page with its own
// dialog handler (the worker's page dismisses dialogs). Returns how many were deleted and how many are left.
export async function clearStoredCvs(page, log = () => {}) {
  const side = await page.context().newPage();
  side.on('dialog', d => d.accept().catch(() => {}));
  let deleted = 0;
  try {
    await side.goto(CV_MGMT, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitCheck(side); await sleep(1500);
    for (let i = 0; i < 6; i++) {
      const del = side.locator('a[onclick^="ConfirmDelete"]').first();
      if (!(await del.count())) break;
      const id = ((await del.getAttribute('onclick')) || '').match(/\d+/);
      await del.click(); await sleep(1500);
      // ConfirmDelete() opens the site's own confirm box (.Confirm) with a "yes" link in #divDeleteCV that calls DeleteCV(id) over ajax.
      // Verified 20 Oct 2026: the single-CV case gets the same box with a stronger warning, so the last CV can be deleted too.
      const yes = side.locator('#divDeleteCV a').first();
      if (!(await yes.count())) { log(`alljobs: delete confirm for CV ${id && id[0]} did not open`); break; }
      await yes.click({ force: true }).catch(() => {});
      const t0 = Date.now();   // wait for the ajax: the delete link for this id disappears from the list
      while (Date.now() - t0 < 15000 && await side.locator(`a[onclick*="ConfirmDelete('${id ? id[0] : 'x'}')"]`).count()) await sleep(500);
      await sleep(1000);
      await side.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await waitCheck(side).catch(() => {}); await sleep(1500);
      const still = await side.locator(`a[onclick*="ConfirmDelete('${id ? id[0] : 'x'}')"]`).count();
      if (still) { log(`alljobs: stored CV ${id && id[0]} did not delete`); break; }
      deleted++;
    }
    const left = await side.locator('a[onclick^="ConfirmDelete"]').count();
    log(`alljobs: stored CVs deleted ${deleted}, left ${left}`);
    return { deleted, left };
  } finally { await side.close().catch(() => {}); }
}

const CLOSED = /המשרה אינה פעילה|משרה זו אינה פעילה|המשרה נסגרה|המשרה לא נמצאה|המשרה הוסרה|לא נמצאה משרה/;
export async function open(page, card, log = () => {}, opts = {}) {
  const st = await clearStoredCvs(page, log);
  await page.goto(card.apply.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await waitCheck(page);
  await sleep(2000);
  const jobCard = page.locator('.job-content-top, [class*=job-content-top]').first();
  const cardText = await jobCard.innerText().catch(() => '');
  if (ALREADY.test(cardText)) throw new FormChanged(`AllJobs already has an application for this job: ${(cardText.match(/הגשת מועמדות למשרה זו בתאריך.{0,40}/) || [''])[0]}`);
  const bodyText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
  if (CLOSED.test(bodyText)) throw new FormChanged(`AllJobs says the posting is closed: ${(bodyText.match(CLOSED) || [''])[0]}`);
  const btn = page.locator('a.send-cv-btn, a:has-text("הגשת מועמדות")').first();
  if (!(await btn.count())) throw new FormChanged(`send-CV button (send-cv-btn) not found on the AllJobs job page (title "${(await page.title().catch(() => '')).slice(0, 60)}")`);
  // dry run: on AllJobs the first click can send by itself (a stored CV we could not remove), so a dry run stops here, before any click
  if (opts.dry) throw Object.assign(new Error(`dry run: send button found, ${st.left} stored CV${st.left === 1 ? '' : 's'} left on the profile, not clicking`), { kind: 'dry' });
  // the normal click sometimes hangs after "done scrolling" (Massive Solutions 20 Oct, probes the same evening): fall back to a forced click, then to the
  // element's own click() (the button is an Angular ng-click, ShowSendCVWithEdit(id))
  const how = await btn.click({ timeout: 6000 }).then(() => 'click').catch(() => null)
    || await btn.click({ timeout: 6000, force: true }).then(() => 'forced click').catch(() => null)
    || await page.evaluate(() => { const a = document.querySelector('a.send-cv-btn'); if (!a) return null; a.click(); return 'dom click'; }).catch(() => null);
  if (!how) throw new FormChanged('AllJobs send-CV button would not take a click (overlay or browser check in the way)');
  log(`alljobs: send button opened via ${how}`);
  const panel = page.locator(PANEL).first();
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (await panel.isVisible().catch(() => false)) break;
    const txt = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    if (SENT.test(txt)) {   // instant send with a stored CV we could not remove: report it honestly as sent
      const m = txt.match(SENT); const text = txt.slice(Math.max(0, m.index - 40), m.index + 160).replace(/\s+/g, ' ').trim();
      throw Object.assign(new Error(`sent on click with the stored profile CV (${st.left} stored): ${text}`), { kind: 'submitted-on-open', text });
    }
    await sleep(500);
  }
  if (!(await panel.isVisible().catch(() => false))) throw new FormChanged('AllJobs: neither the send panel nor a sent message appeared after the click');
  await sleep(1000);
  if (/Login|Register/i.test(page.url())) throw new Blocked('login', 'AllJobs asked to log in');
  return page.mainFrame();
}
export async function fill(scope, card, profile, log) {
  const txt = await scope.locator(PANEL).first().innerText().catch(() => '');
  if (!txt.includes(profile.email)) throw new FormChanged('AllJobs panel does not show the expected profile email');
  log('alljobs: identity comes from the logged-in profile');
}
// The panel has two modes, "send a CV file" (DisplayFileOrDetails(1)) and "details only" (2). Nothing is selected by default and the
// submit validator refuses with "יש לבחור אחת מהאפשרויות" until one is picked (Cyberdyne, 20 Oct 2026: two clicks sent nothing for this).
// Picking mode 1 slides #job-user-newcv open; the file input inside posts through the hidden #AjaxFile_form iframe on submit.
// Two panel variants (both seen live 21 Oct 2026): JobWithMailOrLidCtrl (Cyberdyne) has the mode choice; JobWithMailCtrl (Tyrell Team)
// has no choice, the file field is open from the start and the submit is SubmitForm(JobWithMailForm). Same file input, same fakepath label.
export async function attachCv(scope, page, pdf) {
  const mode = page.locator('#job-sendcv-form div[ng-click="DisplayFileOrDetails(1)"]').first();
  let variant = 'file-only panel (JobWithMailCtrl)';
  if (await mode.count()) {
    variant = 'mode panel (JobWithMailOrLidCtrl)';
    await mode.click({ timeout: 8000 }).catch(async () => { await mode.evaluate(e => e.click()); });
    await page.locator('#job-user-newcv').waitFor({ state: 'visible', timeout: 10000 }).catch(() => { throw new FormChanged('AllJobs panel: the CV upload box did not open after picking "send a CV file"'); });
  } else if (!(await page.locator('#job-user-newcv').isVisible().catch(() => false))) throw new FormChanged('AllJobs panel: neither the "send a CV file" option nor an open CV upload box');
  const input = page.locator('#txtFileNew, #job-sendcv-form input[type=file]').first();
  if (!(await input.count())) throw new FormChanged('no CV upload (#txtFileNew) in the AllJobs panel');
  await input.setInputFiles(pdf);
  await sleep(2000);
  const shown = await page.locator('#job-user-newcv .job-sendcv-field-fakpath').first().innerText().catch(() => '');
  if (!/\.pdf$/i.test(shown.trim())) throw new FormChanged(`AllJobs panel did not register the CV file (shows "${shown.trim().slice(0, 60)}")`);
  return `panel file input #txtFileNew (tailored CV, ${variant}, shows "${shown.trim().slice(0, 40)}")`;
}
export async function screeners(scope, card, log) {
  const q = scope.locator(within('select', 'input[type=radio]', 'input[type=checkbox]'));
  if (await q.count()) throw new FormChanged(`AllJobs panel asks questions: ${(await q.first().evaluate(e => e.outerHTML.slice(0, 80)).catch(() => '?'))}`);
}
export async function gate(scope, log) {
  const page = scope.page ? scope.page() : scope;
  const hasMode = await page.locator('#job-sendcv-lidfile').count().catch(() => 0);
  const picked = await page.locator('#job-sendcv-lidfile.job-sendcv-lidrd-active').count().catch(() => 0);
  if (hasMode && !picked) throw new FormChanged('AllJobs panel: "send a CV file" is not selected, the submit would be refused');
  return requireFilled(scope, log, '#txtFileNew');
}
export async function submit(scope, page) {
  const btn = page.locator(within('a:has-text("הגש מועמדות")', 'button:has-text("הגש מועמדות")', 'input[type=submit][value*="הגש"]')).last();
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  await btn.click();
}
// the panel submit uploads the PDF and posts over ajax: give it time. The worker uses confirmMs below instead of its default 30 s.
export const confirmMs = 75000;
export async function confirmed(page, scope, ms = 75000) {
  const t0 = Date.now(); let reloaded = false;
  const hit = txt => { const m = txt.match(SENT); return { ok: true, text: txt.slice(Math.max(0, m.index - 80), m.index + 160).replace(/\s+/g, ' ').trim() + (reloaded ? ' (seen after reload)' : '') }; };
  while (Date.now() - t0 < ms) {
    const txt = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    if (SENT.test(txt)) return hit(txt);
    if (await captchaChallengeVisible(page)) throw new Blocked('captcha', 'captcha challenge on AllJobs');
    // the panel submit does not always print a message (Dunder Systems, 20 Oct 2026: the card showed "הגשת מועמדות למשרה זו בתאריך" only
    // after a reload). Half way through the wait, reload the job page once and read the job card again.
    // reload only late (after 45 s): an early reload aborts the upload still in flight (Cyberdyne, 20 Oct 18:10: reload at 15 s, nothing was sent)
    if (!reloaded && Date.now() - t0 > Math.max(45000, ms * 0.6)) { reloaded = true; await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}); await waitCheck(page).catch(() => {}); await sleep(2000); continue; }
    await sleep(1000);
  }
  return { ok: false };
}
// after a card (any outcome): remove the CV the panel stored on the profile so the next job opens the panel again
export async function cleanup(page, log) { try { return await clearStoredCvs(page, log); } catch (e) { log(`alljobs cleanup failed: ${e.message}`); return null; } }
export async function blocked(page) {
  if (await captchaChallengeVisible(page)) return 'captcha';
  if (/Login|Register/i.test(page.url())) return 'login';
  return '';
}
