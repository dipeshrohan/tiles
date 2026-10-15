# Usability studies

The moderated test behind the UI plan's [measures](../../UI-PLAN.md#goals-and-measures): the baseline (U1.01) and the second round (U6.07) run this same script, so their numbers compare. Each round records two files and scores them with `npm run study`; its report goes beside them.

## Contents

- [Rounds](#rounds)
- [Participants](#participants)
- [Setting up](#setting-up)
- [The session](#the-session)
- [The tasks](#the-tasks)
- [The questionnaire](#the-questionnaire)
- [Recording](#recording)
- [Scoring and the report](#scoring-and-the-report)

## Rounds

| Round | Task | Folder | Report |
| --- | --- | --- | --- |
| Baseline | U1.01 | `2026-11-baseline/` | `2026-11-baseline.md` |
| Second | U6.07 | `2027-04-v1/` | `2027-04-v1.md` |

Copy [template/](template/) to the round's folder, and [report-template.md](report-template.md) to its report.

## Participants

- At least 8 per round, from the pilot site where possible, across the roles the welcome offers: process engineers, shift leads, technicians and an admin.
- Not people who build Tiles, and in the second round, people who weren't in the baseline where possible (note who was in both).
- Each gets a participant code (`P01`, `P02`…); names stay with the moderator, never in this repository.
- Ask for consent to record the screen and voice, and say it is the software being tested, not them.

## Setting up

- Tiles with the API, signed in as a fresh user for the participant's role, on a study site holding the copilot evaluation's plant (`load` in `api/src/tiles_api/evaluation/plant.py`: Line 2's die-casting cells DC-01 and DC-02, three days of readings, two warnings, a start-up SOP), loaded again before each session so every participant, in both rounds, sees the same machines, warnings and signals. The tasks below are written for it; with another plant, change the cards for both rounds.
- For the first-page task, a user who has never signed in (the welcome shows), and a second site with no plant model for the site task.
- A laptop at 1440 × 900 for the desktop tasks; the shop-floor tasks of the field round are tested in [the field round](../../pilot/field-round.md), not here.
- A stopwatch or the recording's clock. One moderator, and one note-taker where possible.

## The session

About 60 minutes:

1. **Welcome (5 min):** consent, and think aloud: "Say what you look for and what you expect as you go."
2. **First page (5 min):** the [first-page task](#the-tasks), before anything else.
3. **Tasks (35 min):** the rest in the order below. Read each task aloud and hand it over on a card. Start timing when the card is down; stop when the participant says they are done, or at 5 minutes.
4. **Questionnaire (5 min):** [the SUS](#the-questionnaire), on paper or a form, before any discussion.
5. **Debrief (10 min):** what was hardest, what they'd change, and anything they expected that wasn't there.

**Helping:** don't, unless the participant is stuck for a minute or asks twice. Any hint makes the task _assisted_, which counts against success without help. Note what was said.

## The tasks

Each card says the goal in the participant's words, never the page's name or a button's.

| Key | Card | Starts on | Success when |
| --- | --- | --- | --- |
| `first-page` | "You've just been given access to Tiles. Get to where you'd start your working day." | The sign-in | Their role chosen in the welcome, and a page with their own work open (timed; target under 2 minutes, U4.06) |
| `home-now` | "What needs your attention right now?" | Home | They name the open warnings or reviews waiting for them, from Home (U5.01) |
| `triage` | "A die-casting cell has raised a warning. Decide whether it's real and hand it to the right person." | Home | The warning acknowledged and assigned, with a comment (timed) |
| `plot` | "Show how DC-01's hydraulic pressure has behaved over the last three days." | Home | A chart of that signal over the three days (timed) |
| `commit` | "Line 2 has a new trim press, TP-04. Add it to the plant model and get the change approved." | Home | A change request with TP-04 under Line 2, opened for review (timed; a second engineer approves it) |
| `correlate` | "Here's a spreadsheet of last month's batches. Find what goes with scrap." | Home, with `batches.csv` on the desktop | The correlation run, and the strongest effect named |
| `copilot` | "Ask Tiles whether DC-01's hydraulic pressure is where its start-up procedure wants it." | Home | A question asked, and the answer's evidence opened |
| `site` | "Your company is adding the Linz plant. Get it ready for its engineers." | Settings, as an admin | The new site made and its plant outlined in the wizard (the agent and mapping steps need the plant's network and are left) |

The outcomes are `success` (done without help), `assisted` (done after a hint) and `fail` (not done, given up, or out of time).

## The questionnaire

The System Usability Scale, in the participant's language, each answered from 1 (strongly disagree) to 5 (strongly agree):

1. I think that I would like to use Tiles frequently.
2. I found Tiles unnecessarily complex.
3. I thought Tiles was easy to use.
4. I think that I would need the support of a technical person to be able to use Tiles.
5. I found the various functions in Tiles were well integrated.
6. I thought there was too much inconsistency in Tiles.
7. I would imagine that most people would learn to use Tiles very quickly.
8. I found Tiles very cumbersome to use.
9. I felt very confident using Tiles.
10. I needed to learn a lot of things before I could get going with Tiles.

## Recording

Two CSV files in the round's folder, one row per participant and task, and one per participant:

- `tasks.csv`: `participant,role,task,outcome,seconds,notes`. `task` is a key from [the tasks](#the-tasks); `seconds` is required for a success and may be left empty otherwise; `notes` is what happened, quoted when it has commas.
- `sus.csv`: `participant,q1,…,q10`, each answer 1 to 5.

Problems seen go in the report's problem list, each with how many participants hit it and how badly (blocks the task, slows it, annoys), and the task in [the UI plan](../../UI-PLAN.md) that fixes it.

## Scoring and the report

```sh
npm run study -- docs/ui/research/2026-11-baseline
npm run study -- docs/ui/research/2027-04-v1 --baseline docs/ui/research/2026-11-baseline
```

It prints the measures as a Markdown table: the mean SUS, success without help on each key task, the median time of the successes on the timed ones, and the first-page and Home tasks, each against its target (`scripts/study.js`; `test/study.test.js` checks the scoring). The SUS target is 75 and 10 more than the baseline; the time targets are 30% under the baseline's medians. Paste the table into the report, then write the problem list and what changes because of it. For the baseline, also fill in the plan's measures table.
