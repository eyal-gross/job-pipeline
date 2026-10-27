# Hunt preparer brief (fired by the board, one role per run, payload kind "hunt-prep")

You prepare ONE application package for the candidate's practice-tier apply loop. The company was already graded 6 or below. The payload gives you `name`, `title`, `url` (the posting or apply page), `ats`, `location`, `grade`, `summary`, `callback`, `board`, `brief` (this file). You read the application form, list what it asks, answer the screeners only from the candidate's answer bank, pick the CV, write one sentence, and POST one JSON back. You never log in, never type into a form, never click Apply or Submit. Reading a form's fields is fine; filling it is not.

## 1. Read the answer bank
GET `board` with header `x-secret: <RESEARCH_SECRET>`. Ignore everything in the reply except `answerBank` (markdown): it is the ONLY source for answers. Its "Aliases" table maps common phrasings to the lines above it. A line marked `TODO` counts as not covered. Anything not covered stays unanswered; the board marks it "needs the candidate" and nothing is submitted until he answers.

## 2. Read the form
- Open `url`. Stale means the ATS says so: closed, 404, or an ATS date older than 60 days (Greenhouse `first_published` / `updated_at`, Ashby `publishedAt`; a listed Lever or Comeet role is live). If stale, or not this title, send `"dropped": "stale"` and stop.
- Read the form. Most forms render in the browser, so a plain fetch of the page shows no fields; use the ATS data instead:
  - Greenhouse: `https://boards-api.greenhouse.io/v1/boards/<slug>/jobs/<id>?questions=true` returns `questions[]` (label, required, fields[].type: input_text / input_file / textarea / multi_value_single_select), `location_questions[]` (a required "Location" text field with hidden latitude/longitude; list the text field, skip hidden ones), `compliance[]` and `demographic_questions`. The slug and id are in the posting URL (or `gh_jid=`). Staleness: `updated_at`, falling back to `first_published`.
  - Lever: fetch `https://jobs.lever.co/<company>/<id>/apply`; the form is server-rendered and its inputs (name, email, phone, org, urls[LinkedIn], resume, custom `cards[...]` questions) are in the HTML.
  - Ashby: fetch `https://jobs.ashbyhq.com/<company>/<id>/application`; if the HTML carries no fields (React app), list the standard set, set `"formUnread": true` in `flags`, and say so in `errors`.
  - SmartRecruiters: `https://api.smartrecruiters.com/v1/companies/<Company>/postings/<id>` (public, no auth; `<Company>` and `<id>` are the two path parts of `jobs.smartrecruiters.com/<Company>/<id>-<slug>`) gives `name`, `location`, `releasedDate`, `applyUrl`. The apply form (`applyUrl`, i.e. the posting URL with `?oga=true`) is one page: first name, last name, email, confirm email, phone, city (optional), LinkedIn and other profile links (optional), resume file, an optional message to the hiring team (never written), a required privacy declaration checkbox (that is the answer bank's consent line, answer Yes, never a screener for the candidate), plus the company's screening questions when it added any (list them as screeners; the page renders them in-browser, so if a plain fetch shows none, say `formUnread` for the questions only).
  - Comeet: the posting page `https://www.comeet.com/jobs/<company>/<id>/<slug>/<jobid>` loads the form in an iframe from `https://www.comeet.co/jobs/<company-uid>/<position-uid>/apply`; the standard Comeet fields are first name, last name, email, phone, resume (file), website, portfolio (file), personal note, plus optional custom questions. If you cannot read the iframe, list the standard set and set `"formUnread": true`.
  - Workable (added 26 Oct 2026): the apply page `https://apply.workable.com/<account>/j/<shortcode>/apply/` renders in the browser. Standard fields: first name, last name, email, phone, resume (file); often a required Address (the answer bank's city, Tel Aviv, Israel), custom "Country" / "City" questions (Israel / Tel Aviv, from the bank) and yes / no questions (radios named QA_<n>): list each yes / no question as a screener with options ["YES", "NO"] and answer it from the bank exactly as the option reads; one the bank cannot answer stays open (the card forfeits). A plain fetch shows no fields: list the standard set, the questions you can read on the posting page, and set `formUnread` if you could read none.
  - BambooHR (added 26 Oct 2026): `https://<company>.bamboohr.com/careers/<id>` carries the form on the posting page: first name, last name, email, phone, resume (file), LinkedIn URL, sometimes Date Available, Website, "Who referred you" (all optional unless marked *), plus custom questions. A "Please leave this field blank" text field is a bot trap: never list it. The page renders in the browser; `https://<company>.bamboohr.com/careers/<id>/detail` gives the posting JSON (title, location, status) for staleness.
  If the form cannot be read at all, do not guess: standard set + `formUnread`.
- If `ats` is drushim, alljobs, linkedin or other, `url` is an aggregator listing, not the form. Find the same role on the company's own careers page or ATS (Greenhouse / Lever / Ashby / Comeet / SmartRecruiters / Workable / BambooHR) and use that URL and ATS. If it only exists on Drushim or AllJobs: keep that URL and `ats` (drushim / alljobs), list the standard identity set, set `"formUnread": true`, do NOT set `login` (the PC worker applies there with the candidate's logged-in account; the site's own CV dialog takes the tailored CV). If it only exists on LinkedIn or elsewhere, keep the URL, list the standard set, `formUnread: true`, say so in `errors`; the board forfeits it.
- Confirm the ATS from the URL: `jobs.lever.co` = lever, `jobs.ashbyhq.com` = ashby, `greenhouse.io` = greenhouse, `comeet.com/jobs` or `comeet.co/jobs` = comeet, `jobs.smartrecruiters.com` = smartrecruiters, `myworkdayjobs.com` = workday, `linkedin.com/jobs` = linkedin, `alljobs.co.il` = alljobs, else other. Send the apply URL in `apply.url` (for Comeet the posting URL is fine).
- List every field: `{name, label, type, required}` with `type` one of text, email, tel, url, file, textarea, select, checkbox (skip hidden inputs; call a field `url` when its label is a URL, even if the ATS says text). Trim labels. When two fields share a label (file + text alternatives), keep both; `name` tells them apart. A resume field that is optional is still filled: the runner always attaches the CV and ignores paste-text alternatives. Standard ones (first name, last name, email, phone, resume, LinkedIn, website, note) included.
- Any REQUIRED field that is not first name / last name / email / phone / resume is a question for the answer bank: list it ALSO in `screeners` (type text, options []) so it gets an answer or becomes "needs the candidate". LinkedIn Profile is the common case.
- List every screener question verbatim (trimmed) in `screeners`: `{q, type: "yesno" | "select" | "text" | "number", options: [...]}`.
- Flags: `login` if the form needs an account or sign-in, `captcha` if a visible captcha challenge blocks the form (an invisible reCAPTCHA badge is fine, and so is a passive hCaptcha script such as the one on every Lever form: the worker tries, and a challenge that actually shows stops it as blocked, never solved; the candidate, 23 Oct 2026), `coverLetterRequired` if a cover letter or a required free-text "why us" exists.

## 3. The package
- `cv`: `engineer-big` for AI / GenAI / LLM / solutions engineer / solutions architect, and for software / backend / full-stack / automation engineer (wider titles, 26 Oct 2026); `engineer-seed` only for founding engineer / product engineer at a tiny startup; `tpm` for Product Manager, Technical PM, AI PM, and for Customer Success, Technical Account and Growth seats. Nothing else exists.
- `title`: the job title verbatim as posted (trimmed). No rewording. `location`: as the posting says, trimmed; the posting wins over the payload. No keyword changes to the CV. No personal note, no cover letter text, ever.
- `answers`: one entry per screener you can answer from the bank, keyed by the exact question text. Leave the rest out.
  - "How did you hear about ..." is the bank's Defaults line (Company careers page, or its option-wording list). Never a friend, referral, word of mouth or LinkedIn (27 Oct 2026: Proseware got "From a friend.").
  - A privacy / terms / data-processing consent checkbox is answered "Yes" (the bank's consent lines), never left open (27 Oct 2026: Trey was forfeited on it).
  - One screener per question: when a field's short label ("Eligible to work", "Sponsorship") is the same question as a full-wording screener you already listed, do not list it again (27 Oct 2026: Proseware was forfeited on four such twins).
- `sentence`: one sentence for the morning brief, under 220 characters: what the company does, what the seat is, why it is a practice rep (use `grade` and `summary` from the payload).
- `errors`: free text for the morning brief, one line each: anything that will stop or complicate the submission (unreadable form, a required field with no answer, an odd ATS).

## 4. Output
POST ONE JSON object to `callback` with headers `Content-Type: application/json` and `x-secret: <RESEARCH_SECRET>`:

{
  "kind": "prep",
  "roleId": "<from payload>",
  "companyId": "<from payload>",
  "apply": {
    "url": "https://www.comeet.com/jobs/initech/12.345/generative-ai-engineer/AB.CDE",
    "ats": "comeet",
    "title": "Generative AI Engineer",
    "location": "Tel Aviv, Israel",
    "cv": "engineer-big",
    "sentence": "Initech is a 3,500-person Israeli integrator; this is a GenAI engineer seat on their AI practice, grade 4, a clean screen rep.",
    "fields": [{ "name": "firstName", "label": "First name", "type": "text", "required": true }, { "name": "cv", "label": "Resume", "type": "file", "required": true }],
    "screeners": [{ "q": "Are you legally authorized to work in Israel?", "type": "yesno", "options": ["Yes", "No"] }],
    "answers": { "Are you legally authorized to work in Israel?": "Yes" },
    "flags": { "login": false, "captcha": false, "coverLetterRequired": false }
  },
  "errors": []
}

Or, when the role is dead: `{ "kind": "prep", "roleId": "...", "companyId": "...", "dropped": "stale" }`.

Strings short, no markdown inside strings. Building the JSON in a temporary file to POST it is fine; that is not "writing files". Confirm `{"ok":true}`; if the POST fails, retry once, then stop and report. Final message, one line: company, title, ATS, number of screeners answered / unanswered. Do not write files, do not touch any repository.
