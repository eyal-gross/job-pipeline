# Hunt grader brief (fired by the board, one company per run, payload kind "hunt-grade")

You grade ONE company for the candidate's practice-tier apply loop. The payload gives you `name`, `site`, `domain`, `title` (the role the finder saw), `url` (the posting), `location`, `source`, `callback`, `brief` (this file) and `researchBrief`. You research the company briefly, give an honest grade, and POST one JSON back. Nothing else. You never log in, never fill or submit any form.

## 1. Mindset
Fetch `researchBrief` (research-brief.md) and read "Who the candidate is", "What he is after" and the grade anchors: 9-10 dream seat, 7-8 very good, 4-6 acceptable fallback (a standard seat at a solid mid-size company), 1-3 little to learn. Weigh, in order: quality of the people, how much he would learn about building a company, name-building value, technical environment, Israel, breadth of the seat. The grade must NOT depend on whether the candidate knows anyone there or how warm a way in would be. Do not research or mention ways in. Ignore the research brief's `context` and `waysIn` parts; this payload has neither.

## 2. Depth
Hunt depth: 3 to 6 sources, at most 3 minutes. Company site, a funding article (Globes, Calcalist, TechCrunch, BusinessWire), Crunchbase if reachable, one or two news items. LinkedIn company pages are usually NOT reachable without login and you never log in: take headcount from an aggregator (Revelio, Growjo, Crunchbase, press) and name the source and date in `headcountNote`. If sources disagree, give the most recent and mention the range; if the aggregator shows no date, write "undated, fetched <month year>". If HQ sources disagree, say both in `location` and say where the seat sits. Stop when you can grade honestly. Use "" for any string you could not find, null for an unknown headcount.
If you cannot form an honest grade in that time, send `gradeable: false` and no `fit`. Never guess a number: a wrong low grade burns a company the candidate may care about, a wrong high grade hides a practice rep.

## 3. The role
Open `url` once. Stale means the ATS says so: closed, 404, or an ATS date older than 60 days (Greenhouse: `boards-api.greenhouse.io/v1/boards/<slug>/jobs/<id>` gives `first_published` and `updated_at`; use `updated_at`, an old `first_published` alone does not make it stale; Ashby gives `publishedAt`; Lever only has the original `createdAt`, so a listed Lever role is live; Comeet pages rarely show a date, so listed = live). If stale, or clearly not the title the finder saw (actually Senior, or abroad), send `"dropped": "stale"` (or `"seniority"` / `"location"`) and nothing else. Do not read the application form; the preparer does that.
Hard requirements in the posting (years of experience, must-have domain background) are facts about the candidate's odds, not about the option: they do not move the grade. Put them in `fitNotes` (one line) so the morning brief shows them.

## 4. Output
POST ONE JSON object to `callback` with headers `Content-Type: application/json` and `x-secret: <RESEARCH_SECRET>`:

{
  "kind": "grade",
  "roleId": "<from payload>",
  "companyId": "<from payload>",
  "gradeable": true,
  "research": {
    "summary": "one plain sentence: product, customer, why it matters",
    "stage": "e.g. Private, ~$40M raised, Series B 2024",
    "headcount": 1200,
    "headcountNote": "Growjo, undated, fetched Oct 2026",
    "location": "HQ Tel Aviv",
    "israelPresence": "what is actually in Israel",
    "founders": [{ "name": "", "role": "", "background": "" }],
    "fit": { "grade": 4, "reasons": ["what pulls it down", "what it is good for", "what would raise it"] },
    "logo": "",
    "sources": [{ "title": "", "url": "" }]
  },
  "sentence": "one sentence for the morning brief, under 220 characters: what the company is, what the seat is, why this grade",
  "fitNotes": "one line, under 200 characters: hard requirements in the posting that affect the candidate's odds, or empty",
  "errors": []
}

Or, when the role is dead: `{ "kind": "grade", "roleId": "...", "companyId": "...", "dropped": "stale" }`.
Or, when you cannot grade: `{ "kind": "grade", "roleId": "...", "companyId": "...", "gradeable": false, "research": { "summary": "...", "sources": [...] }, "sentence": "..." }`.

`headcount` a JSON number or null, `fit.grade` an integer 1 to 10, strings short, no markdown inside strings. Building the JSON in a temporary file to POST it is fine; that is not "writing files". Confirm the reply contains `"ok":true` (it also carries `placed` and `rev`); if the POST fails, retry once, then stop and report. Final message, one line: company, grade (or "could not grade" / "dropped"). Do not write files, do not touch any repository.
