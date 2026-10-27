// Netlify credit budget for the board's account (25 Oct 2026: the old account ran out on deploys and nobody saw it coming).
// Read-only Netlify API. EXACT since 25 Oct 2026: the dashboard's own endpoints (found in its code, they take our personal token):
//   /api/v1/<account slug>/billing/credits          -> plan_credits { used, available, total } = the "Credits available" number on Usage
//   /api/v1/<account slug>/credit_usage_insights    -> per-day credit cost per metric (deploys, requests, compute, bandwidth)
// The run-rate is the last 7 days' credits WITHOUT production deploys (those are planned, the gate paces them); projected = used +
// run-rate x days left. They are undocumented: if they stop answering, the old estimate takes over (deploys x 15 + bandwidth x 20/GB +
// otherCreditsPerDay) and the result says exact: false, which alerts.mjs reports.
//   node worker/reviewer/credits.mjs          print the budget, write logs/credits.json (the worker relays it to the board)
//   node worker/reviewer/credits.mjs --json   the same as JSON
// deploy-board.mjs imports budget() and refuses a deploy that breaks the pace or the budget. Never prints the token.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// board-site.json (gitignored) holds your site id, live URL and token file; board-site.example.json is the template
export const SITE = JSON.parse(fs.readFileSync(path.join(HERE, fs.existsSync(path.join(HERE, 'board-site.json')) ? 'board-site.json' : 'board-site.example.json'), 'utf8'));
const OUT = path.join(HERE, '..', 'logs', 'credits.json');
const DAY = 86400000;
export const siteToken = () => { const t = (fs.readFileSync(path.resolve(HERE, SITE.tokenEnv), 'utf8').match(/^NETLIFY_AUTH_TOKEN=(.*)$/m) || [])[1]; if (!t) throw new Error(`no NETLIFY_AUTH_TOKEN in ${SITE.tokenEnv}`); return t.trim(); };

export async function budget() {
  const H = { authorization: 'Bearer ' + siteToken() };
  // 429 (rate limit, seen 25 Oct after many calls): wait and retry up to 4 times, honouring Retry-After
  const api = async p => { for (let i = 0; ; i++) { const r = await fetch('https://api.netlify.com/api/v1' + p, { headers: H }); if (r.ok) return r.json(); if (r.status !== 429 || i >= 4) throw new Error(`Netlify ${p.split('?')[0]} -> ${r.status}`); const wait = Math.min(60, Number(r.headers.get('retry-after')) || 5 * (i + 1)); await new Promise(res => setTimeout(res, wait * 1000)); } };
  const site = await api(`/sites/${SITE.siteId}`);
  const acct = await api(`/accounts/${site.account_id}`);
  const start = Date.parse(acct.current_usage_period_start), end = Date.parse(acct.next_usage_period_start), now = Date.now();
  const sites = await api('/sites?per_page=100');
  const deploys = []; let lastBoardDeploy = null;
  for (const s of sites) {
    for (let page = 1; page < 20; page++) {
      const d = await api(`/sites/${s.id}/deploys?per_page=100&page=${page}`); if (!Array.isArray(d) || !d.length) break;
      for (const x of d) {
        if (Date.parse(x.created_at) < start) continue;
        if (x.context === 'production' && x.state === 'ready') deploys.push({ site: s.name, at: x.created_at, id: x.id });
        if (s.id === SITE.siteId && x.context === 'production' && x.state === 'ready' && (!lastBoardDeploy || x.created_at > lastBoardDeploy)) lastBoardDeploy = x.created_at;
      }
      if (Date.parse(d[d.length - 1].created_at) < start || d.length < 100) break;
    }
  }
  const elapsed = Math.max(0.5, (now - start) / DAY), left = Math.max(0, (end - now) / DAY);
  const deployCredits = deploys.length * SITE.deployCredits;
  let used, runRate, exact = false, parts;
  try {
    const cr = await api(`/${acct.slug}/billing/credits`);
    const ins = await api(`/${acct.slug}/credit_usage_insights`);
    const pc = cr && cr.plan_credits; if (!pc || !Number.isFinite(Number(pc.used))) throw new Error('no plan_credits');
    used = Number(pc.used);
    const days = (Array.isArray(ins) ? ins : []).filter(d => d.date && Date.parse(d.date) >= now - 8 * DAY && Date.parse(d.date) < now - DAY / 2).slice(-7);
    const noDeploy = d => (d.usage || []).filter(m => m.metric_id !== 'production_deploys').reduce((n, m) => n + (Number(m.credit_cost) || 0), 0);
    runRate = Math.max(SITE.otherCreditsPerDay, days.length ? Math.max(...[days.reduce((n, d) => n + noDeploy(d), 0) / days.length, noDeploy(days[days.length - 1])]) : 0);   // the 7-day average or the latest day, whichever is higher, never below the floor (board-site.json otherCreditsPerDay)
    const byMetric = {}; for (const d of (Array.isArray(ins) ? ins : []).filter(d => Date.parse(d.date) >= start)) for (const m of d.usage || []) byMetric[m.metric_id] = (byMetric[m.metric_id] || 0) + (Number(m.credit_cost) || 0);
    parts = Object.fromEntries(Object.entries(byMetric).filter(([, v]) => v > 0.05).map(([k, v]) => [k, Math.round(v * 10) / 10]));
    exact = true;
  } catch (e) {
    const bw = await api(`/accounts/${site.account_id}/bandwidth`);
    const bwCredits = (bw.used || 0) / 1e9 * 20;
    used = deployCredits + bwCredits + SITE.otherCreditsPerDay * elapsed;
    runRate = (bwCredits / elapsed) + SITE.otherCreditsPerDay;
    parts = { deploys: deployCredits, bandwidth: Math.round(bwCredits * 10) / 10, other: Math.round(SITE.otherCreditsPerDay * elapsed * 10) / 10, estimateBecause: e.message };
  }
  const projected = Math.round(used + runRate * left);
  const room = SITE.budget - SITE.reserve - projected;
  // spending line (Eyal, 25 Oct 2026): by any day of the cycle, credits used may not pass that day's share of budget - reserve
  const allowedNow = Math.round((SITE.budget - SITE.reserve) * Math.min(1, elapsed / ((end - start) / DAY)));
  const nextAt = lastBoardDeploy ? new Date(Date.parse(lastBoardDeploy) + SITE.minHoursBetweenDeploys * 3600000).toISOString() : new Date(now).toISOString();
  return {
    at: new Date(now).toISOString(), account: acct.slug, cycleStart: new Date(start).toISOString(), resetAt: new Date(end).toISOString(), daysLeft: Math.round(left * 10) / 10,
    budget: SITE.budget, reserve: SITE.reserve, used: Math.round(used), projected, deploysThisCycle: deploys.length, deploysLeft: Math.max(0, Math.floor(room / SITE.deployCredits)),
    lastBoardDeploy, nextDeployAllowedAt: nextAt, allowedNow, exact, runRatePerDay: Math.round(runRate * 100) / 100, parts,
    pct: Math.round(100 * projected / SITE.budget),
  };
}

