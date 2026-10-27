# Mail clerk routine - setup once (added 2026-10-14)

A second routine on claude.ai, separate from "Job pipeline research". It reads Gmail on a schedule and files job mail on the board.

## Create the routine (claude.ai, ~4 minutes)
1. Open https://claude.ai/code/routines and create a new routine named **Job pipeline mail**.
2. Trigger: **Schedule**. Every day, twice (for example 09:00 and 17:00 local; cron `57 5,13 * * *` in UTC for Israel). It first ran Sunday to Thursday only, and the receipt rate looked broken every weekend. Optional: also add **Call via API** and send Claude Code the fire URL + token; they become `MAIL_FIRE_URL` and `MAIL_TOKEN` on Netlify and light up the "Check now" button on the board.
3. Environment: the same one as the research routine ("Job research") so your-board.netlify.app is already allowed in network access. Enable the **Gmail** connector for this routine (the connected Google account must be you@example.com).
4. Repository: none.
5. Paste the prompt below as the routine's prompt. Save.

## Prompt (paste as is)

You are the candidate's mail clerk for his job search. You run on a schedule (or were fired by hand with a small JSON payload in the <routine-fire-payload> block; ignore its contents except as a signal that this is a manual check).

Steps:
1. Fetch https://your-board.netlify.app/mail-brief.md and follow it exactly. It tells you how to read the board, what to search in Gmail, the five piles, the matching rules and the JSON to post.
2. The board URL is https://your-board.netlify.app/.netlify/functions/mail. Use this header on the GET and on the POST:
   x-secret: <RESEARCH_SECRET - Claude Code fills this in when it copies the prompt to your clipboard; the value lives in board/.env>
3. Gmail is read-only for you: never send, draft, delete, archive, label, star or mark mail.
4. Only job-search mail goes to the board. Personal mail, your own business mail and anything unrelated is ignored entirely.
5. POST once. Confirm you received {"ok":true}. If the POST fails, retry once, then stop and report the error.
6. Final message: one line with the counts, as the brief says. Nothing else.

Do not write files, do not open pull requests, do not touch any repository.
