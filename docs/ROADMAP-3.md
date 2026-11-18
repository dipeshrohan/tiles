# Tiles: months 13 to 18

> **DRAFT for approval.** Nothing here is agreed. It has no GitHub issues yet: they are listed at the end, to create once the plan is approved.

**Window:** Nov 2027 – Apr 2028, after v1.1, if the partner tasks below keep their dates · **Status:** draft, for review · **Before it:** [ROADMAP-2.md](ROADMAP-2.md) · **Why this plan:** [the retrospective](retrospective-2026.md)

## Goal

**Two lines on real data, and ready for a second customer.** ROADMAP-2 builds the whole pilot line, more failure modes, planned work, causes and recommendations. The [retrospective](retrospective-2026.md#what-didnt) shows the software is built but has not yet run on a partner's data: the models were chosen and backtested on the die-casting sample plant. This plan moves those results onto the partner's history, adds a second line or site, prepares a second industry from the sample plants, compares sites, and closes the security items a second customer will ask about.

**Done when:** the pilot line and a second line each have an ROI report on their own history, made the same way as v1.0's, and the partner signs both; the penetration test's high and critical findings are fixed; and a SOC 2 Type I readiness assessment finds nothing that would qualify the report.

## Before it starts

This plan assumes the earlier plans' open tasks are done. They stay under their own IDs and issues, and are not repeated here:

| Waiting on | Tasks |
| --- | --- |
| The design partner | T2.16, T2.17, T3.06, T3.14, T3.15, T4.05, T4.06, T5.01–T5.03, T6.01–T6.03, T7.04, T12.02 |
| People | U1.01, U5.08, U6.03, U6.04, U6.07, U6.08 |
| A vendor | T6.07 (penetration test) |
| Release | T6.09 (v1.0 on the pilot), T12.03 (v1.1) |

If T2.17 (the partner's data) hasn't happened by month 12, this plan is re-planned rather than started: months 13 and 14 need it, and the rest builds on them.

## Where it starts

| Have | Use it for |
| --- | --- |
| Failure-mode models, process model and recommendations, backtested on the die-casting sample plant ([failure modes](failure-modes.md), [process model](process-model.md)) | The same backtests on the partner's history |
| Detector templates, line coverage map, onboarding wizard | A second line, set up from the first |
| Four sample plants: die casting, battery cells, graphene film, biologics (`data/sample-plants/`) | A second industry's models and copilot questions before its customer's data arrives |
| ROI report v2, per machine and per model, with its digest | A report per line, and comparisons between sites |
| Row security per site, organisations with their own sign-in | Reading across an organisation's sites, safely |
| Threat model actions and the readiness plan's controls ([threat model](security/threat-model.md#actions), [compliance readiness](security/compliance-readiness.md)) | The security work a second customer's IT review asks for |

## Principles

1. **Read-only stays read-only.** As in ROADMAP-2: Tiles never writes to a PLC.
2. **Each month has a gate.** A month whose work needs partner data starts only when the month before has its evidence. A stand-in (a sample plant, a fixture) is named in the task's checkbox when it is used.
3. **Every model earns its place on each line.** A model or template that worked on one line is backtested again on the next line's history before it goes live there.
4. **Measure as v1.0 measured.** The same baseline method, ROI method and digest on every line.

## Monthly plan

### Month 13: Real data under the models

**Goal:** what ROADMAP-2 proved on the sample plant, proved again on the partner's history.

- **Re-run on the partner's history:** detector templates, the three failure-mode models, the process model and the recommendations' sweeps, each report kept beside its sample-plant one.
- **Stand-in audit:** every task checked off against a stand-in (T2.11, T6.06, T8.01, T8.05, T11.01) checked again on the partner's data, and TASKS.md says which held.
- **A healthy build when nobody pushes:** CI on a schedule, the runner named, and the dependency rules written down.

**Gate:** T2.17 and T7.04 done. **Done when:** every model live on the pilot line has a backtest on the partner's own history that beats its target, and the stand-in audit is merged.

### Month 14: A second line

**Goal:** a second line or site running, set up from the first in days, not weeks.

- **Choose it** with the partner, scored the way the [assessment](pilot/assessment.md#choosing-the-pilot-problem) scores pilot problems.
- **Onboard it with the wizard,** timing each step, so T6.06's "under one day per machine" is measured.
- **Templates across lines:** the pilot line's detector templates and model bindings applied to the new line, each backtested on its own history.

**Gate:** T12.02 signed. **Done when:** every machine on the second line has its signals mapped and a tuned detector, its coverage map shows no unexplained gaps, and the onboarding times are recorded.

### Month 15: A second industry

**Goal:** models and copilot questions for the next customer's industry, ready before its data.

- **Choose the industry** from the sample plants (battery cells, graphene film or biologics) to match the likeliest next customer, and its three failure modes by cost, as [failure modes](failure-modes.md) did for die casting.
- **A model for each,** through the registry, with a parity fixture where the browser runs it, backtested on that sample plant's year.
- **Its copilot questions** in the evaluation, from the sample plant's question set.
- ◇ **Genealogy in the correlation finder:** a cell's, roll's or vial's upstream batch, coil or lot as columns, from the sample plants' genealogy.

**Done when:** three models for the second industry beat their targets on its sample plant, and its question set passes the evaluation gate.

### Month 16: Across sites

**Goal:** an organisation sees its sites side by side.

- **Cross-site benchmarking:** each site's warning performance, time to cause and ROI figures per day or per 1,000 parts, for the organisation's admins.
- **One library per organisation:** a detector template or model version published once and used on every site.
- **The security review updated** for reads that span sites.

**Done when:** an organisation admin compares the two sites, and tests show a site's members still can't read another site's rows.

### Month 17: Ready for a second customer's IT review

**Goal:** the open security items closed, and the audit prepared.

- **The threat model's open actions:** signed images and releases (G-E4 / G-S2), edge tokens that expire (G-E1), a login for the API and jobs that can't migrate (G-D2), `sslmode=verify-full` to a remote database (CR-1).
- **SOC 2 Type I readiness:** the readiness plan's weeks 1 to 10, with CI's evidence exported every month.
- **A security contact** for customers and researchers.
- **TypeScript 7** ([#169](https://github.com/dipeshrohan/tiles/pull/169)), once typescript-eslint supports it ([ADR 001](adr/001-stack.md)).

**Gate:** T6.07's report back. **Done when:** the penetration test's high and critical findings are fixed, the threat model's open actions are closed or accepted with a reason, and the readiness assessment finds nothing that would qualify the report.

### Month 18: Prove it on two lines

**Goal:** both lines' return, measured and signed.

- **An ROI report per line,** each against its own baseline, with the same method and digest.
- **Partner sign-off** on both, and the case for the next customer.
- **Release v1.2,** by the Release workflow.
- **Retrospective** and the next plan.

**Done when:** the partner signs both reports and v1.2 is deployed on the pilot.

## Task list

`ID` · **title** · owner · estimate in engineer-days · depends on. The owners are as in [TASKS.md](TASKS.md).

### Month 13

- `T13.01` **Re-run on the partner's history:** detector templates (T7.02), the failure-mode backtests (T8.02–T8.04), the process model's fit (T11.01) and the recommendations' sweeps (T11.02), each report kept beside its sample-plant one · ML · 5d · T2.17, T7.04
- `T13.02` **Stand-in audit:** T2.11, T6.06, T8.01, T8.05 and T11.01 checked on the partner's data; TASKS.md says which held and which became follow-ups · PM+ML · 2d · T13.01
- `T13.03` **Data quality on the partner's signals:** the quality reports at week 1 and week 4, and the gaps fixed at the edge agent or recorded as known · BE+FDE · 2d · T2.17
- `T13.04` **CI on a schedule:** a weekly run of the full CI on `main`, the runner named in every job instead of `ubuntu-latest`, and a failure that reaches an owner · TL · 1d
- `T13.05` **Dependency rules written down:** the two-week age as Dependabot's `cooldown`, VM-1's deadlines (critical 7 days, high 30) in CONTRIBUTING, and an owner for the Dependabot queue each month · TL · 1d

### Month 14

- `T14.01` **Choose the second line or site** with the partner, scored as the assessment scores pilot problems · PM+TL · 1d · T12.02
- `T14.02` **Onboard it with the wizard,** each step timed; under one day per machine · FDE+FE · 5d · T14.01
- `T14.03` **Templates across lines:** detector templates and model bindings applied to the second line, each backtested on its own history · BE+ML · 3d · T14.02
- `T14.04` **Onboarding fixes:** the three slowest steps of T14.02's timing made faster · FE+BE · 3d · T14.02

### Month 15

- `T15.01` **Choose the second industry** and its three failure modes by cost, from its sample plant · PM+ML · 1d · T14.01
- `T15.02` **Second-industry model 1** (registry, parity fixture, backtest on its sample plant) · ML · 5d · T15.01
- `T15.03` **Second-industry model 2** · ML · 5d · T15.01
- `T15.04` **Second-industry model 3** · ML · 5d · T15.01
- `T15.05` **Its copilot questions in the evaluation,** passing the gate · BE · 2d · T15.01
- `T15.06` ◇ **Genealogy in the correlation finder:** upstream batch, coil or lot as columns · ML+BE · 4d · T15.01

### Month 16

- `T16.01` **Cross-site benchmarking:** each site's warning performance, time to cause and ROI figures, normalised, for organisation admins; read across sites with `store.all_sites` only, audited · BE+FE · 5d · T14.02
- `T16.02` **One library per organisation:** detector templates and model versions published once, used on every site · BE · 3d · T14.03
- `T16.03` **Security review updated** for cross-site reads: the threat model and the [partner pack](security/partner-review.md) · TL · 1d · T16.01

### Month 17

- `T17.01` **Signed images and releases** with cosign, verified at install (G-E4 / G-S2, VM-3) · TL · 3d
- `T17.02` **Edge tokens that expire,** with rotation from the UI (G-E1, AC-5) · BE+FE · 3d
- `T17.03` **A login for the API and jobs that can't migrate** (G-D2) · BE · 2d
- `T17.04` **`sslmode=verify-full` enforced** to a remote database in the Helm chart (CR-1, SR 3.1) · BE · 1d
- `T17.05` **CI evidence exported every month** to the evidence store ([evidence](security/compliance-readiness.md#evidence)) · TL · 1d
- `T17.06` **A security contact:** `security.txt`, an address for vulnerability reports and a security overview for customers (COM-1) · PM+TL · 1d
- `T17.07` **SOC 2 Type I readiness:** the [timeline](security/compliance-readiness.md#timeline)'s weeks 1 to 10, from the policies (GOV-1) to the readiness assessment · TL+PM · 5d (+ auditor time) · T6.07
- `T17.08` **TypeScript 7** (#169), with typescript-eslint's support · FE · 2d · typescript-eslint supporting TypeScript 7

### Month 18

- `T18.01` **An ROI report per line,** each against its own baseline · PM+ML · 2d · T13.01, T14.03
- `T18.02` **Partner sign-off** on both reports, and the case for the next customer · PM+TL · 1d · T18.01
- `T18.03` **Release v1.2** by the Release workflow · TL · 1d
- `T18.04` **Retrospective** and the next plan · PM+TL · 1d · T18.02

**Totals:** 30 tasks, about 77 engineer-days of build work, before review, pilot support, the auditor's and vendor's time, and overruns.

## Risks

| Risk | Mitigation |
| --- | --- |
| The partner's data still hasn't arrived (ROADMAP's first risk, open) | Month 13 is gated on T2.17; without it, re-plan instead of building further on sample plants |
| The sample-plant results don't hold on real data | T13.01 keeps both reports side by side; a model that misses its target on real data stays off the line until it is fixed or dropped |
| The second line is a different kind of plant | Templates are backtested again per line (T14.03); the second industry's work (month 15) starts from its sample plant |
| Cross-site reads weaken row security | `store.all_sites` only, for organisation admins, with tests that a site's members can't read another site (T16.01) and the security review updated (T16.03) |
| Penetration test or audit findings take longer than a month | Book the vendor and the auditor before month 15; month 17 closes only high and critical findings and records the rest |
| CI breaks between pushes, as in November 2026 (#392) | A scheduled run and a named runner (T13.04) |
| typescript-eslint doesn't support TypeScript 7 in the window | T17.08 waits; TypeScript stays on 6.0.x ([ADR 001](adr/001-stack.md)) |

## Decisions and open questions

For the review:

- **The window.** It follows ROADMAP-2's calendar (months 13 to 18 are November 2027 to April 2028). The software of months 1 to 12 was built in October 2026 ([pace](retrospective-2026.md#pace)); should the plans move to the partner's date instead?
- **A second line on the same site, or a second site?** T14.01 decides with the partner; the second site needs more onboarding and a second security review.
- **Which industry for month 15?** It depends on the likeliest next customer.

Open, for the partner:

- Will they host the second line on the same deployment, or a new one?

## Issues to create once approved

One parent issue per month (Month 13 to Month 18) and one issue per task, labelled `month-N` and `role:*` as before:

- T13.01 Re-run on the partner's history
- T13.02 Stand-in audit
- T13.03 Data quality on the partner's signals
- T13.04 CI on a schedule
- T13.05 Dependency rules written down
- T14.01 Choose the second line or site
- T14.02 Onboard it with the wizard
- T14.03 Templates across lines
- T14.04 Onboarding fixes
- T15.01 Choose the second industry
- T15.02 Second-industry model 1
- T15.03 Second-industry model 2
- T15.04 Second-industry model 3
- T15.05 Its copilot questions in the evaluation
- T15.06 Genealogy in the correlation finder (`stretch`)
- T16.01 Cross-site benchmarking
- T16.02 One library per organisation
- T16.03 Security review updated for cross-site reads
- T17.01 Signed images and releases
- T17.02 Edge tokens that expire
- T17.03 A login for the API and jobs that can't migrate
- T17.04 `sslmode=verify-full` enforced
- T17.05 CI evidence exported every month
- T17.06 A security contact
- T17.07 SOC 2 Type I readiness
- T17.08 TypeScript 7
- T18.01 An ROI report per line
- T18.02 Partner sign-off on both reports
- T18.03 Release v1.2
- T18.04 Retrospective and the next plan

Then add a "Months 13–18" section to [TASKS.md](TASKS.md) with the issue links, as ROADMAP-2's tasks have.
