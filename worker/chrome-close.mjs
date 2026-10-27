// Close the runner Chrome gracefully over CDP (Browser.close flushes cookies and storage; never kill it, logins get lost).
//   node chrome-close.mjs
import { chromium } from 'playwright';
import { CDP_URL, cdpUp } from './lib/browser.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
if (!(await cdpUp())) { console.log('no Chrome on', CDP_URL); process.exit(0); }
const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 5000 });
try { const s = await browser.newBrowserCDPSession(); await s.send('Browser.close'); } catch (e) { console.log('Browser.close failed:', e.message.slice(0, 80)); }
const t0 = Date.now(); while (Date.now() - t0 < 10000 && await cdpUp(500)) await sleep(300);
console.log(await cdpUp(500) ? 'Chrome still running' : 'Chrome closed cleanly');
process.exit(0);
