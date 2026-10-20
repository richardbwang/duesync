# DueSync

USC deadlines from **Gradescope**, **Brightspace** and your **email** go into a
**Coursework** Google Calendar, every 10 minutes, running on Google's servers
(Apps Script). Your laptop can be closed.

## What you get

| Size | Example | On your calendar |
|---|---|---|
| small | reading response, quiz | deadline marker; reminders 1 day + 3 h before |
| medium | HW, problem set, presentation | + reminder 3 days out; 📌 all-day countdown banner every day for the last 3 days |
| big | PA / project | + reminders 14 / 7 / 3 / 1 days out; 📌 banner every day for the last 10 days |
| exam | midterm, final | big, with the banner from 7 days (midterm) / 14 days (final) out |

Every morning around 8am you get an email listing everything due in the next 7
days, soonest first, with ⚠️ on anything due within 48 hours (`testDigest()` sends one now).

Work blocks (time reserved in free slots) are off by default; set `WORK_BLOCKS: true`
in `Config.js` to have them booked.

From email (Claude Haiku reads USC mail that mentions a date):
- deadlines and exams → treated like any assignment above
- required events (things you registered/RSVPed for, interviews) → Coursework calendar
- optional events (club meetings, career fairs, talks) → **USC Events (maybe)** calendar, which you can toggle. To keep one, open it and change its calendar to your main one.
- read/unread is never changed. Checked emails get the `duesync/checked` label, and emails that added something get `duesync/added` too.

From syllabi: create a Google Drive folder named **duesync syllabi** (in the same
account) and drop each syllabus PDF or Google Doc in. Within 30 minutes Claude
pulls out exams and major deliverables. They get the same heads-up and study
blocks, marked "tentative". If Brightspace, Gradescope or an email later lists
the same thing within a week of that date, the real listing replaces it. Edit or
replace a file and it's re-read; remove it and its dates go away.

It keeps itself correct:
- Submitted on Gradescope → banner vanishes, deadline turns ✅. A Gradescope receipt email triggers a re-check right away.
- Finished a Brightspace/email item → rename its deadline event to start with ✅.
- Don't want it tracked → delete its deadline event.
- A source breaks or a login stops working → its last good data is kept, and you get an email (at most every 12 h).

## Settings

`Config.js` holds everything you might tune: rules for sizing (`RULES`), how much
heads-up each size gets (`TIERS`), your working hours (`SCHEDULE`), and which
emails count as required or optional (`EMAIL_POLICY`). Run `preview()` after
changing it to see the result without touching your calendar.

Secrets live in **Project Settings → Script Properties**:

| Property | Where it comes from |
|---|---|
| `BRIGHTSPACE_ICS_URL` | Brightspace → Calendar → Subscribe (treat like a password) |
| `GS_EMAIL`, `GS_PASSWORD` | Gradescope's own login. Set one via "Forgot password" on gradescope.com with your USC email; this doesn't change your USC password |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys. ~$0.50/month of credits, under 1¢ per syllabus |

## Functions (run from the Apps Script editor)

`setup()` installs the 10-minute trigger and runs the first sync. `preview()` dry-runs.
`status()` checks configuration. `testBrightspace()`, `testGradescope()`, `testEmail()`, `testSyllabi()` inspect one source.
`rereadSyllabi()` re-reads every syllabus on the next run.
`uninstall()` stops it.

## Development

`node --test test/test.js` runs the tests with fake Google services (parsers,
planner, calendar reconciliation, email flow, failure handling).
`clasp push` from `src/` deploys.
