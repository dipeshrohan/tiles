# Retrospective: the first two plans (months 1–12)

**Task:** T6.11 ([#103](https://github.com/dipeshrohan/tiles/issues/103)) · **Written:** 18 November 2026 · **Covers:** [ROADMAP.md](ROADMAP.md) (months 1–6), the [UI and UX plan](UI-PLAN.md) and [ROADMAP-2.md](ROADMAP-2.md) (months 7–12) · **Next:** [ROADMAP-3.md](ROADMAP-3.md) (draft)

Every number here comes from the repository: the checkboxes in [TASKS.md](TASKS.md), `git log` on `main`, the [changelog](../CHANGELOG.md) and the documents linked. Where a point needs the team's own view, it is marked `‹team: …›` instead of a guess.

## Contents

- [In short](#in-short)
- [Planned against delivered](#planned-against-delivered)
- [Pace](#pace)
- [What is still open, and why](#what-is-still-open-and-why)
- [What worked](#what-worked)
- [What didn't](#what-didnt)
- [Lessons, as practices](#lessons-as-practices)
- [For the team to add](#for-the-team-to-add)
- [Evidence](#evidence)

## In short

- **The software of both plans is built.** 146 of the 176 tasks in TASKS.md are checked off, and 1.0.0 was released on 18 October 2026 (#381, tag `v1.0.0`).
- **It was built ahead of the plans' calendar.** The plans run from 2 November 2026 to October 2027. The merges to `main` that built them ran from 7 to 19 October 2026.
- **What is open needs people outside the code:** the design partner, study participants, a native German speaker, screen-reader users and a penetration-test vendor. None of them has taken part yet, so no number in the ROI report, the copilot evaluation or the UI measures comes from a real plant or a real user.
- **Where the partner was missing, stand-ins were used:** four sample plants (#370, #371, #373, #374), a suggestions fixture and a known plant for the copilot evaluation. Some tasks were checked off against them. That is useful work, but it is not the same as the partner's data (see [what didn't](#done-when-met-on-stand-ins)).

## Planned against delivered

From the checkboxes in [TASKS.md](TASKS.md) on `main` at `2f73809`. Estimates are engineer-days as TASKS.md gives them; ongoing tasks have none.

| Plan | Tasks | Done | Open | Days done | Days open | Pull requests | Merged |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| [Months 1–6](TASKS.md#month-1-foundations-nov-2026) | 95 | 79 | 16 | 200.5 | 35.5 | #107–#196 | 7–10 Oct |
| [UI and UX track](TASKS.md#ui-and-ux-track-nov-2026--apr-2027), months 1–6 | 53 | 47 | 6 | 131 | 17.5 | #259–#315 | 10–15 Oct |
| [Months 7–12](TASKS.md#months-712-deeper-on-the-pilot-line-may--oct-2027) | 23 | 20 | 3 | 71 | 7 | #356–#380 | 16–18 Oct |
| Ongoing (T0.01–T0.03, U0.01, U0.02) | 5 | 0 | 5 | — | — | — | — |
| **All** | **176** | **146** | **30** | **402.5** | **60** | | |

By month of the first plan:

| Month | Tasks | Done | Open |
| --- | ---: | ---: | --- |
| 1: Foundations | 19 | 19 | — |
| 2: Real data in | 17 | 15 | T2.16, T2.17 |
| 3: Operations analytics on real data | 15 | 12 | T3.06, T3.14, T3.15 |
| 4: Copilot and Design Studio | 15 | 13 | T4.05, T4.06 |
| 5: Pilot in production and enterprise hardening | 18 | 15 | T5.01, T5.02, T5.03 |
| 6: Prove value and ship v1.0 | 11 | 5 | T6.01, T6.02, T6.03, T6.07, T6.09, T6.11 |

By month of the UI track: month 1 has 8 of 9 done (U1.01 open), months 2, 3 and 4 are all done (9, 8 and 10 tasks), month 5 has 8 of 9 (U5.08 open) and month 6 has 4 of 8 (U6.03, U6.04, U6.07 and U6.08 open).

By month of the second plan: months 8 to 11 are all done (5, 3, 4 and 4 tasks); month 7 has 3 of 4 (T7.04 open) and month 12 has 1 of 3 (T12.02 and T12.03 open). ROADMAP-2's totals line says 24 tasks; its list has 23.

Every ◇ stretch item of the first plan was delivered (T3.13, T4.08, T4.09, T4.15, T5.05, T6.10), and so were the UI track's (U3.08, U4.10, U5.09). The risk table says so: "No ◇ items left open; nothing to cut" ([ROADMAP.md](ROADMAP.md#risks-and-mitigations), reviewed in #316).

## Pace

Pull requests merged to `main` by day (first-parent history, each naming its pull request):

| Day | Merged | What |
| --- | ---: | --- |
| 6 Oct | 0 | The demo, the roadmap and the task list, before PR #1 |
| 7 Oct | 21 | PR #1, then month 1 (#107–#121) and the edge agent (#122–#126) |
| 8 Oct | 19 | Months 2 and 3: ingest, signals, quality, ontology at scale, models, detection, warnings (#127–#145) |
| 9 Oct | 36 | Months 3 to 6: analysis, copilot, Design Studio, security, deployment, operations, docs (#146–#188) |
| 10 Oct | 32 | The last of months 4–6 (#189–#196), the UI plan (#259) and UI months 1 and 2 (#260–#283) |
| 11–12 Oct | 3 | UI month 3's last (#284, #285) and a fix (#286) |
| 14 Oct | 6 | UI month 4 begins (#287–#292) |
| 15 Oct | 25 | UI months 4 to 6 (#293–#315), the risk review (#316) and the ROI report (#317) |
| 16 Oct | 4 | Pen-test brief (#324), partner evaluation (#325), ROADMAP-2 (#326), line coverage (#356) |
| 17 Oct | 6 | Months 7, 9, 10 and 12 (#357–#362) |
| 18 Oct | 19 | Months 9 to 11, the sample plants, and release 1.0.0 (#363–#382) |
| 19 Oct | 1 | The release workflow run by hand (#383) |
| 20 Oct – 17 Nov | 0 | — |
| 18 Nov | 5 | Dependency updates and CI on the new runners (#166, #318, #319, #392, #393) |

**By calendar month:** 172 merged pull requests in October 2026 and 5 in November; 727 commits on `main` in all (722 and 5).

**Against the plans' calendar:** the first plan's month 1 is November 2026 and its month 6 is April 2027 (TASKS.md's headings). By git history, the software for all twelve months was on `main` by 18 October 2026, two weeks before month 1 begins. So the partner and people tasks that are open are not yet late against their own months (T2.16 and T2.17 fall in December 2026), but they are the only work left, and the risk table already calls the partner "Open, and now blocking" ([ROADMAP.md](ROADMAP.md#risks-and-mitigations)).

`‹team: how many people built this, how the work was shared between people and coding agents (most commits carry a Claude-Session trailer), and whether the pace can be kept or was a one-off›`

## What is still open, and why

| Waiting on | Tasks | What is ready for it |
| --- | --- | --- |
| **The design partner** | T2.16, T2.17, T3.06, T3.14, T3.15, T4.05, T4.06, T5.01, T5.02, T5.03, T6.01, T6.02, T6.03, T7.04, T12.02 | The [assessment kit](pilot/assessment.md) (T2.15), the [security review pack](security/partner-review.md), the [question guide](pilot/copilot-questions.md) and CSV template (#325), the edge agent, imports, the backtest and the ROI report (T6.01's note in TASKS.md) |
| **Study participants and pilot users** | U1.01, U6.07, U5.08 | The [study kit](ui/research/README.md) with `npm run study` (#315) and the [field round](pilot/field-round.md) (#305) |
| **A native German speaker** | U6.03 | German in `js/i18n/de.json`, with new strings marked for review (CLAUDE.md, Languages) |
| **Screen-reader users** | U6.04 | The [accessibility report](ui/accessibility.md) and its five flows; the automated checks pass |
| **A penetration-test vendor** | T6.07 | The [brief](security/pentest-brief.md) (#324) |
| **A deployment on the pilot** | T6.09, T12.03 | `v1.0.0` is tagged and released (#381, #383); deploying it to the pilot waits on T2.17 |
| **A reviewer of a new page** | U6.08 | The [UI handbook](ui/README.md) (#314); its *Done when* needs a new page to pass review with it |
| **Itself** | T6.11 | This retrospective and the draft [ROADMAP-3](ROADMAP-3.md) |

Every task on the [critical path](TASKS.md#critical-path) after T2.06 that is open waits on T2.17, the partner's data access.

## What worked

- **One task, one branch, one pull request, its ID in the title.** Branches named for tasks (`t201-edge-agent` #122 to `t610-app-studio` #187, `ui-*` #260–#315) make the plan traceable to the code. This retrospective could count delivery from `git log` alone.
- **Logic that runs twice is tested twice against one fixture.** The ontology (`test/fixtures/ontology-parity.json`), detection, correlation, wear, the plunger, the design models and the failure-mode models each have a JSON fixture both the browser and the API must pass (ADR [001](adr/001-stack.md), CLAUDE.md). `‹team: whether a fixture ever caught the two sides disagreeing›`
- **Rules enforced by checks, not by memory.** Stale bundles and help, broken doc links, hard-coded text, inline styles, locale-bound formatting, missing page help and missing tour targets each fail `npm test` or `npm run lint` (CLAUDE.md, Commands and Rules). The UI track's consistency targets were met by checks (U1.03: ≤ 20 inline styles, checked in CI).
- **Kits made before the people arrived.** The assessment (#191), the security pack (#193), the pen-test brief (#324), the study kit (#315), the field round (#305) and the partner question set (#325) mean the open tasks can start on the day the partner or vendor does.
- **The load test found a real fault.** At twice the target, requests stalled on database connections; `store.db_slot` fixed it, with a test that stalled before the fix ([load test](load-test.md#what-the-test-found), T5.15, #173).
- **Sample plants as a stand-in partner.** A year of four plants (die casting, battery cells, graphene film, biologics), each "as a partner hands it over", with known gaps and ground truth (#370–#374). The failure-mode models (#375), their binding (#376) and the process model (#377) were chosen and backtested on the die-casting plant, "standing in for the design partner's line until its year of data arrives" ([failure modes](failure-modes.md)).
- **The ROI method was fixed before there were results.** The report keeps a SHA-256 digest of its inputs and every event it counted (T6.01, #317), and ROI v2 keeps the same digest method (T12.01, #362), so the first real report can't be tuned after the fact.
- **Security planned as a list of gaps with owners.** The threat model's actions ([threat model](security/threat-model.md#actions)) and the readiness plan's controls ([compliance readiness](security/compliance-readiness.md)) each say Done, Partial or Gap, with evidence. Seven of the threat model's eleven actions are done; G-D2, G-E1, G-E3 and G-E4 / G-S2 are open.

## What didn't

### The partner, and so the plans' goals

Neither plan's goal is met. The first plan's goal is "Tiles v1.0 running on one real production line", with a measured ROI ([ROADMAP.md](ROADMAP.md#six-month-goal)); the second's is three times that return, signed by the partner ([ROADMAP-2.md](ROADMAP-2.md#goal)). With no partner (T2.16, T2.17 open), every exit check from month 2 onwards that names partner data is unmet: TASKS.md's month 2, 3 and 5 exit checks, and month 6's "ROI report signed off". The building went ahead anyway, so the gap between software and evidence grew from month 2's two open tasks to the fifteen partner tasks listed under [what is still open](#what-is-still-open-and-why). `‹team: where the partner search stands, and what it would take to close T2.17›`

### Done-when met on stand-ins

Some tasks are checked off with their *Done when* met on a stand-in, not on what it names:

- **T2.11:** "at least 70% of suggestions are accepted on the partner's tag list". The suggestions are scored against `api/tests/fixtures/suggestions.json` (CLAUDE.md).
- **T8.01:** ROADMAP-2 has it chosen "with the partner". The three failure modes were chosen from the die-casting sample plant's stops and costs ([failure modes](failure-modes.md)).
- **T8.05:** "bound on the line". Loading the sample plant binds them on its Line 2 (CHANGELOG 1.0.0).
- **T11.01:** "held-out history" is the sample plant's April to September ([process model](process-model.md)).
- **T6.06:** "onboarding a new machine takes under 1 day" has not been timed on a real site.

The tracker also drifted from TASKS.md:

- Issues [#15](https://github.com/dipeshrohan/tiles/issues/15) (T1.02) and [#51](https://github.com/dipeshrohan/tiles/issues/51) (T3.05) are open, but checked off in TASKS.md.
- T1.02's *Done when* says "`main` is protected", while the readiness plan still lists branch protection on `main` as an action (CM-1, [compliance readiness](security/compliance-readiness.md)).
- `v1.0.0` is tagged, but T6.09 stays open, as its deploy to the pilot hasn't happened.

### CI broke while nothing changed

The workflows run on `ubuntu-latest` (19 jobs in `.github/workflows/`). Between 19 October and 18 November nothing was merged. In that time the runners moved to Ubuntu 26.04 and new advisories landed, so `main`'s checks "would fail on both" (#392). Getting green again took one pull request touching:

- the kind cluster's image loading;
- Playwright and its container;
- axe 4.14's new rule (two pages' accessible names);
- the morph patcher;
- a print test;
- uv, certifi and pypdf for image-scan criticals.

Nobody noticed the red build until a pull request needed it. `‹team: was there a scheduled CI run, and who would have seen it fail?›`

### Releasing from an agent's session

A tag can't be pushed from an agent's session. 1.0.0's release commit landed on 18 October (#381). The tag needed a new way in: running the Release workflow by hand with a version and a commit (#383, [releasing](releasing.md)). The tag is dated 19 October.

### Dependency age, written down nowhere

#392 took only updates "at least two weeks old" and held paho-mqtt 2.2.0 and a lucide-static release back. #393 took paho-mqtt 2.2.0 once it was two weeks old. The rule isn't in [CONTRIBUTING](../CONTRIBUTING.md) or in [`.github/dependabot.yml`](../.github/dependabot.yml), so it lives in commit messages.

Meanwhile Dependabot pull requests waited:

- #166, #318 and #319 were merged on 18 November.
- [#169](https://github.com/dipeshrohan/tiles/pull/169) (TypeScript 7), open since 9 October, stays open: [ADR 001](adr/001-stack.md) pins TypeScript to 6.0.x until typescript-eslint supports 7.

The readiness plan's VM-1 already asks for deadlines and triage of the open Dependabot pull requests ([compliance readiness](security/compliance-readiness.md)). A high advisory with no fixed release (picomatch) is now allowed until a date, in `scripts/npm-audit-allow.json`, which expires on 15 December 2026 (#392).

### People-run checks haven't run

The UI plan's measures (SUS, task success, time on task) have no baseline: U1.01 hasn't run, so U5.04's and U5.05's "under half the U1.01 time" can't be checked ([UI plan](UI-PLAN.md#goals-and-measures)). German shipped in 1.0.0 (CHANGELOG), but U6.03 waits on a native speaker's review. The screen-reader flows of U6.04 are not walked. Of the ongoing reviews (T0.01, T0.02, U0.01, U0.02), the only one in the history is the October risk review (#316).

### Review at this pace

172 pull requests in 13 days. The plan assumed a team of about six, with review time in its estimates (TASKS.md's totals). Branch protection with required reviews is not on (CM-1). `‹team: who reviewed what, and whether the review matched the plan's quality bar›`

## Lessons, as practices

1. **Gate building on evidence.** A plan's month that names partner data starts its build only when the month before has its evidence, or says which stand-in it uses. ROADMAP-3 writes each month's gate down.
2. **Name the stand-in in the checkbox.** A task met on a sample plant or a fixture says so in TASKS.md (for example "done on the die-casting sample plant"), and a follow-up task holds the real check. ROADMAP-3's T13.02 does this for the tasks above.
3. **One source of done.** Closing the issue and checking the box happen in the same pull request; a monthly script or review compares TASKS.md with the open issues (the drift on #15 and #51).
4. **CI runs when nobody pushes.** A scheduled weekly run of the full CI on `main`, with the runner image named (`ubuntu-24.04` or `ubuntu-26.04`, not `ubuntu-latest`) and moved on purpose, in its own pull request.
5. **Write the dependency rules where the tools read them.** The two-week age as Dependabot's `cooldown`, the advisory deadlines of VM-1 in CONTRIBUTING, and a monthly owner for the Dependabot queue.
6. **Release by the workflow.** Running the Release workflow with a version and a commit is the normal way, not the fallback; [releasing](releasing.md) says so, and T12.03 (v1.1) is done that way.
7. **Book people early.** The study participants, the native speaker, the screen-reader users and the pen-test vendor have lead times longer than the build. Each gets a date before the month that needs it.
8. **Keep the kits.** Making the partner's, vendor's and participants' kits before they arrive worked; keep doing it for the second site.

## For the team to add

- `‹team: what the plan got wrong about what was hard›`
- `‹team: what felt slow or wasteful, beyond what the history shows›`
- `‹team: whether the plans' calendar (November 2026 to October 2027) still holds, or should move to the partner's date›`
- `‹team: the state of the partner search, and other prospects›`
- `‹team: which sample plant matches the likeliest second site›`

## Evidence

- **Task status:** [TASKS.md](TASKS.md) on `main` at `2f73809`; open issues on GitHub (51 on 18 November 2026, including the monthly parent issues).
- **Delivery and pace:** `git log --first-parent main`, merged pull requests #1 and #107 to #393.
- **What shipped:** the [changelog](../CHANGELOG.md)'s 1.0.0 and 1.1.0 sections.
- **Plans:** [ROADMAP.md](ROADMAP.md) and its risk table, [ROADMAP-2.md](ROADMAP-2.md), the [UI plan](UI-PLAN.md).
- **Decisions:** the ADRs in [docs/adr](adr/README.md).
- **Security:** the [threat model](security/threat-model.md#actions), the [readiness plan](security/compliance-readiness.md), the [partner pack's open items](security/partner-review.md#open-items) and the [pen-test brief](security/pentest-brief.md).
- **Operations:** the [load test](load-test.md), [releasing](releasing.md).
- **Stand-ins:** the [failure modes](failure-modes.md), the [process model](process-model.md), the sample plants in `data/sample-plants/`.
