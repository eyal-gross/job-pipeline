# Answer bank (example)

The ONLY source the preparer agent may answer screener questions from. Keep your real one in `answer-bank.md` at the repo root
(gitignored) and push it to the board with the hunt `settings` action (`answerBank`). A line marked TODO counts as not covered:
the card is forfeited and the board shows "needs you" until you answer it. All values below are placeholders.

## Identity
- Full name: Jane Doe
- Email: you@example.com
- Phone: +972 50 000 0000
- City: Tel Aviv, Israel
- Country of residence: Israel
- LinkedIn: https://www.linkedin.com/in/your-profile
- Website / portfolio: (leave empty)

## Work facts
- Legally authorized to work in Israel: Yes
- Need sponsorship: No
- Years of experience (total): 4
- Years as a product manager: 1
- Most recent company / title: Example Startup / Co-founder
- Notice period / earliest start: immediately
- Salary expectation (number fields): TODO
- Degree: TODO

## Defaults
- How did you hear about us: Company careers page (picker wording, closest option: "Company website", "Careers page", "Online research")
- Privacy policy / terms / data-processing consent: Yes
- Interview-recording consent: Yes
- Ever employed by this company or its parent group: No
- Relatives or a business relationship at this company: No

## Demographics (only when the form makes them required)
- Gender: set `gender` in worker/config.local.json, or leave it empty to pick the decline option
- Race / ethnicity / veteran / disability: decline option

## Aliases
| Phrasing on the form | Answer line above |
| --- | --- |
| "Are you located in Israel?" | Country of residence |
| "Eligible to work" | Legally authorized to work in Israel |
| "Privacy declaration" | Privacy policy consent |
