# The road here

Two weeks, 14 to 27 Oct 2026, from "I should apply to more places" to a loop that runs without me. This is the honest version: what was built in what order, what broke, what I decided and why. Dates are from my working log. Company names are left out on purpose.

## Phase 0: manual (Sep to mid Oct)

The board started as a personal CRM for the search: channels -> people -> companies -> roles, with per-company AI research and a stage board. My first nine cold applications produced zero interviews, while every live conversation came through a person. That split the search in two: **real** opportunities I handle myself, and a **practice tier** of solid companies where the goal is reps: screens, interviews, and data on what this CV gets answers from. The practice tier is what got automated.

## Phase 1: plan and first submit (14-15 Oct)

- Brainstormed the closed loop: hunt -> prep -> browser submit -> mail clerk -> lessons. Four of the five steps can live in the cloud. Submitting cannot: bot detection fires on how a page is driven, and a real logged-in browser on a home connection is the reliable path.
- Tried Claude in Chrome first. Two blockers: Comeet's form is invisible to the accessibility tree and to plain DOM scripts (a widget in an iframe, only screenshots and coordinates see it), and the permission layer rightly asks a human before every Submit. That is the opposite of hands-off.
- **Decision: Playwright attached over CDP to a dedicated, real Chrome profile.** Not a Playwright-launched browser (different fingerprint), not headless.
- Built the first version in a day: the hunt function, board UI, briefs, the Playwright runner with four recipes, the answer bank. 52 of 52 board checks on localhost. A Playwright probe found every input of a Comeet form inside its iframe, plus an invisible reCAPTCHA that does not block a real browser.

## Phase 2: the night chain goes live (16-19 Oct)

- Probed every source from the PC and from a cloud fetcher. Search engines cannot find ATS boards (`site:` queries return junk, one engine throws a bot challenge). LinkedIn and some company pages answer only a home PC. Drushim, AllJobs and the ATS JSON APIs answer any cloud fetch.
- **Decision: the finder is a Netlify scheduled function, not an agent.** No PC at night, no LLM, cheaper, and it never blows up a context window. One step per 5-minute tick so nothing hits the function time limit.
- Added the **sorter** agent between the finder and the graders: it sees what a regex cannot (sales quota seats with an engineer title, agencies, language requirements) and finds each keeper's real form.
- Nights of 17, 18 and 19 Oct ran end to end in the cloud: 264 / 404 / 396 roles seen, 2 / 2 / 1 prepared. Nothing was sent: a morning approval step still sat in the middle.
- 19 Oct evening: the first live batch, three Comeet applications in one approval, all confirmed on the page and later by receipt.

## Phase 3: hands-off (19-21 Oct)

- **Decision: fully hands-off.** No morning approval, no morning email. Whatever cannot be submitted automatically is forfeited with a reason, not parked for me.
- Built: auto-queue at prep time, atomic worker claims, a daily cap, the PC worker as a Windows scheduled task every 15 minutes, a heartbeat on the Home page.
- Drushim and AllJobs (the two big Israeli job sites, one-click apply with a logged-in account) were proven through scheduled ticks with no human step on the night of 20-21 Oct, after a long night of root-causing (below).
- Monitoring: a SQLite event store on the PC, an evidence bundle per submission (screenshots, form snapshot, trace, CV hash), a collector, and board-side events. Writing the plan for it surfaced a hidden lost-write bug in the board's state saves.

## Phase 4: measure, then self-improve (21-22 Oct)

- The **Analytics tab**: one number ("66% failure") hid which part to attack, so the funnel became four stage rates, each with an owner of the fix. Baseline on 21 Oct: kept -> queued 75%, queued -> sent 83%, sent -> receipt 30%, sent -> interview 0%.
- The **form finder** for LinkedIn-only postings, and a SmartRecruiters recipe (many companies hide it behind their own careers site).
- The **scheduled reviewer**: headless Claude Code every 6 hours, fixing failures and proving fixes with dry runs. On 22 Oct I widened its mandate: fix, test and verify anything that raises the share of found jobs that get submitted, with the limits in code. It got a gated deploy script, a caps tool with ceilings and a test baseline. Its first board deploy went out that night, all suites green.

## Phase 5: volume and the credit wall (23-25 Oct)

