// Generic form helpers shared by the recipes. Scope is a Page or a Frame.
import fs from 'node:fs';
export class FormChanged extends Error { constructor(m) { super(m); this.kind = 'changed-form'; } }
export class NeedsHuman extends Error { constructor(m) { super(m); this.kind = 'needs-human'; } }
export class Blocked extends Error { constructor(reason, m) { super(m || reason); this.kind = 'blocked'; this.reason = reason; } }
export class UploadFailed extends Error { constructor(m) { super(m); this.kind = 'upload'; } }

const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
// a question pattern that matches either quote style: the preparer types "Litware's", the form shows "Litware’s" (24 Oct 2026)
const quoteRe = s => escapeRe(s).replace(/['’‘`]/g, "['’‘`]").replace(/["“”]/g, '["“”]');
// observability hook: the worker sets it per card; every fill/pick/check reports {field, label, value, source, selector, kind}
export let onField = null;
export const setFieldHook = fn => { onField = fn; };
const report = rec => { try { if (onField) onField(rec); } catch { /* never break a fill */ } };
// page hook: a recipe that leaves a page of a multi-page form (SmartRecruiters "Next") calls pageDone() first, so the record keeps page 1
let onPage = null;
export const setPageHook = fn => { onPage = fn; };
export const pageDone = async scope => { try { if (onPage) await onPage(scope); } catch { /* never break a fill */ } };

// Fill the first visible, enabled match of the selectors; returns which one matched or ''.
export async function fillFirst(scope, selectors, value, { required = true, what = 'field', source = 'profile' } = {}) {
  for (const sel of selectors) {
    const loc = scope.locator(sel).first();
    try {
      if (await loc.count() && await loc.isVisible() && await loc.isEnabled()) { await loc.fill(''); await loc.fill(String(value)); report({ field: what, label: await loc.evaluate(el => (el.labels && el.labels[0] ? el.labels[0].innerText : el.getAttribute('aria-label') || el.placeholder || el.name || '').trim().slice(0, 100)).catch(() => ''), value, source, selector: sel, kind: 'text' }); return sel; }
    } catch (e) { /* try the next selector */ }
  }
  if (required) throw new FormChanged(`${what} not found (${selectors.join(' | ')})`);
  return '';
}

// Attach a file to the first file input (visible or hidden). Falls back to a filechooser around a button.
export async function attachFile(scope, page, pdf, { inputSelectors = ['input[type=file]'], buttonTexts = ['Attach', 'Upload', 'Resume', 'CV'] } = {}) {
  for (const sel of inputSelectors) {
    const loc = scope.locator(sel).first();
    if (await loc.count()) { try { await loc.setInputFiles(pdf); report({ field: 'resume', label: 'CV file', value: pdf, source: 'cv', selector: sel, kind: 'file' }); return `input ${sel}`; } catch (e) { /* fall through */ } }
  }
  for (const t of buttonTexts) {
    const btn = scope.locator(`button:has-text("${t}"), a:has-text("${t}"), label:has-text("${t}")`).first();
    if (await btn.count() && await btn.isVisible()) {
      try {
        const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), btn.click()]);
        await chooser.setFiles(pdf); report({ field: 'resume', label: 'CV file', value: pdf, source: 'cv', selector: `chooser:${t}`, kind: 'file' }); return `chooser ${t}`;
      } catch (e) { /* next */ }
    }
  }
  throw new UploadFailed('no file input or attach button found');
}

// Answer screener questions from card.apply.answers by matching the question text to a label/legend/text near a control.
// Unanswered required questions throw NeedsHuman. Unknown control shapes throw FormChanged. Nothing is ever guessed.
export async function answerScreeners(scope, card, log) {
  const a = card.apply || {}; const screeners = a.screeners || []; const answers = a.answers || {};
  const done = []; // normalized questions answered in this pass
  const doneQ = []; // { q, ans } of the same, for the short-twin check
  let otherResidence = false;   // a residence list without Israel: "Other" was picked, the "specify" box gets Israel after the loop
  for (const sq of screeners) {
    let ans = answers[sq.q];
    // country of residence is Israel (Eyal, 25 Oct 2026). Woodgrove went out as "Other" with the "specify" box empty: its list has no Israel at all.
    // So: Israel when the list offers it, else "Other" + Israel typed in the "If you selected Other, specify" box (after the loop).
    const nq0 = norm(sq.q);
    const residence = /\bcountr(y|ies)\b/.test(nq0) && /\b(reside|residence|resident|live|living|located|based|currently)\b|^country( of residence)?$/.test(nq0) && !/\b(authori[sz](ed|ation)|eligib\w*|visa|sponsor\w*|right to work|permit\w*|if you selected|evidence|identity)\b/.test(nq0);   // "authorization" + "evidence of your identity" (Litware, 27 Oct) are work-permit questions, not residence
    if (residence && ans && norm(ans) !== 'israel') { log(`country of residence: "${ans}" -> "Israel" for: ${sq.q.slice(0, 60)}`); ans = 'Israel'; }
    if (!ans) throw new NeedsHuman(`no answer for: ${sq.q}`);
    const q = norm(sq.q).slice(0, 60);
    // 1) a label / legend that STARTS with the question, then the nearest block around it that holds a control. A plain substring
    //    match picked the wrong question when one question's text contained another's ("Location" landed in "...our Tel Aviv office
    //    location three days a week?" on Adatum's Greenhouse form, 22 Oct: the typed city wiped the Yes and the gate refused).
    let block = await questionBlock(scope, q);
    if (!block) {
      // the preparer can list one question twice (the ATS API wording and the page wording, or a label cut at 80 chars; Adatum's
      // Greenhouse card, 22 Oct). A twin that is not on the form by its own wording is the same question, already answered: skip it.
      const nq = norm(sq.q); const twin = done.find(d => d.startsWith(nq) || nq.startsWith(d) || (nq.length >= 20 && d.slice(0, 20) === nq.slice(0, 20)) || (/\bconsent/.test(nq) && /\bconsent/.test(d)));
      if (twin) { log(`screener skipped, same question already answered: ${sq.q.slice(0, 50)}`); continue; }
      // a short summary twin of a long question ("Previously employed/applied" next to "Have you ever been employed by, applied to ...",
      // Proseware's Greenhouse card, 27 Oct): most of its content words (5-letter stems) are in one answered question with the same answer
      const stems = x => (norm(x).match(/[a-z]{4,}/g) || []).map(w => w.slice(0, 5));
      const sw = stems(sq.q);
      const summary = sw.length && sw.length <= 4 && doneQ.find(d => { const ds = new Set(stems(d.q)); const hit = sw.filter(w => ds.has(w)).length; return hit >= 2 && hit / sw.length >= 0.6 && norm(d.ans) === norm(ans); });
      if (summary) { log(`screener skipped, short twin of an answered question: ${sq.q.slice(0, 50)}`); continue; }
      // 2) fallback: the last block whose text contains the question (unlabeled questions, plain-text headings)
      //    Only a block that holds a control counts: the innermost text div matched before (Lever's div.text label, 22 Oct) and had nothing to fill.
      block = scope.locator(`fieldset, .field, .application-question, .question, div`).filter({ hasText: new RegExp(quoteRe(q.slice(0, 40)), 'i') }).filter({ has: scope.locator(CONTROLS) }).last();
    }
    if (!await block.count()) {
      // a standard identity field the preparer listed from the ATS API but the company's own page does not ask (Wingtip's join.wingtip.example
      // form, 23 Oct: "Location"): nothing to fill, skip it; the required-field gate still refuses anything really empty
      if (/^(current )?(location|city|country)( of residence)?$|^linkedin( profile)?( url)?$|^(phone|website)$/.test(norm(sq.q))) { log(`screener skipped, standard field not on this form: ${sq.q}`); continue; }
      throw new FormChanged(`screener not on the form: ${sq.q}`);
    }
    const radio = block.locator('input[type=radio]');
    const select = block.locator('select');
    const text = block.locator('input[type=text], input[type=number], input[type=url], textarea');
    if (await radio.count()) {
      const n = await radio.count(); let done = false;
      for (let i = 0; i < n; i++) {
        const r = radio.nth(i); const id = await r.getAttribute('id');
        // no label[for] (Workable, 26 Oct 2026): the option's own parent carries its text; never wait out the 30 s default on a missing label
        const lf = id ? block.locator(`label[for="${id}"]`).first() : null;
        const lab = lf && await lf.count() ? await lf.textContent({ timeout: 3000 }).catch(() => '') : await r.locator('xpath=..').textContent({ timeout: 3000 }).catch(() => '');
        if (norm(lab).startsWith(norm(ans)) || norm(lab) === norm(ans)) {
          // a styled React radio ignores a forced check (Workable, 26 Oct 2026): click the option's own label / parent, then verify
          try { await r.check({ force: true, timeout: 5000 }); } catch { await r.locator('xpath=..').click({ timeout: 5000 }); if (!(await r.isChecked().catch(() => false))) throw new FormChanged(`radio "${ans}" would not tick for: ${sq.q}`); }
          report({ field: sq.q, label: sq.q, value: ans, source: `card.answers:${sq.q.slice(0, 60)}`, selector: `radio:${id || i}`, kind: 'radio' }); done = true; break; }
      }
      if (!done) throw new FormChanged(`option "${ans}" not found for: ${sq.q}`);
    } else if (await select.count()) {
      try { await select.first().selectOption({ label: String(ans) }); report({ field: sq.q, label: sq.q, value: ans, source: `card.answers:${sq.q.slice(0, 60)}`, selector: 'select', kind: 'select' }); }
      catch {
        if (residence) { try { await select.first().selectOption({ label: 'Other' }); otherResidence = true; ans = 'Other'; log(`residence list has no Israel: picked Other for: ${sq.q.slice(0, 50)}`); report({ field: sq.q, label: sq.q, value: 'Other', source: 'rule:residence-other', selector: 'select', kind: 'select' }); } catch { throw new FormChanged(`neither Israel nor Other in select for: ${sq.q}`); } }
        else throw new FormChanged(`option "${ans}" not in select for: ${sq.q}`);
      }
    } else if (await text.count()) {
      const t = text.first(); await t.fill(String(ans)); report({ field: sq.q, label: sq.q, value: ans, source: `card.answers:${sq.q.slice(0, 60)}`, selector: 'text', kind: 'text' });
      // autocomplete (Greenhouse location, react-select): pick the first suggestion so the value really sticks
      if ((await t.getAttribute('role').catch(() => '')) === 'combobox' || await t.getAttribute('aria-autocomplete').catch(() => '')) {
        await sleep(1500);
        // the EXACT option, never just the first one (25 Oct 2026: typing "Male" listed "Female" first, and the old blind ArrowDown + Enter
        // took it). Exact text first, then the single option that starts with the answer; several candidates and none exact = refuse.
        const want = norm(ans);
        // read the list THIS input controls (aria-controls): Greenhouse pages also carry the phone picker's ~240 hidden country options,
        // which filled a capped generic scan (Woodgrove, 25 Oct 2026)
        const readOpts = async () => { const ctl = await t.getAttribute('aria-controls').catch(() => null); const opts = ctl ? scope.locator(`[id="${ctl}"] [role=option], [id="${ctl}"] [class*="option"]`) : scope.locator('[role=option]:not(.iti__country), [role=listbox]:not(.iti__country-list) li, [class*="option"]:not(.iti__country)'); const n = await opts.count().catch(() => 0); const out = []; for (let i = 0; i < Math.min(n, 80); i++) { const o = opts.nth(i); if (await o.isVisible().catch(() => false)) { const tx = norm(await o.innerText().catch(() => '')); if (tx && !/^no (options?|results?)( found)?$/.test(tx) && !out.some(x => x.t === tx)) out.push({ o, t: tx }); } } return out; };
        const place = /\b(location|city|address|town|where .* (live|located|based))\b/.test(norm(sq.q));   // places: "Tel Aviv" lists several "Tel Aviv..." rows, the first is right
        const choose = list => list.find(x => x.t === want) || (list.filter(x => x.t.startsWith(want)).length === 1 || place ? list.find(x => x.t.startsWith(want)) : null) || (place ? list.find(x => x.t.includes(want)) : null);
        // a multi-select answered with several values ("English, Hebrew", Litware's languages, 27 Oct): type and pick each one exactly
        //    the whole answer matches nothing, so each value is typed and picked exactly (a single select never gets here: its answer matches)
        let texts = await readOpts();
        if (!choose(texts)) { await t.press('ArrowDown').catch(() => {}); await sleep(800); texts = await readOpts(); }   // the menu was closed: open it, read again
        const parts = String(ans).split(/\s*[,|;]\s*/).filter(Boolean);
        const multi = parts.length > 1 && !place && !choose(texts);
        if (multi) {
          for (const p of parts) {
            const w = norm(p); const one = list => list.find(x => x.t === w) || (list.filter(x => x.t.startsWith(w)).length === 1 ? list.find(x => x.t.startsWith(w)) : null);
            await t.fill('').catch(() => {}); await t.pressSequentially(p, { delay: 40 }).catch(() => {}); await sleep(1200);
            let l = await readOpts(); if (!one(l)) { await t.press('ArrowDown').catch(() => {}); await sleep(800); l = await readOpts(); }
            const pk = one(l); if (!pk) throw new FormChanged(`no exact option "${p}" for: ${sq.q.slice(0, 60)} (shown: ${l.slice(0, 6).map(x => x.t).join(' | ')})`);
            await pk.o.click().catch(() => {}); log(`picked "${pk.t.slice(0, 40)}" for: ${sq.q.slice(0, 40)}`); await sleep(400);
          }
        }
        if (multi) texts = [];
        let pick = multi ? null : choose(texts);
        if (!pick && !multi && residence && want === 'israel') {   // the residence list has no Israel: Other, and Israel goes in the "specify" box
          await t.fill(''); await t.pressSequentially('Other', { delay: 40 }).catch(() => {}); await sleep(1200); texts = await readOpts();
          pick = texts.find(x => x.t === 'other') || null;
          if (pick) { otherResidence = true; log(`residence list has no Israel: picking Other for: ${sq.q.slice(0, 50)}`); }
        }
        if (pick) { await pick.o.click().catch(() => {}); log(`picked "${pick.t.slice(0, 40)}" for: ${sq.q.slice(0, 40)}`); }
        else if (texts.length) throw new FormChanged(`no exact option "${ans}" for: ${sq.q.slice(0, 60)} (shown: ${texts.slice(0, 6).map(x => x.t).join(' | ')})`);
        else if (!multi) { await t.press('Enter').catch(() => {}); log(`no option list appeared, kept the typed "${ans}" for: ${sq.q.slice(0, 40)}`); }   // free-text autocomplete (a city)
      }
    } else if (await block.locator('input[type=checkbox]').count()) {
      // "click all that apply" checkbox groups (Lucerne's Greenhouse form, 23 Oct): tick every answer value by its label, nothing else
      const boxes = block.locator('input[type=checkbox]'); const n = await boxes.count();
      for (const want of String(ans).split(/\s*[|;]\s*/).filter(Boolean)) {
        let hit = false;
        for (let i = 0; i < n; i++) {
          const c = boxes.nth(i); const id = await c.getAttribute('id');
          const lab = (id ? await block.locator(`label[for="${id}"]`).first().textContent().catch(() => '') : '') || await c.locator('xpath=..').textContent().catch(() => '');
          // a single consent box answered "Yes" (Trey's Comeet privacy checkbox, 27 Oct): the box itself is the yes
          const soleYes = n === 1 && /^(yes|i agree|agree|true)$/.test(norm(want));
          if (soleYes || norm(lab) === norm(want) || norm(lab).startsWith(norm(want))) {
            // React-controlled boxes ignore a forced check(): click the label (or the box), then verify it is ticked
            if (!await c.isChecked().catch(() => false)) { const l = id ? block.locator(`label[for="${id}"]`).first() : null; if (l && await l.count()) await l.click({ timeout: 5000 }).catch(() => {}); else await c.click({ force: true }).catch(() => {}); }
            if (!await c.isChecked().catch(() => false)) await c.dispatchEvent('click').catch(() => {});
            if (!await c.isChecked().catch(() => false)) throw new FormChanged(`checkbox "${want}" would not tick for: ${sq.q}`);
            hit = true; break;
          }
        }
        if (!hit) throw new FormChanged(`option "${want}" not found for: ${sq.q}`);
      }
      report({ field: sq.q, label: sq.q, value: ans, source: `card.answers:${sq.q.slice(0, 60)}`, selector: 'checkbox', kind: 'checkbox' });
    } else throw new FormChanged(`unknown control for: ${sq.q}`);
    log(`screener answered: ${sq.q.slice(0, 50)} -> ${ans}`);
    done.push(norm(sq.q)); doneQ.push({ q: sq.q, ans });
  }
  if (otherResidence) {
    const spec = scope.locator('label, legend').filter({ hasText: /selected\s+["“”']?other["“”']?.*(specify|country|residen)/i }).first();
    const id = await spec.getAttribute('for').catch(() => null);
    const box = id ? scope.locator(`[id="${id}"]`) : spec.locator('xpath=following::input[1] | following::textarea[1]').first();
    if (await box.count().catch(() => 0)) { await box.fill('Israel'); log('residence: typed Israel in the "If you selected Other, specify" box'); report({ field: 'Other country of residence', label: 'If you selected Other, specify your country of residence', value: 'Israel', source: 'rule:residence-other', selector: 'text', kind: 'text' }); }
    else log('residence: picked Other, but found no "specify" box to type Israel in');
  }
}

// Voluntary demographic fields (answer bank "Demographics", Eyal 25 Oct 2026): a REQUIRED one would otherwise stop the form (Bluth x2,
// 24 Oct). Gender -> config.local.json `gender` (no value = the decline option); race / ethnicity / veteran / disability / orientation -> the
// decline option; the demographic-data consent box is ticked only when the form requires it. Optional ones are left alone. Exact option
// picking, never the first suggestion.
const GENDER = (() => { try { return norm(JSON.parse(fs.readFileSync(new URL('../config.local.json', import.meta.url), 'utf8')).gender); } catch { return ''; } })();
const SYN = { male: ['male', 'man'], female: ['female', 'woman'] };
export async function answerDemographics(scope, log = () => {}) {
  const DECLINE = /(decline|prefer not|don.?t wish|do not wish|not to (answer|say|disclose)|choose not)/;
  const isGender = t => GENDER ? (SYN[GENDER] || [GENDER]).includes(t) : DECLINE.test(t);
  const labels = scope.locator('label, legend');
  const n = await labels.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 120); i++) {
    const lab = labels.nth(i); const raw = await lab.innerText().catch(() => ''); const text = norm(raw);
    const kind = /^gender/.test(text) ? 'gender' : /^(race|ethnicity|are you hispanic|veteran|protected veteran|disability|sexual orientation)/.test(text) ? 'decline' : null;
    if (!kind) continue;
    const id = await lab.getAttribute('for').catch(() => null);
    const ctl = id ? scope.locator(`[id="${id}"]`) : lab.locator('xpath=following::*[self::select or self::input][1]');
    if (!(await ctl.count().catch(() => 0))) continue;
    const req = (await ctl.getAttribute('aria-required').catch(() => null)) === 'true' || (await ctl.getAttribute('required').catch(() => null)) !== null || /\*\s*$/.test(raw);
    if (!req) continue;
    const tag = await ctl.evaluate(e => e.tagName.toLowerCase()).catch(() => '');
    if (tag === 'select') {
      const opts = (await ctl.locator('option').allInnerTexts().catch(() => [])).map(o => o.trim());
      const pick = kind === 'gender' ? opts.find(o => isGender(norm(o))) : opts.find(o => DECLINE.test(norm(o)));
      if (pick) { await ctl.selectOption({ label: pick }).catch(() => {}); log(`demographics: ${text.slice(0, 30)} -> ${pick}`); report({ field: text, label: text, value: pick, source: 'rule:demographics', selector: 'select', kind: 'select' }); }
      continue;
    }
    // react-select combobox: open it, read the options it controls, click the exact one
    await ctl.click().catch(() => {}); await sleep(600);
    const listId = await ctl.getAttribute('aria-controls').catch(() => null);
    const opts = listId ? scope.locator(`[id="${listId}"] [role=option]`) : scope.locator('[role=option]:not(.iti__country)');
    const m = await opts.count().catch(() => 0); let hit = null;
    for (let k = 0; k < Math.min(m, 40); k++) { const o = opts.nth(k); const t = norm(await o.innerText().catch(() => '')); if (kind === 'gender' ? isGender(t) : DECLINE.test(t)) { hit = { o, t }; break; } }
    if (hit) { await hit.o.click().catch(() => {}); log(`demographics: ${text.slice(0, 30)} -> ${hit.t}`); report({ field: text, label: text, value: hit.t, source: 'rule:demographics', selector: 'combobox', kind: 'select' }); }
    else { await ctl.press('Escape').catch(() => {}); log(`demographics: no ${kind === 'gender' ? (GENDER || 'decline') : 'decline'} option for ${text.slice(0, 40)}`); }
  }
  // the demographic-data consent box, only when required
  const boxes = scope.locator('input[type=checkbox]');
  const b = await boxes.count().catch(() => 0);
  for (let i = 0; i < Math.min(b, 30); i++) {
    const c = boxes.nth(i); const id = await c.getAttribute('id').catch(() => null); const name = (await c.getAttribute('name').catch(() => '')) || '';
    const lab = norm((id ? await scope.locator(`label[for="${id}"]`).first().innerText().catch(() => '') : '') || await c.locator('xpath=..').innerText().catch(() => ''));
    const req = (await c.getAttribute('required').catch(() => null)) !== null || (await c.getAttribute('aria-required').catch(() => null)) === 'true';
    const hay = lab + ' ' + name.toLowerCase();
    if (!req || !/demographic/.test(hay) || !/consent/.test(hay)) continue;
    if (!(await c.isChecked().catch(() => false))) { const l = id ? scope.locator(`label[for="${id}"]`).first() : null; if (l && await l.count()) await l.click().catch(() => {}); else await c.click({ force: true }).catch(() => {}); }
    if (await c.isChecked().catch(() => false)) { log('demographics: required demographic-data consent ticked'); report({ field: 'demographic consent', label: lab.slice(0, 100), value: 'on', source: 'rule:demographics', selector: 'checkbox', kind: 'checkbox' }); }
  }
}

const CONTROLS = 'input[type=radio], input[type=checkbox], select, input[type=text], input[type=number], input[type=url], input[type=email], input[type=tel], textarea';
async function questionBlock(scope, q) {
  const heads = scope.locator('label, legend, .application-label').filter({ hasText: new RegExp('^\\s*' + quoteRe(q.slice(0, 40)), 'i') });
  const n = await heads.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const h = heads.nth(i);
    // a label that wraps its own control (Lever: <label><div>Current location</div><input></label>) is the block itself; walking up from it
    // reached the whole form and the first text input was Full name (Stark, 26 Oct 2026)
    if (await h.evaluate(el => el.tagName === 'LABEL').catch(() => false) && await h.locator(CONTROLS).count().catch(() => 0)) return h;
    for (let up = 1; up <= 4; up++) {
      const b = h.locator(`xpath=ancestor::*[self::fieldset or self::div][${up}]`);
      if (!await b.count().catch(() => 0)) break;
      if (await b.locator(CONTROLS).count().catch(() => 0)) return b;
    }
  }
  return null;
}

// Required fields still empty after filling = the form asks for something we do not know. The gate before every Submit click:
// the worker throws FormChanged with the labels and never sends a half-filled form.
export async function emptyRequired(scope, within = '') {
  return scope.evaluate((within) => {
    const out = [];
    const anchor = within ? document.querySelector(within) : null;
    const root = (anchor && anchor.closest('form, [role=dialog], .modal, [class*="modal" i]')) || document;
    const visible = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return (r.width > 0 || r.height > 0) && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    for (const el of root.querySelectorAll('input[required], select[required], textarea[required], [aria-required="true"]')) {
      if (el.type === 'hidden' || el.type === 'file') continue;
      if (!visible(el) && el.type !== 'checkbox' && el.type !== 'radio') continue;
      // not a form control (a div / section with aria-required, e.g. the new Greenhouse "div.file-upload" around the resume input, 22 Oct):
      // judge it by what it wraps: a file input with a file (or a file name shown), or editable text. Nothing else can be "empty".
      if (!/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
        const fi = el.querySelector('input[type=file]');
        const nearLab = el.querySelector('label, legend') || (el.closest('div, fieldset') || el).querySelector('label, legend');
        const name = (el.getAttribute('aria-label') || (nearLab && nearLab.innerText) || `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''}`).trim().slice(0, 60);
        if (fi) { if (!(fi.files && fi.files.length) && !/\.(pdf|docx?|rtf|txt)\b/i.test(el.textContent || '')) out.push(name || 'file upload'); continue; }
        if (el.isContentEditable && !(el.textContent || '').trim()) out.push(name || 'unlabeled field');
        continue;
      }
      // react-select style combobox: the search input stays empty while the chosen value is rendered next to it
      if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete')) { let n = el, chosen = false; for (let i = 0; i < 6 && n; i++, n = n.parentElement) { if (n.querySelector('[class*="single-value"], [class*="singleValue"], [class*="multi-value"], [class*="multiValue"], [class*="selected"]')) { chosen = true; break; } } if (chosen) continue; }   // multi-select renders multi-value chips (Wayne "How did you hear", 23 Oct)
      if (el.type === 'checkbox' || el.type === 'radio') { const grp = el.name ? document.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`) : [el]; if (![...grp].some(x => x.checked)) out.push(el.name || el.id || 'checkbox'); continue; }
      if (!String(el.value || '').trim()) {
        // name the field: its label, else aria / placeholder / name / id, else the nearest label above it (react-select inputs carry none), else tag#id
        const near = el.closest('div, fieldset'); const nearLab = near && near.querySelector('label, legend');
        const lab = el.labels && el.labels[0] ? el.labels[0].innerText : (el.getAttribute('aria-label') || el.placeholder || el.name || el.id || (nearLab && nearLab.innerText) || `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''}`);
        out.push(String(lab).replace(/\s+/g, ' ').replace(/\s*[*✱]\s*$/, '').trim().slice(0, 60) || 'unlabeled field');   // (the reviewer's 12:04 edit had lost the backslashes: /s+/ would have eaten every "s")
      }
    }
    return [...new Set(out)];
  }, within).catch(() => []);
}
// `within`: a selector inside the application form; the gate then checks only that form (company pages carry other forms too)
export async function requireFilled(scope, log, within = '') {
  const missing = await emptyRequired(scope, within);
  if (missing.length) throw new FormChanged(`required fields still empty: ${missing.join(', ')}`);
  log('required-field gate passed');
}

export async function captchaChallengeVisible(page) {
  for (const f of page.frames()) {
    const u = f.url();
    if (/recaptcha\/api2\/bframe|recaptcha\/enterprise\/bframe|hcaptcha\.com\/.*frame=challenge|challenges\.cloudflare\.com|arkoselabs/.test(u)) {
      try { const el = await f.frameElement(); if (el && await el.isVisible()) { const box = await el.boundingBox(); if (box && box.width > 100 && box.height > 100) return true; } } catch { /* ignore */ }
    }
  }
  return false;
}
// A login wall: the page itself is a login page, or a password field is visible in the main content (a hidden header login form does not count).
export async function loginWall(page) {
  if (/\/(login|signin|sign-in|auth|sso|account\/create)\b/i.test(page.url())) return true;
  try { const pw = page.locator('input[type=password]'); const n = await pw.count(); for (let i = 0; i < n; i++) if (await pw.nth(i).isVisible()) return true; } catch { /* ignore */ }
  return false;
}

export const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const sleep = ms => new Promise(r => setTimeout(r, ms));
