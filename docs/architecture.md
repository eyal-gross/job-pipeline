# Architecture

Four moving parts, each with one job:

| Part | Where it runs | What it does |
| --- | --- | --- |
| **Board** (`board/`) | Netlify: static page + serverless functions + Netlify Blobs | Source of truth. Holds every company, role and application card, runs the nightly finder on a schedule, fires the AI agents, enforces every rule (never twice, company rule, caps), takes the worker's claims and reports, files the mail clerk's results, shows the Analytics tab. |
| **Agents** (`board/*-brief.md`) | claude.ai routines (Claude, fired by API or schedule) | Judgment work a script cannot do: sort the finder's list, grade each company, read each form and prepare the package, read Gmail. Each agent gets one job, reads its brief from the board, and POSTs one JSON back. |
| **PC worker** (`worker/`) | The owner's Windows PC, a scheduled task every 15 minutes | The only thing that ever submits. Claims queued cards, tailors the CV, fills the form with Playwright in a real Chrome profile, clicks Submit only when every required field is filled, proves the outcome, reports back. |
| **Reviewer** (`worker/reviewer/`) | The same PC, headless Claude Code every 6 hours | Reads what failed, fixes the recipe / filter / brief, proves the fix with a dry run, re-queues, grows supply, deploys the board through a gated script, writes a digest. |

Plus the observability layer (`obs/`): a SQLite event store on the PC, fed by the board's event chunks, the worker's per-card evidence and the board state diff.

## Card lifecycle

Every role on the board carries `apply.status`:

```
candidate -> (grader) -> graded -> (preparer) -> prepared -> approved (= queued) -> submitting -> submitted -> confirmed
                                                     \-> skipped ("forfeited: <reason>")          \-> unverified
                                                                                                  \-> failed / blocked
```

- **candidate**: created from the sorter's pick. The grader is fired for its company (one company per run).
- **graded**: the grade decides the lane. Above 6 = a "real" lead, never applied to by the system, left for the owner. 6 or below = practice lane, the preparer is fired.
- **prepared**: the preparer read the form and wrote the package (fields, screeners, answers from the answer bank, CV master, title).
- **approved (queued)**: hands-off mode (`hunt.autoQueue`, on by default). A prepared card is queued at prep time when it has a recipe for its ATS, no open screener and no flag. Anything else is **forfeited** (`skipped`, reason `forfeited: <why>`: no recipe, LinkedIn-only, captcha, login wall, an unanswered screener). The owner can revive a forfeited card by hand; the reviewer revives it after fixing the cause.
- **submitting**: the worker claimed it (atomic on the board).
- **submitted**: the worker saw the site's own confirmation and saved a screenshot of it.
- **confirmed**: the mail clerk filed a receipt email for it.
- **unverified**: the click happened but the outcome is unknown, or 3 days passed with no receipt, or the worker never reported back within 2 hours. Never retried: never-twice beats coverage.
- **failed**: nothing was sent (the gate refused, a field was missing, the click never landed). Re-queueable after a fix.
- **blocked**: a captcha challenge, a "verifying your browser" page or a login wall. Never bypassed.
- A rejection email from the mail clerk closes the role (`stage: closed`, "Rejected by email, <date>").

Only `apply.status === "submitted"` ever moves a role to the stage "applied".

## The nightly hunt (board, `netlify/functions/hunt-find.mjs`)

A Netlify scheduled function (`*/5 0-1,11-12 * * *`): two windows a day (00:00-01:55 and 11:00-12:55 UTC), one step per 5-minute tick, so no step ever hits the function time limit. Steps:

1. **Read sources**: Drushim and AllJobs search JSON (Hebrew and English queries), LinkedIn's logged-out guest search (usually refused from a cloud address, logged), techmap (an open daily CSV of Israeli tech jobs, ODbL), and every company job board in the seed list (Greenhouse boards-api, Lever, Ashby posting-api, Comeet, SmartRecruiters, Workable, BambooHR).
2. **Cheap rules** (no LLM): title include / exclude regexes in English and Hebrew (gender marks, dot forms and seniority words included), Israel location, agencies and anonymous employers, stale, duplicate, external Workday redirects.
3. **Pre-filter known roles** before the cap: anything already on the board, in the applied ledger, at a real-tier company or over the company rule is dropped here, so every slot handed to the sorter is a role the board can still take.
4. **Resolve** aggregator hits to the company's own ATS posting: one lookup per company (not per row), 10 companies a tick, 7-day cache of clean misses.
5. **Finalize**: rank, keep the top `caps.offered` (60), fire the sorter agent once.