- **Decision: one application per role, not per company.** Several fitting roles at one company are fine; the same role twice never.
- Caps went from 5 to 8 to 10 submissions a day on the record of clean nights. Title filters loosened (senior titles in, "head of" in, more role types).
- The mail clerk was moved to every day, the lost-write bug was fixed, and every send now leaves an application record on the board ("What we sent").
- 25 Oct: the board's Netlify account ran out of credits (21 production deploys x 15 credits = 315 of 300). Moved the board to a second account in one evening: 48 blobs backed up and restored with a byte-for-byte verify, every variable copied for all contexts, a credit guard in the deploy gate, alerts by email.
- **Decision: the company rule.** At most 2 open applications per company, one role family only (product, engineering or solutions). A recruiter who sees every application from one candidate in one ATS profile should read focus, not spray.

## Phase 6: supply (26-27 Oct)

- Measured why supply was short: 48 of 60 sorter slots went to companies already on the board, and the reviewer added about one board per run by guessing slugs.
- Built five supply items in one batch and shipped them in one deploy: pre-filter known roles before the cap, techmap as a nightly source, self-growing company boards (a sweep of 7,942 companies found 430 boards, 169 with Israel title matches), wider titles, and two new recipes (Workable, BambooHR) once each ATS passed 3 fitting open roles. A LinkedIn feed from the PC was built and left off (below).
- Raised the night to 25 prepared, kept 10 submissions a day.
- A security pass: the board key went from a short code to 40 random characters, auth fails closed and is timing-safe, function source answers 404.

## Problems hit, and how they were solved

