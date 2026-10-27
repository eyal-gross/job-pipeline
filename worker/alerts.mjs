// Alerts (25 Oct 2026, Eyal: "next time something like this happens I get notified"). The day hunt could not fire its agents for
// half a day and nobody told Eyal: the reviewer wrote it in the log only. This runs after every worker tick (detached, so the tick
// never waits on it), checks the few things that silently stop the loop, and for each NEW problem:
//   1. emails Eyal once (headless Claude Code, Gmail send only, to his own job-search inbox; a reminder after 24 h if still open)
//   2. shows a Windows notification on the PC
//   3. writes logs/alerts.json, which the worker relays to the board -> red "Needs you" banner on every page
// A problem that clears gets a short "resolved" line in the next email. Read-only on the board. Never prints a key.
//   node alerts.mjs            check + notify
//   node alerts.mjs --dry      check only, print what it would send
//   node alerts.mjs --test     send one test email + notification (proves the channel)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, ROOT } from './lib/board.mjs';

const LOGS = path.join(ROOT, 'logs');
const STATE = path.join(LOGS, 'alerts-state.json');   // { open: {id: {text, sev, since, emailedAt}}, resolved: [{id, text, at}] }
const OUT = path.join(LOGS, 'alerts.json');           // what the worker relays to the board
const LOCAL = path.join(LOGS, 'alerts-local.json');   // problems other PC scripts raise (deploy-board.mjs): { id: {text, sev, at} }
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const TO = process.env.ALERT_EMAIL || CFG.alertEmail;   // your own inbox
const CLAUDE = process.env.CLAUDE_CLI || 'claude';   // Claude Code CLI on PATH
const BOARD_URL = CFG.boardLive;   // one place for the board URL (moved 25 Oct 2026)
const CREDITS = path.join(LOGS, 'credits.json');   // reviewer/credits.mjs; refreshed here when older than 3 h
const H = 3600000, DAY = 24 * H;
const flags = new Set(process.argv.slice(2));
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const ago = t => t ? Date.now() - Date.parse(t) : Infinity;