"Hunt now" on the Home page runs the same steps back to back.

## The agents (claude.ai routines)

One routine ("Job pipeline research") serves the sorter, grader, preparer and lessons jobs: its prompt (`ROUTINE-PROMPT.md`) branches on the payload `kind` and tells the agent to fetch its brief from the board. A second routine ("Job pipeline mail") is the mail clerk.

- **Sorter** (`hunt-sort-brief.md`, one run a night): drops what a regex cannot see (language requirements, sales quota seats wearing an engineer title, agencies, hidden seniority, non-AI companies for plain engineering titles), finds each keeper's real application form (careers page -> ATS), returns at most `caps.found`, at most 2 per company. Fallback: if it does not answer in 30 minutes the board uses the finder's own ranking.
- **Grader** (`hunt-grade-brief.md`, one company per run): 3-6 sources, 3 minutes. Grade 1-10 against the candidate profile in `research-brief.md`. The grade must not depend on whether the candidate knows anyone there. Can drop a stale role.
- **Preparer** (`hunt-prep-brief.md`, one role per run, grade 6 or below only): reads the form through the ATS's public data (Greenhouse `?questions=true`, Lever's server-rendered apply page, SmartRecruiters' public API, and so on), lists every field and screener, answers screeners **only from the answer bank** (anything not covered stays open and the card forfeits), picks the CV master by title, writes a one-line summary. Never logs in, never types into a form.
- **Mail clerk** (`mail-brief.md`, twice a day): reads Gmail read-only, files only job-search mail into five piles (reply needed, rejected, heads-up, application received, noise), matches by sender, company name, role title and, for Hebrew receipts that name nothing, by submit time within 30 minutes.

The board fires one agent job at a time (`hunt.concurrency`, default 1) and fires the next when the previous posts back. A `kick()` sweep re-fires waiting jobs; each card gets 2 attempts.

**Rate limit backoff** (`hunt.mjs` `kick`, `retryAfterMs`, `reviveRateLimited`; test `tests/rate-limit.test.mjs`): a 429 from the routine trigger puts the card back without using an attempt, pauses all firing until the time the error names (`hunt.fireBackoffUntil`), and the worker's 15-minute claim call resumes the chain. Cards that failed on a 429 before the fix return to the line by themselves.

## Rules the board enforces (in code, not in prompts)

- **Practice tier only**: the system applies only at companies graded 6 or below. Real-tier cards are never touched.
- **One application per role, ever**: a role key is company name (normalised: "Acme Technologies Ltd." = "acme") + title (seniority words, gender marks and a trailing location stripped). The applied ledger keeps every sent role.
- **Company rule**: at most 2 open applications per company, one role family only (product / engineering / solutions), so a recruiter who sees every application in one ATS profile reads focus, not spray. Rejected, forfeited and failed ones free the slot. (`roleFamily`, `openRolesAt`; `tests/company-rule.test.mjs`.)
- **Caps**: `caps.found` (sorter picks per run), `caps.prepared` (preparer runs per night), `caps.offered` (rows handed to the sorter), `caps.perDay` (submissions per UTC day), `caps.perHour` (submissions per hour). The worker also takes at most 3 cards per tick (`worker/config.json` maxPerRun), at most 3 per ATS per tick, with a random 60-120 s pause between cards.
- **Kill switch**: one flag stops the hunt and the claims.
- **Open screeners block approval**, even by hand: answer first, then queue.

### About the daily volume

`caps.perDay` is a setting. The real ceiling is supply: enough fitting postings found by the hunt. The owner runs it at 10 a day. Two safety clamps exist and are one-line changes: the board's `settings` action accepts `perDay` from 0 to 20 (`hunt.mjs`), and the reviewer's `caps.mjs` refuses values above its ceilings (perDay 20, prepared 20, found 30, offered 60, perHour 10). Values above those ceilings were set by hand through the board settings (found and prepared run at 25 per night since 27 Oct 2026).

## CV selection and tailoring

The preparer picks one of three CV masters by title: `engineer-big` (AI / solutions / software engineering), `engineer-seed` (founding or product engineer at a tiny startup) and `tpm` (product, technical PM, customer success, growth). The worker calls an external CV tool (`cv.js tailor <master> <company> <title>`, a separate project, not in this repo) that stamps the posting's exact title into the master and prints a one-page PDF to `<cvsDir>/<company-slug>/CV.pdf`. Over one page with the full title: retry with a shorter title; still over: the card fails before anything is sent. No keyword stuffing, no cover letters, ever.