**Finding the form**
- *LinkedIn-only postings.* Many roles surface only on LinkedIn, and companies' own careers pages often answer the board's server-side fetch with 403. Fix: a form finder on the PC (public ATS APIs by slug, the careers page in the runner Chrome, the site's own keyword search, embedded forms). It reached 2 of the first 3; the third existed only on LinkedIn and stays forfeited honestly.
- *LinkedIn from the PC.* The logged-out guest search answered 429 on the first request. Tuning headers to get past it would be bot-check circumvention, so I did not. Built, switched off.
- *The night hunt never finished once.* It saw about 2,700 roles and spent the whole window resolving aggregator rows one lookup per row (one company's five roles = five lookups). Fix: one lookup per company, 10 companies a tick, a 7-day cache of misses.
- *Hebrew titles.* Product manager titles were dropped as "no target keyword" because of a dot form of the gender mark and a space before it on one site. Fixed in the regexes, covered by tests.

**Filling the form**
- *Captcha on Lever.* Every Lever form loads passive hCaptcha. The worker tries; the first live Lever card filled clean and was then challenged after the click, so it went `unverified` and was not retried. A captcha is never solved or bypassed.
- *AllJobs sent nothing, three times, silently.* Root cause from a network probe: the send panel's mode was never selected, so the validator refused and no request left the page. Then a reload 15 s after the click aborted an upload still in flight. Then its bot check tripped after about 8 page loads in 15 minutes. Fixes: pick the mode, reload only after 45 s, one AllJobs card per tick.
- *Drushim sessions died.* Its access token lives 15 minutes and refreshes from a long-lived token, but the session died across a Chrome restart. Fix: the worker leaves the runner Chrome running between ticks.
- *Drushim kept at most 4 CVs and listed the newest first.* The recipe picked the last radio, so three early applications went out with a stale tailored copy (practice tier, recorded honestly). Fix: clear stored CVs first, select the radio that appeared after the upload.
- *A click that never landed was marked unverified.* An error box covered the Submit button; Playwright never dispatched the click. Now that case is `failed` (nothing sent, re-queueable), not `unverified`.
- A long tail of form details, each found by a failed card and fixed by a dry run: a cookie-consent click that reloaded the embedded form and wiped typed fields; an embed that keeps resizing so its button is never "stable"; an autofill dropzone that overwrote the name from the CV; a Submit button that is a custom element inside a shadow root; two-step forms; an autocomplete that picked the first suggestion ("Female" for "Male"); a residence list with no Israel in it; a screener matched by substring into the wrong question; a Photo input that caught the CV.

**Proving it**
- *The receipts funnel looked broken.* The mail clerk ran Sunday to Thursday only, so on 25 Oct the board showed 5 receipts while Gmail held about 26. One catch-up run filed 22, and sent -> receipt went from 14% to 59%. The clerk now runs every day.
- *Confirmed on the page, marked unverified.* Some recipes did not know a site's confirmation page (an embedded iframe landing on a confirmation path, a hosted board's confirmation URL). The cards stayed `unverified` on the board until the receipt arrived; the recipes learned both.
- *A hidden lost write.* Netlify Blobs' conditional write let two simultaneous saves win the same revision; a live probe failed 10 of 15. Fix: a stamp chain plus a re-read, 409 on an overwritten save. After: 0 of 15 failed, and 12 overwritten saves were caught during the probes.

**Running it**
- *Ungraded roles stuck.* After the credit wall, production deploys answered 403, so deploys went out as drafts, and the routine token was a production-only secret. The live board could not fire its agents and new roles sat ungraded. Fix: move accounts, set every secret for all contexts, and an alert for "candidates stuck ungraded over 3 hours".
- *Netlify credits.* Every production deploy costs 15 of 300 credits a cycle. Fix: deploys only through the gate, at most one per 24 hours, a reserve of 60, batch fixes, a Credits light on the board and alerts at 70% and 85% projected use.
- *429 rate limit.* After the caps went to 25, the routine trigger hit its fire rate limit and the board burned both attempts of 11 waiting cards in one second. Nothing was sent, but 11 cards failed at prep. Fix: a 429 pauses firing until the time it names without using an attempt, and the failed cards return to the line. Covered by `tests/rate-limit.test.mjs`.
- *The reviewer died silently, more than once.* A log path built from a locale date string with slashes; a batch file edited while it ran (cmd.exe re-executes shifted lines and started a third instance); a DNS blip mid-run that left two half edits; a deploy CLI waiting on a prompt because stdin was open. Fixes: a timestamp from PowerShell, a 70-minute lock, "never edit the batch file mid-run", a Reviewer light on the board, CI mode for the CLI.
- *The laptop slept.* On battery the sleep timeout is 3 minutes; one day had no ticks for 9 hours. Fix: keep it plugged in. The loop picks up on resume.

## Decisions and the reasoning behind them

| Decision | Why |
| --- | --- |
| Practice tier only (grade 6 or below); real seats by hand | The automation is for reps and data. A seat I really want deserves a human. |
| Playwright over CDP on a real Chrome profile, residential IP | The only path that is both fully automatic and not fighting bot detection. |
| Fully hands-off; forfeit what cannot be done automatically | A morning approval step meant nothing went out when I was away. |
| An unknown outcome after the click is `unverified`, never retried | Applying twice to the same role is worse than missing one. |
| Answers only from the answer bank; an unknown question forfeits the card | The system never invents a fact about me. |
| No cover letters, no "why us" text | Generated filler is worse than none, and it is where lies creep in. |
| Never solve a captcha, never create an account, never automate my LinkedIn account | Those are the lines between automation and abuse. |
| Finder as a scheduled function, agents only for judgment | Scripts for what scripts can do: cheaper, faster, testable. |
| One agent job at a time | Easy to reason about, and the routine has a rate limit anyway. |
| Limits in code, not in prompts | An agent with a widened mandate needs tools that refuse, not instructions it can argue with. |
| Four funnel rates instead of one success number | Each rate has an owner, so each day's fix shows up as one rate moving. |
| Monitoring in SQLite on the PC | Free, queryable, and the evidence (screenshots, traces) is already there. |

## Lessons learned

1. **Proof is a scheduled tick on a real card, never a manual run.** Many fixes looked done in a dry run and failed live on a detail; the log says "proof pending" until a tick lands.
2. **Silent failures are the expensive ones.** Every "nothing happened" turned out to be a real bug (an upload aborted, a mode never picked, a reviewer that exited in under a second). Alerts and heartbeats paid for themselves within a day.
3. **Measure per stage.** The receipts rate "dropped" because the clerk did not run on weekends; supply "was short" because the sorter's slots went to companies already on the board. One overall number would have hidden both.
4. **A dry run that stops before the click catches most form bugs.** The gate (refuse the click when any required field is empty) is the most valuable 50 lines in the worker.
5. **Platforms are production dependencies.** Credits, rate limits, per-context secrets and session lifetimes broke the loop more often than my own code did.
6. **Supply is the real ceiling.** Once the recipes were solid, the limit was enough fitting postings, which is why the last phase was all supply.
7. **Directing AI well is specific work.** Every brief, every hard rule in the reviewer prompt and every refusal built into a tool came from a real failure. The architecture, the flows and the decisions are mine; Claude Code wrote most of the code with me.