export async function check() {
  const A = []; const add = (id, sev, text) => A.push({ id, sev, text });
  const { board: base, key } = loadConfig([], { defaultLive: true });
  let st = null, features = {};
  try { const r = await fetch(`${base}/.netlify/functions/state`, { headers: { 'x-key': key } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); const d = await r.json(); st = d.state; features = d.features || {}; }
  catch (e) { add('board-down', 'needs', `The board does not answer (${e.message}). The worker cannot claim or report; Netlify may have paused the site.`); }
  if (st) {
    const h = st.hunt || {}; const lr = h.lastRun || null;
    if (features.huntWorker === false) add('agents-off', 'needs', 'The live board has no ROUTINE_TOKEN: it cannot start the sorter, grader or preparer. New roles will sit ungraded.');
    else if (lr && (lr.errors || []).some(e => /routine not configured/i.test(e)) && !(st.companies || []).some(c => c.hunt && c.hunt.status === 'done' && c.hunt.firedAt > lr.at))   // an agent finished after that run: fixed since add('agents-off', 'needs', 'The last hunt could not start its agents ("routine not configured"). New roles sit ungraded until it is fixed.');
    if (!lr || ago(lr.at) > 14 * H) add('hunt-missed', 'needs', `The hunt has not run for ${lr ? Math.round(ago(lr.at) / H) + ' hours' : 'ever'} (it runs at 01:00 and 11:00 UTC).`);
    const stuck = (st.companies || []).filter(c => c.hunt && ['candidate', 'grading', 'graded', 'preparing'].includes(c.hunt.status) && ago(c.hunt.firedAt || c.hunt.foundAt) > 3 * H);
    const stuckRoles = (st.roles || []).filter(r => r.apply && r.apply.status === 'candidate' && ago(r.apply.foundAt) > 3 * H);
    const nStuck = Math.max(stuck.length, stuckRoles.length);
    if (nStuck) add('stuck-candidates', 'needs', `${nStuck} new role${nStuck === 1 ? '' : 's'} stuck ungraded for over 3 hours (${stuckRoles.slice(0, 4).map(r => (st.companies.find(c => c.id === r.companyId) || {}).name).filter(Boolean).join(', ')}).`);
    const ml = st.mail && st.mail.lastRun; if (!ml || ago(ml.at) > 26 * H) add('mail-silent', 'needs', `The mail clerk has not run for ${ml ? Math.round(ago(ml.at) / H) + ' hours' : 'ever'}: receipts and replies are not being read.`);
    if (h.killSwitch) add('kill-switch', 'needs', 'The kill switch is on: nothing is hunted or sent.');
    const interviews = (st.roles || []).filter(r => r.apply && (r.apply.submittedAt || r.apply.status === 'confirmed') && (r.stage === 'interviewing' || r.screened));   // good news is news too: an interview on a card the loop sent (Eyal's own leads stay out)
    if (interviews.length) add(`interview-${interviews.map(r => r.id).sort().join('-')}`.slice(0, 80), 'good', `${interviews.length} role${interviews.length === 1 ? '' : 's'} at interview stage: ${interviews.slice(0, 4).map(r => (st.companies.find(c => c.id === r.companyId) || {}).name).join(', ')}. Open the board.`);
  }
  // what the scheduled reviewer says only Eyal can do (reviewer/state.json needsHuman: [{id, text}])
  const rv = read(path.join(ROOT, 'reviewer', 'state.json'), {});
  for (const n of Array.isArray(rv.needsHuman) ? rv.needsHuman : []) if (n && n.id && n.text) add(`rv-${String(n.id).slice(0, 40)}`, n.sev === 'info' ? 'info' : 'needs', String(n.text).slice(0, 300));
  if (rv.lastRunAt && ago(rv.lastRunAt) > 13 * H) add('reviewer-silent', 'needs', `The scheduled reviewer has not run for ${Math.round(ago(rv.lastRunAt) / H)} hours: check Task Scheduler (JobApplyReviewer).`);
  // Netlify credits (25 Oct 2026: the old account ran out and blocked every deploy): projected use at the reset
  let cr = read(CREDITS, null);
  if (!cr || ago(cr.at) > 3 * H) { try { const { budget } = await import('./reviewer/credits.mjs'); cr = await budget(); fs.writeFileSync(CREDITS, JSON.stringify(cr, null, 1)); } catch (e) { if (!cr) add('credits-unknown', 'info', `Credit budget could not be read: ${e.message}`); } }
  const EXACT_AT = path.join(LOGS, 'credits-exact-at.txt');   // a one-off failure (rate limit) is not news; 6 h without an exact read is
  if (cr && cr.exact) { try { fs.writeFileSync(EXACT_AT, cr.at); } catch { /* ignore */ } }
  const lastExact = (() => { try { return fs.readFileSync(EXACT_AT, 'utf8').trim(); } catch { return ''; } })();
  if (cr && cr.exact === false && ago(lastExact) > 6 * H) add('credits-estimate', 'needs', 'The exact Netlify credit reading failed (the dashboard endpoint changed?); the deploy gate is running on an estimate. Ask Claude Code to look at reviewer/credits.mjs.');
  if (cr) {
    if (cr.projected >= 0.85 * cr.budget) add('credits-85', 'needs', `Netlify credits: projected ${cr.projected} of ${cr.budget} by the reset on ${cr.resetAt.slice(0, 10)} (${cr.used} used). Deploys are frozen by the gate; decide: wait, or add credits.`);
    else if (cr.projected >= 0.7 * cr.budget) add('credits-70', 'needs', `Netlify credits: projected ${cr.projected} of ${cr.budget} by the reset on ${cr.resetAt.slice(0, 10)}. Fine for now, deploys slow down; no action needed unless it keeps climbing.`);
  }
  // supply growth (supply widening item 3, 26 Oct 2026): the reviewer owns it; Eyal hears when it stalls for two days or discover stops
  try {
    const { stalled, discoverStuck } = await import('./reviewer/supply-score.mjs');
    const hist = (() => { try { return fs.readFileSync(path.join(ROOT, 'reviewer', 'supply-history.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } })();
    const why = stalled(hist, new Date().toISOString().slice(0, 10));
    if (why) add('supply-stalled', 'needs', `Supply stopped growing: ${why}. The reviewer grows it by itself (discover + seeds); ask Claude Code to look at reviewer/discover-last.json and the supply brief.`);
    const stuck = discoverStuck(read(path.join(ROOT, 'reviewer', 'discover-state.json'), null));
    if (stuck) add('discover-stuck', 'needs', `Board discovery is stuck: ${stuck}. Ask Claude Code to run node worker/reviewer/discover.mjs by hand and read the error.`);
  } catch (e) { add('supply-check-broken', 'info', `The supply check could not run (${String(e.message).slice(0, 80)}).`); }
  // problems other PC scripts raised (deploy-board.mjs: Netlify refused a deploy)
  for (const [id, v] of Object.entries(read(LOCAL, {}))) if (v && v.text) add(id, v.sev || 'needs', v.text);
  return A;
}

function email(subject, body) {
  const prompt = `Send exactly one email with the Gmail send_message tool, then stop. Do nothing else: no other tool, no reading mail, no files.\nTo: ${TO}\nSubject: ${subject}\nBody (plain text, send it exactly as written between the markers):\n<<<BODY\n${body}\nBODY>>>\nReply with the word SENT when it went out, or FAILED and the error.`;
  const r = spawnSync(CLAUDE, ['-p', '--output-format', 'text', '--allowedTools', 'mcp__claude_ai_Gmail__send_message'], { input: prompt, encoding: 'utf8', timeout: 240000, shell: true, cwd: ROOT });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  return { ok: /\bSENT\b/.test(out) && !/FAILED/.test(out), out: out.slice(-300) };
}

function toast(title, text) {
  const esc = s => String(s).replace(/'/g, "''").replace(/[<>&]/g, ' ');
  const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; $x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $t = $x.GetElementsByTagName('text'); $t.Item(0).AppendChild($x.CreateTextNode('${esc(title)}')) > $null; $t.Item(1).AppendChild($x.CreateTextNode('${esc(text).slice(0, 220)}')) > $null; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Job Pipeline').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
  spawnSync('powershell', ['-NoProfile', '-Command', ps], { timeout: 20000 });
}

// --brief (25 Oct 2026, Eyal: "write it to you, so you will be aware of it the moment I open you"): a SessionStart hook in
// .claude/settings.local.json runs this, and its output lands in every new Claude Code session in the job search folder. No network, instant.
function brief() {
  const S = read(STATE, null), cr = read(CREDITS, null), out = [];
  const open = S ? Object.entries(S.open || {}).filter(([, v]) => v.sev !== 'info') : [];
  out.push(`APPLY LOOP STATUS for this session (from worker/alerts.mjs, last check ${S && S.at ? S.at.slice(0, 16).replace('T', ' ') + ' UTC' : 'never'}).`);
  if (S && S.at && ago(S.at) > 2 * H) out.push(`WARNING: the alert check has not run for ${Math.round(ago(S.at) / H)} h: the PC worker task may be off, so everything below may be stale.`);
  if (open.length) { out.push(`OPEN ALERTS (${open.length}) - tell the owner about these first, before anything else, in one short list:`); for (const [id, v] of open) out.push(`- [${v.sev}] ${v.text} (open since ${String(v.since || '').slice(0, 16).replace('T', ' ')} UTC, id ${id})`); }
  else out.push('No open alerts.');
  if ((S && S.resolved || []).length) out.push('Resolved, not yet emailed: ' + S.resolved.map(r => r.text).join(' | '));
  if (cr) out.push(`Netlify credits: ${cr.used} of ${cr.budget} used (${cr.exact ? 'exact' : 'ESTIMATE'}), projected ${cr.projected} at the reset ${String(cr.resetAt).slice(0, 10)}, ${cr.deploysLeft} deploys fit, next board deploy from ${String(cr.nextDeployAllowedAt).slice(0, 16).replace('T', ' ')} UTC.`);
  console.log(out.join(String.fromCharCode(10)));
}

async function main() {
  fs.mkdirSync(LOGS, { recursive: true });
  if (flags.has('--brief')) return brief();
  if (flags.has('--test')) {
    toast('Job Pipeline alerts: test', 'If you see this, PC notifications work.');
    const r = email('Job Pipeline: alert test', `This is a test of the new alert channel. When the apply loop hits something only you can fix, you get one email like this, a notification on the PC and a red "Needs you" banner on the board.\n\nNothing to do.\n${BOARD_URL}`);
    console.log(r.ok ? 'test email SENT' : `test email FAILED: ${r.out}`); process.exit(r.ok ? 0 : 1);
  }
  const now = new Date().toISOString();
  const found = await check();
  const S = read(STATE, { open: {}, resolved: [] });
  const cur = new Set(found.map(a => a.id));
  const resolved = Object.entries(S.open).filter(([id]) => !cur.has(id)).map(([id, v]) => ({ id, text: v.text, at: now }));
  for (const r of resolved) delete S.open[r.id];
  for (const a of found) S.open[a.id] = { ...(S.open[a.id] || { since: now, emailedAt: null }), text: a.text, sev: a.sev };
  const due = Object.entries(S.open).filter(([, v]) => v.sev !== 'info' && (!v.emailedAt || ago(v.emailedAt) > DAY));
  fs.writeFileSync(OUT, JSON.stringify({ at: now, alerts: Object.entries(S.open).map(([id, v]) => ({ id, sev: v.sev, text: v.text, since: v.since })) }, null, 1));
  if (flags.has('--dry')) { console.log(JSON.stringify({ open: S.open, due: due.map(d => d[0]), resolved }, null, 1)); return; }
  const newResolved = [...(S.resolved || []), ...resolved];
  if (due.length) {
    const needs = due.filter(([, v]) => v.sev === 'needs'), good = due.filter(([, v]) => v.sev === 'good');
    const subject = needs.length ? `Job Pipeline needs you: ${needs[0][1].text.slice(0, 70)}${needs.length > 1 ? ` (+${needs.length - 1})` : ''}` : `Job Pipeline: ${good[0][1].text.slice(0, 80)}`;
    const lines = due.map(([, v]) => `- ${v.text}${v.emailedAt ? ' (still open, reminder)' : ''}`);
    const body = `${needs.length ? 'The apply loop hit something only you can fix:' : 'News from the apply loop:'}\n\n${lines.join('\n')}${newResolved.length ? `\n\nResolved since the last email:\n${newResolved.map(r => `- ${r.text}`).join('\n')}` : ''}\n\nDetails: the red banner on the board, or ask Claude Code in the job search folder.\n${BOARD_URL}`;
    toast(needs.length ? 'Job Pipeline needs you' : 'Job Pipeline', due[0][1].text);
    const r = email(subject, body);
    if (r.ok) { for (const [id] of due) S.open[id].emailedAt = now; S.resolved = []; console.log(`emailed ${due.length} alert(s)`); }
    else { S.resolved = newResolved; console.log(`email FAILED, retry next tick: ${r.out}`); }
  } else { S.resolved = newResolved; console.log(`no new alerts (${Object.keys(S.open).length} open)`); }
  S.at = now; fs.writeFileSync(STATE, JSON.stringify(S, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