## The PC worker (`worker/worker.mjs`)

Each tick (Windows task `JobApplyWorker`, at logon and every 15 minutes):

1. Single-instance lock.
2. Run the observability collector (board events into `obs/obs.db`).
3. Replay the outbox: any `submitted` / `unverified` patch that could not reach the board last time is resent first, so a sent application is never left unrecorded.
4. Recover interrupted cards from the claim ledger (`logs/claims/<runId>.json`: claimed -> touched -> clicked -> done). Untouched cards go back to the queue; clicked cards become `unverified` unless the local proof screenshot exists.
5. Claim up to 3 queued cards (atomic on the board, refused when over the daily or hourly cap).
6. Form finder: for up to 2 LinkedIn-only forfeited cards, look for the company's own form (public ATS APIs by slug, the careers page in the runner Chrome, the site's own keyword search, embedded forms on the position page). A found form sends the card back to the preparer.
7. Attach to the runner Chrome over CDP (a real Chrome profile with `--disable-blink-features=AutomationControlled`, started off screen by the worker if needed, never a Playwright-launched browser, residential IP only). Chrome stays up between ticks because Drushim's and AllJobs' sessions die on a Chrome restart.
8. Login checks (Google, and the job sites that need an account).
9. Per card: tailor the CV, open the form with the ATS recipe, fill identity from `config.local.json`, attach the CV, answer screeners from the card, run the required-field **gate**, screenshot the filled form, click Submit, wait for the site's confirmation, screenshot it, patch the board, send the application record (what was on the form, which CV, its sha256) to the board.
10. Report the tick (counts, reviewer heartbeat, open alerts, credits) to the board, start the alert check, detach.

### Recipes (`worker/recipes/`)

One module per ATS with the same interface: `match(url)`, `open`, `blocked`, `fill`, `attachCv`, `screeners`, `gate`, `submit`, `confirmed`, optional `loggedIn` and `cleanup`.

| Recipe | Notes learned the hard way |
| --- | --- |
| `comeet` | Form lives in an iframe; privacy-policy Yes / No radio pairs; LinkedIn goes only into a real LinkedIn field. |
| `greenhouse` | Hosted and embedded boards; cookie-consent clicks reload the iframe (re-resolve the frame after); embeds hidden behind the page's own Apply button; a resizing embed never gets a "stable" button (trial click, then DOM click); confirmation URLs differ between hosted and embedded. Required demographics answered by rule. |
| `lever` | Location autocomplete needs real key events and Lever's own list row; every form loads passive hCaptcha: tried, and a challenge that actually shows stops the card. |
| `ashby` | Attach to the Resume field, not the "Autofill from resume" dropzone (it overwrites name / email / phone). |
| `smartrecruiters` | Behind many own-looking careers sites; custom element Submit inside a shadow root; some forms are two steps (gate page 1, wait out the upload, Next, then page 2). |
| `drushim` | Logged-in one-click flow with a per-application CV upload; at most 4 stored CVs per profile (clear first) and the newest is listed first; gone postings answer 410. |
| `alljobs` | Two send-panel variants; the "send a CV file" mode must be picked or nothing leaves the page; reload only after 45 s or the upload aborts; a bot check after about 8 loads in 15 minutes, so one card per tick. |
| `workable` | The first file input can be Photo; radios need the parent fallback. |
| `bamboohr` | A "leave this field blank" bot-trap field is never touched. |

**Never a half-filled form**: `requireFilled` (the gate) reads every visible required control, including shadow roots, comboboxes and file inputs, and refuses the click when one is empty. An unknown control shape throws `FormChanged`; an unanswered required question throws `NeedsHuman`. Nothing is guessed.

**Answers**: identity from `config.local.json`, screeners from the card (which the preparer filled from the answer bank). Matching is quote-blind, prefers a label that starts with the question over a substring match, picks the exact dropdown option (never the first suggestion), handles multi-selects, consent boxes and "Other, please specify" boxes.

## Proof

Three levels, in order of strength:

1. **Filled-form screenshot** before the click (what was about to be sent), plus the application record on the board.
2. **On-page confirmation** after the click, matched per recipe, with a screenshot and its text saved: status `submitted`.
3. **Receipt email** filed by the mail clerk: status `confirmed`. Drushim and AllJobs one-click applies send no receipt; those cards turn `unverified` after 3 days by design.

