# Hunt setup - once (v2, updated 2026-10-16)

The nightly hunt is four workers, one job each:
1. **Finder** - BUILT INTO THE BOARD (`netlify/functions/hunt-find.mjs`), a Netlify scheduled function. No routine, no PC. It runs every 5 minutes during the 00:00 UTC hour (02:00-02:55 Israel in winter), one step per tick: Drushim, AllJobs, LinkedIn (usually refused from the cloud, logged), the job boards on the Home list plus boards it learned, then it maps aggregator hits to the company's own Greenhouse / Lever / Ashby posting, and posts one candidate per company. "Hunt now" on Home runs the same steps back to back.
2. **Sorter** - ONE agent run per night, fired by the board when the finder is done (payload kind `hunt-sort`, brief `/hunt-sort-brief.md`). Gets the finder's top 40, drops the misses a script cannot see (language, sales in disguise, agencies, hidden seniority), finds each keeper's real application form, sends back the best 10. If it does not answer within 30 minutes the board uses the finder's own top 10 and says so in the morning brief.
3. **Grader** - one run per company, fired by the board. Reuses the existing "Job pipeline research" routine (payload kind `hunt-grade`).
4. **Preparer** - one run per role graded 6 or below, fired by the board. Same research routine (payload kind `hunt-prep`).
The board fires one job at a time (`state.hunt.concurrency`, default 1) and fires the next when the previous posts back. Nothing here submits anything; the board queues the prepared cards (hands-off mode) and the PC worker (worker/worker.mjs) submits them whenever the candidate's PC is on.

## The one thing the candidate does (claude.ai, 1 minute)
Open the routine **Job pipeline research** and re-paste the prompt from `ROUTINE-PROMPT.md` (its first branch now covers every `hunt-*` kind: hunt-sort, hunt-grade, hunt-prep; re-pasted 16 Oct evening for the sorter). Nothing else changes: it already has the API trigger (`ROUTINE_FIRE_URL` / `ROUTINE_TOKEN` on Netlify) and board network access.

No finder routine, no `HUNT_FIRE_URL` / `HUNT_TOKEN`. The old finder brief (`hunt-brief.md`) is retired.

## Why the finder is not a claude.ai routine (tested 2026-10-16)
Search engines cannot find Ashby / Lever / Comeet boards (Bing returns junk for `site:` queries, DuckDuckGo throws a bot challenge). The sources that do surface Israeli roles are LinkedIn guest search, Drushim, AllJobs and the ATS APIs. LinkedIn and Comeet company pages answer a home PC only; Drushim, AllJobs and the Greenhouse / Ashby / Lever APIs answer any cloud fetch. A scheduled function on the board reads all of those with no PC and no LLM, so it is cheaper and never blows up a context.
