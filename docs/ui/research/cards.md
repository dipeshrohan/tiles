# Task cards

The study's tasks, one section each, in the order of [the session](facilitator.md). Print this page, cut the **Card** box off each section and hand it to the participant; the rest is for the moderator and the note-taker. The cards are written for the evaluation plant that [setup](setup.md) loads, so every participant, in both rounds, gets the same task on the same data. The keys are the ones `tasks.csv` and `npm run study` use ([recording](README.md#recording)).

**For every task**

- Read the card aloud, then put it down in front of the participant. Start timing when it is down. Stop when they say they are done, or at the time limit.
- **Outcome:** `success` (done without help), `assisted` (done after any hint, see [helping](facilitator.md#helping)), `fail` (not done, given up, or out of time). A task the participant says is done but isn't is a `fail`.
- **Errors:** count each wrong step the participant had to notice and undo, or that took them away from the goal: a wrong page opened from the menu, a wrong control used, a form Tiles refused, a dead end they backed out of. Looking around without acting isn't an error. Write the count in `errors` and what each was in `notes`.
- The **expected path** is one way through, for the note-taker to follow along. Any other way to the same result is a success.

## Contents

- [`first-page`](#first-page) · [`home-now`](#home-now) · [`triage`](#triage) · [`plot`](#plot) · [`commit`](#commit) · [`correlate`](#correlate) · [`copilot`](#copilot) · [`site`](#site)

## `first-page`

> **Card:** You've just been given access to Tiles. Get to where you'd start your working day.

- **Measures:** reach a first useful page as a new user (U4.06).
- **Starts on:** the welcome, open for the participant's new user ([the participant's browser](setup.md#the-participants-browser)). With a real sign-in it would start on the sign-in page; the development sign-in has none.
- **Success when:** they choose a role in the welcome and end on a page with their own work on it (Home's cards, Warnings, Shopfloor or what their role's start page is), and say that is where they'd start.
- **Time limit:** 5 minutes. The target is a median under 2 minutes, so time it to the second.
- **Expected path:** the welcome, a role (Engineer, Maintenance, Shift lead or Admin), then the start page the welcome offers.
- **Note:** which role they chose and why, in their words; whether they read the welcome's text or skipped it.

## `home-now`

> **Card:** What needs your attention right now?

- **Measures:** Home answers "what needs me now?" (U5.01).
- **Starts on:** Home, as the first-page task left it. If they left Home, open it from the menu before the card goes down.
- **Success when:** from Home, they name what is waiting for them: the two open warnings nobody has taken, and that no review waits for them (or what their role's cards show).
- **Time limit:** 5 minutes.
- **Expected path:** read Home's cards. Which cards show depends on the role chosen in the welcome.
- **Note:** an engineer's Home has no warnings card (the review's [H-03](../heuristic-review-2026-11.md#h-03-home-for-an-engineer-leaves-out-the-open-warnings)): note whether they found the warnings from the menu's count instead. That counts as an error if they leave Home to answer, and as a `fail` if they answer without the warnings.

## `triage`

> **Card:** A die-casting cell has raised a warning. Decide whether it's real and hand it to the right person.

- **Measures:** triage a warning (timed).
- **Starts on:** Home.
- **Success when:** one of the two warnings is acknowledged and assigned to `maintenance` (the only other person on the site who isn't the moderator), with a comment in its activity.
- **Time limit:** 5 minutes.
- **Expected path:** **Warnings** in the menu (it shows 2), a warning's row, its chart and activity, **Acknowledge**, **Assign to** `maintenance` and **Assign**, a note and **Comment**. The Shopfloor page's **Details** reaches the same warning.
- **Note:** whether they could tell the two warnings apart, and whether they looked for which machine it was on.

## `plot`

> **Card:** Show how DC-01's hydraulic pressure has behaved over the last three days.

- **Measures:** find a signal and plot it (timed).
- **Starts on:** Home.
- **Success when:** a chart of `dc01.hydraulic_pressure` whose range covers the plant's three days (72 hourly readings; the chart's foot says how many it drew).
- **Time limit:** 5 minutes.
- **Expected path:** **Data explorer**, `dc01.hydraulic_pressure` from **Add a signal** (or the search box: "hydraulic"), then **Last 7 days**, or **From** and **To** three days apart, and **Show**. The command palette (Ctrl K) finds the signal by "hydraulic" too.
- **Note:** where they looked first (Signals, Plant, Ontology, Data explorer, the palette), and whether the default 24 hours satisfied them.

## `commit`

> **Card:** Line 2 has a new trim press, TP-04. Add it to the plant model and get the change approved.

- **Measures:** commit an ontology change through review (timed).
- **Starts on:** Home.
- **Success when:** a change request with a Machine labelled with TP-04, contained by Line 2, is open for review (**Change reviews** lists it). Stop the clock there, then approve it as the moderator ([during the session](setup.md#during-the-session)) and let them see it committed.
- **Time limit:** 5 minutes.
- **Expected path:** **Ontology builder**, **New node**: **Type** Machine, **Label** "TP-04 trim press", **Link from** Line 2, **Relationship** contains, **Stage node**, then a message and **Request review**. A direct **Commit** is a `fail` for this task: the card asks for approval.
- **Note:** whether they knew the change was waiting for someone and where to see it after the canvas stopped showing it.

## `correlate`

> **Card:** Here's a spreadsheet of last month's batches. Find what goes with scrap.

- **Measures:** run a correlation on a batch table.
- **Starts on:** Home, with `batches.csv` on the desktop ([once, on the study laptop](setup.md#once-on-the-study-laptop)). Tell them `ng` means scrapped if they ask; that isn't a hint.
- **Success when:** the correlation is run and they name front stock tension (`tension`) as the setting that goes with scrap. Splitting by `material` shows it: failed anode batches ran tension higher, failed cathode batches lower. Without the split Tiles finds no large effect.
- **Time limit:** 5 minutes.
- **Expected path:** **Correlation finder**, **CSV file** `batches.csv`, **Upload**, then **Split by** material and **Find**.
- **Note:** whether they tried a split, and what they made of "No large, clear effect".

## `copilot`

> **Card:** Ask Tiles whether DC-01's hydraulic pressure is where its start-up procedure wants it.

- **Measures:** ask the copilot about a machine.
- **Starts on:** Home. Needs the copilot service ([once, on the study laptop](setup.md#once-on-the-study-laptop)); without it, leave this task out and don't write a row.
- **Success when:** they ask a question about it and open one of the answer's evidence links or citations. SOP 14 says 140 to 160 bar; the latest reading is 152 bar.
- **Time limit:** 5 minutes.
- **Expected path:** **Copilot** in the menu, the question typed and sent, a numbered citation or evidence link in the answer.
- **Note:** whether they trusted the answer, and whether they checked it against the SOP or the chart.

## `site`

> **Card:** Your company is adding the Linz plant. Get it ready for its engineers.

- **Measures:** set up a new site.
- **Starts on:** Settings, with the participant made an organisation admin just before ([during the session](setup.md#during-the-session)).
- **Success when:** a site for Linz exists and its plant is outlined in the wizard (a workcenter, a line and at least one machine). The edge agent and mapping steps need the plant's network: stop when they reach them.
- **Time limit:** 5 minutes.
- **Expected path:** **Set up a site** at the foot of the menu, beside Settings; step 1 **Create the site**: **Name** Linz, its short name, **Time zone** Europe/Vienna, **Create the site**, open it, then **Outline the plant**.
- **Note:** whether they found the wizard from Settings, and whether they noticed that the wizard first shows Plant 1's steps as done.