// the rule deploy-board.mjs applies: budget (never skipped), then the spending line and the 24 h pace (--emergency skips those two)
export function deployVerdict(b, { emergency = false } = {}) {
  if (b.projected + SITE.deployCredits > SITE.budget - SITE.reserve) return { ok: false, why: `budget: projected ${b.projected} + ${SITE.deployCredits} for this deploy would pass ${SITE.budget - SITE.reserve} (${SITE.budget} minus the ${SITE.reserve} reserve) before the reset on ${b.resetAt.slice(0, 10)}` };
  if (!emergency && Number.isFinite(b.allowedNow) && b.used + SITE.deployCredits > b.allowedNow) return { ok: false, why: `spending line: ${b.used} used + ${SITE.deployCredits} for this deploy would pass today's share of the budget (${b.allowedNow} of ${SITE.budget - SITE.reserve} at this point of the cycle); wait for the line to rise or --emergency if the loop is broken` };
  if (!emergency && Date.now() < Date.parse(b.nextDeployAllowedAt)) return { ok: false, why: `pace: the last production deploy was ${b.lastBoardDeploy}; the next is allowed from ${b.nextDeployAllowedAt} (one per ${SITE.minHoursBetweenDeploys} h; --emergency only when the loop is broken)` };
  return { ok: true, why: `ok: projected ${b.projected} of ${SITE.budget}, ${b.deploysLeft} deploys left in the budget` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const b = await budget();
  fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(b, null, 1));
  if (process.argv.includes('--json')) console.log(JSON.stringify(b, null, 1));
  else console.log(`${b.account}: used ${b.exact ? '' : '~'}${b.used} of ${b.budget} credits (${b.exact ? 'exact, from Netlify' : 'ESTIMATE, the exact read failed'}: ${Object.entries(b.parts).map(([k, v]) => `${k} ${v}`).join(', ')}), ${b.runRatePerDay}/day without deploys, projected ${b.projected} at the reset ${b.resetAt.slice(0, 10)} (${b.daysLeft} days). ${b.deploysThisCycle} production deploys this cycle, ${b.deploysLeft} more fit the budget. Spending line today: ${b.allowedNow} (used ${b.used}). Next board deploy allowed from ${b.nextDeployAllowedAt.slice(0, 16).replace('T', ' ')} UTC.`);
}
