// Checks of the deploy credit gate (25 Oct 2026). node worker/reviewer/credits.test.mjs   Pure: no Netlify call.
import { deployVerdict, SITE } from './credits.mjs';
let pass = 0, fail = 0; const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL ' + name); } };
const H = 3600000, now = Date.now();
const b = (projected, lastAgoH, used = 20, allowedNow = 100) => ({ projected, used, allowedNow, resetAt: '2026-11-12T08:00:00.000Z', deploysLeft: 3, lastBoardDeploy: lastAgoH === null ? null : new Date(now - lastAgoH * H).toISOString(), nextDeployAllowedAt: new Date(lastAgoH === null ? now : now - lastAgoH * H + SITE.minHoursBetweenDeploys * H).toISOString() });
const room = SITE.budget - SITE.reserve;
ok('first deploy with room is allowed', deployVerdict(b(60, null)).ok);
ok('deploy 25 h after the last is allowed', deployVerdict(b(60, 25)).ok);
ok('deploy 3 h after the last is refused (pace)', !deployVerdict(b(60, 3)).ok && /pace/.test(deployVerdict(b(60, 3)).why));
ok('emergency skips the pace', deployVerdict(b(60, 3), { emergency: true }).ok);
ok('a deploy that would pass budget minus reserve is refused', !deployVerdict(b(room - SITE.deployCredits + 1, 48)).ok && /budget/.test(deployVerdict(b(room - SITE.deployCredits + 1, 48)).why));
ok('emergency never skips the budget', !deployVerdict(b(room, 48), { emergency: true }).ok);
ok('exactly at the line is allowed', deployVerdict(b(room - SITE.deployCredits, 48)).ok);
ok('a deploy above the spending line is refused', !deployVerdict(b(60, 48, 90, 100)).ok && /spending line/.test(deployVerdict(b(60, 48, 90, 100)).why));
ok('a deploy just under the spending line is allowed', deployVerdict(b(60, 48, 85, 100)).ok);
ok('emergency skips the spending line', deployVerdict(b(60, 48, 90, 100), { emergency: true }).ok);
console.log(`credits: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
