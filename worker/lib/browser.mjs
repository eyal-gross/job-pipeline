// Browser attach for the apply runner and the worker.
// Preferred: attach over CDP to the dedicated Chrome profile (real Chrome, Eyal logged into Google / Drushim / AllJobs there, no automation
// fingerprint). If nothing answers on 9222 the worker starts that same Chrome itself (same flags as start-chrome.cmd, window parked off
// screen) and closes it again when the tick ends. Chrome is never launched through Playwright's own launcher (different fingerprint).
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const PROFILE_DIR = process.env.APPLY_PROFILE || path.join(os.homedir(), 'apply-runner-profile');
export const CDP_URL = process.env.APPLY_CDP || 'http://127.0.0.1:9222';
export const CHROME_EXE = process.env.APPLY_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function cdpUp(ms = 1500) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(`${CDP_URL}/json/version`, { signal: c.signal }); return r.ok; } catch { return false; } finally { clearTimeout(t); }
}

// Start the runner Chrome exactly like start-chrome.cmd, plus: window parked off screen (not headless: same fingerprint as a visible run).
export function startChrome({ offscreen = true } = {}) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const args = [`--remote-debugging-port=${new URL(CDP_URL).port || 9222}`, `--user-data-dir=${PROFILE_DIR.replace(/\//g, '\\')}`, '--no-first-run', '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled', '--window-size=1280,900', ...(offscreen ? ['--window-position=-32000,-32000'] : []), 'about:blank'];
  const child = spawn(CHROME_EXE, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child.pid;
}

// keepOpen: leave Chrome running after close() even when we started it. Drushim's login died twice on 20 Oct within 40 min of a sign-in,
// both times after the runner Chrome had been closed and restarted, while a Chrome kept open stayed logged in for 74+ min (watch of 21 Oct).
// Session-scoped cookies (AllJobs .ASPXAUTH / ASP.NET_SessionId among them) die with every Chrome exit, so the worker keeps it running.
export async function attach({ allowLaunch = true, log = console.log, offscreen = true, waitMs = 20000, keepOpen = false } = {}) {
  let startedByMe = false, pid = 0;
  if (!(await cdpUp())) {
    if (!allowLaunch) throw new Error(`no Chrome at ${CDP_URL} (run start-chrome.cmd first)`);
    log(`no Chrome at ${CDP_URL}, starting the runner profile${offscreen ? ' off screen' : ''}`);
    pid = startChrome({ offscreen }); startedByMe = true;
    const t0 = Date.now(); let up = false;
    while (Date.now() - t0 < waitMs) { if (await cdpUp()) { up = true; break; } await sleep(500); }
    if (!up) { try { process.kill(pid); } catch { /* already gone */ } throw new Error(`Chrome did not answer on ${CDP_URL} within ${waitMs / 1000}s (profile busy in another Chrome window?)`); }
  }
  const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 5000 });
  const ctx = browser.contexts()[0] || (await browser.newContext());
  log(`attached over CDP at ${CDP_URL}${startedByMe ? ` (started it, pid ${pid})` : ' (already running)'}`);
  // graceful shutdown when we started Chrome: Browser.close over CDP lets Chrome flush cookies and storage (a kill loses session logins);
  // the kill is only the fallback if Chrome does not exit within 8 s
  const close = async () => {
    if (startedByMe && !keepOpen) {
      try { const s = await browser.newBrowserCDPSession(); await s.send('Browser.close'); } catch { /* fall back to kill */ }
      const t0 = Date.now(); while (Date.now() - t0 < 8000 && await cdpUp(500)) await sleep(300);
      if (await cdpUp(500) && pid) { try { process.kill(pid); } catch { /* gone */ } }
    } else { try { await browser.close(); } catch { /* disconnect only */ } }
  };
  return { browser, ctx, mode: 'cdp', startedByMe, pid, close };
}

// Count inputs in a frame tree, piercing open shadow roots.
export const COUNT_INPUTS_JS = `(() => {
  const out = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('input,select,textarea,button')) {
      const lab = el.labels && el.labels[0] ? el.labels[0].innerText : (el.getAttribute('aria-label') || el.placeholder || el.name || '');
      out.push({ tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', id: el.id || '', label: (lab||'').trim().slice(0,60), required: !!el.required, text: (el.innerText||'').trim().slice(0,40) });
    }
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
  };
  walk(document);
  return out;
})()`;
