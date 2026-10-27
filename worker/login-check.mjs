// Login check for the runner Chrome profile: Google, Drushim, AllJobs. Opens nothing but the home pages, sends nothing.
// Usage: node login-check.mjs [--alljobs-cvs]   (--alljobs-cvs also lists the CVs stored on the AllJobs profile, read-only)
// Exit code 1 when any site is logged out, so a scheduled check can alert.
import { attach } from './lib/browser.mjs';
import * as drushim from './recipes/drushim.mjs';
import * as alljobs from './recipes/alljobs.mjs';

const flags = Object.fromEntries(process.argv.slice(2).map(a => [a.replace(/^--/, ''), true]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { ctx, close } = await attach({ log: m => console.log(m), offscreen: true });
const out = {};
const check = async (name, fn) => { const p = await ctx.newPage(); try { out[name] = await fn(p); } catch (e) { out[name] = `error: ${e.message}`; } await p.close().catch(() => {}); console.log(`${name}: ${out[name] === true ? 'logged in' : out[name] === false ? 'NOT logged in' : out[name]}`); };
await check('google', async p => { await p.goto('https://mail.google.com/mail/u/0/', { waitUntil: 'domcontentloaded', timeout: 30000 }); await sleep(2500); return !/accounts\.google\.com|\/signin|ServiceLogin|workspace\.google\.com/.test(p.url()); });
await check('drushim', p => drushim.loggedIn(p));
await check('alljobs', p => alljobs.loggedIn(p));
if (flags['alljobs-cvs']) {
  const p = await ctx.newPage();
  try {
    await p.goto('https://www.alljobs.co.il/User/UserCVsPanel/CVManagement.aspx', { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 20; i++) { await sleep(1500); const t = await p.evaluate(() => document.body ? document.body.innerText : '').catch(() => 'Verifying'); if (!/Verifying your browser/i.test(t)) break; }
    await sleep(2000);
    const info = await p.evaluate(() => {
      const links = [...document.querySelectorAll('a[onclick*="ConfirmDelete"], a[href*="Delete"], a:not([href=""])')].filter(a => /ConfirmDelete|מחיקה|Delete/i.test(a.outerHTML)).map(a => a.outerHTML.slice(0, 200));
      const rows = [...document.querySelectorAll('tr, .cv-row, [class*=cv]')].map(r => (r.innerText || '').replace(/\s+/g, ' ').trim()).filter(t => t && t.length < 200).slice(0, 15);
      const fn = typeof ConfirmDelete === 'function' ? ConfirmDelete.toString().slice(0, 400) : 'no ConfirmDelete function';
      return { url: location.href, title: document.title, links, rows, fn, text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 600) };
    });
    console.log('alljobs CV page:', JSON.stringify(info, null, 1));
    await p.screenshot({ path: 'logs/alljobs-cvs.png', fullPage: true }).catch(() => {});
  } catch (e) { console.log('alljobs CV page: error', e.message); }
  await p.close().catch(() => {});
}
await close();
process.exit(Object.values(out).every(v => v === true) ? 0 : 1);