## Analytics (board `#/analytics`)

Four stage rates, cohort-based (a card counts on the day it entered a stage), each with an owner of the fix:

| Rate | Owner |
| --- | --- |
| kept -> queued | finder, answer bank, briefs |
| queued -> sent | recipes, worker |
| sent -> receipt | mail clerk |
| sent -> interview | CV, targeting, grade |

Plus a verdict line, a 14-day strip, a by-week table, the top leaks with what to attack, drop reasons, a by-recipe table and "What gets answers" from the application records.

## Monitoring and alerts

- **Events**: every board function emits structured events (`netlify/functions/lib/obs.mjs`) into chunked blobs; the PC collector (`obs/collect.mjs`) pulls and deletes them, diffs board snapshots into transition events, ingests the worker's logs and evidence, and writes `obs/obs.db` (schema `obs/schema.sql`, views `obs/views.sql`). `node obs/obs.mjs brief --since 24h`, `trace <roleId>`, `query "<sql>"`.
- **Evidence per attempt**: filled and confirmation screenshots, form snapshot with the source of every value, Playwright trace zip, CV sha256.
- **Alerts** (`worker/alerts.mjs`, after every worker tick): board down, agents unable to fire, hunt missed, candidates stuck ungraded over 3 hours, mail clerk silent over 26 hours, kill switch on, reviewer silent over 13 hours, Netlify credits projected over 70% / 85%, supply stalled two days, discovery stuck, and good news (a loop-sent card reaching interview). Each new problem: one email (headless Claude Code, Gmail send only, to the owner's own inbox), a Windows notification and a red "Needs you" banner on every board page. A reminder after 24 hours if still open, a "resolved" line when it clears.

## The reviewer (`worker/reviewer/`)

Windows task `JobApplyReviewer` runs `reviewer.cmd` at 05:30, 11:30, 17:30 and 23:30: step 0 (no agent) runs board discovery over techmap's ~7,950 Israeli companies and records the supply score; then headless Claude Code reads `REVIEWER-PROMPT.md` and works for up to 40 minutes. Its duties, in order: fix what failed (cause from logs, screenshots and traces, fix, prove by dry run, re-queue if nothing was sent), grow supply (probe and add company boards, loosen a filter when the drop counts say so), build the next recipe when an ATS without one reaches 3+ fitting open roles, raise caps after two clean nights, log and commit.

Its tools carry the limits, so the prompt cannot be argued around: `dry-run.mjs` never clicks, `requeue.mjs` refuses unverified and real-tier cards, `seeds.mjs` requires an Israel title match and caps adds per run, `caps.mjs` has ceilings, `deploy-board.mjs` is the only deploy path. Hard rules: never a live submit, never solve a captcha, never automate LinkedIn, never create an account, never print a key.

## Deploy gate and Netlify credits (`worker/reviewer/deploy-board.mjs`, `credits.mjs`)

All or nothing: a clean git tree under `board/` (what goes live is a commit, so it can be rolled back), all test suites green on a local board it starts itself (`netlify dev` + `tests/fire-catcher.mjs` standing in for the routine trigger), the credit budget allows it, deploy, then `tests/cas-probe.mjs` against the live site plus a check that the agents can be fired. `--rollback` restores the previous recorded deploy through the API at no credit cost. `--emergency` skips only the 24-hour pace, never the budget.

`credits.mjs` reads the account's credit use (the dashboard's own endpoints, with an estimate fallback that raises an alert) and projects use at the cycle reset. The gate refuses a deploy inside 24 hours of the last one or one that would cross the budget minus a reserve (`board-site.json`: budget 300, reserve 60, 15 credits per production deploy).

## Concurrency: the lost-write fix (`netlify/functions/state.mjs`)

Every writer (the page, the finder, the agents' callbacks, the worker) saves the whole state document. Netlify Blobs' `onlyIfMatch` let two simultaneous saves win the same revision, the later one erasing the earlier. `saveDoc` now stamps each save into a chain of recent stamps and re-reads after 300 ms; a missing stamp means it was overwritten and the save answers 409, which every writer already retries. `tests/cas-probe.mjs` fires concurrent saves at the live site after every deploy.

## Security

The board key (`PIPELINE_KEY`, 40+ random characters) gates every read and write; auth fails closed and compares in constant time. Agents call back with a separate `RESEARCH_SECRET`. Function source and internal files answer 404 (`netlify.toml`). No script prints a key; the observability layer redacts any field named like a key, token, secret or password.
