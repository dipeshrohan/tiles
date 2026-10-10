# Partner assessment: checklist and interview guide

This is the kit for assessing a design-partner plant before a pilot (T2.15). The assessment itself
(T2.16) takes two to four weeks on site and remote. It ends with a report that has a signed-off
problem statement and baseline metrics.

It is written for the people who run it: the product lead (PM) and the tech lead (TL), with the
on-site engineer (FDE) once named. Everything it collects is something Tiles needs later. The data
sources become edge-agent connectors or imports. The events become the baseline that the ROI report
(T6.01) compares against. The security answers prepare the IT/OT review (T3.15).

## Contents

- [How the assessment runs](#how-the-assessment-runs)
- [Checklist](#checklist)
- [Interview guide](#interview-guide)
- [Choosing the pilot problem](#choosing-the-pilot-problem)
- [The assessment report](#the-assessment-report)

## How the assessment runs

| Week | What happens | Who |
| --- | --- | --- |
| 0 | Send the [pre-visit questionnaire](#pre-visit-questionnaire); agree the interviewees and a site visit; sign a confidentiality and data-sharing letter that covers the samples below (the full data access agreement is T2.17) | PM, the plant's sponsor |
| 1 | Kick-off with the plant manager; interviews; a walk of the candidate lines | PM, TL |
| 1–2 | Data sampling, under that letter: a week of each candidate source, plus the downtime and scrap logs | TL, the plant's IT/OT |
| 2–3 | Score the opportunities; draft the problem statement and baseline | PM, TL |
| 3–4 | Review with the plant manager and line owners; sign-off | PM, the plant's sponsor |

Rules of thumb:

- **Ask for artefacts, not opinions.** A downtime log export beats an estimate of downtime.
- **Measure the baseline from their records.** Use the plant's own downtime and scrap logs, over at
  least the last 3 months (12 is better), so the ROI report compares like with like.
- **One problem.** The pilot proves one problem on one line. Write the others down for later.

## Checklist

Tick each item as it is collected. Each item says what to ask for and where it goes in Tiles.

### 1. The business case

- [ ] Products and lines in scope, and the one or two candidate lines for the pilot.
- [ ] The losses that hurt most on those lines: unplanned downtime, scrap or rework, slow cycles,
      energy. For each, what it costs per hour or per part. Get the finance or controlling figure,
      not an estimate.
- [ ] Current improvement projects on those lines, so the pilot doesn't compete with one or claim
      its gains.
- [ ] The sponsor: who signs off the problem statement now and the ROI report in month 6.

### 2. Baseline metrics

The ROI report compares the pilot against these, so collect them in a form Tiles can import.

- [ ] **Downtime events** per machine for the last 3–12 months, one row per stop: when it started,
      when it ended, the machine (the asset name as the MES uses it, for example DC-01), the reason
      code, and whether it was planned. They come from the MES, the CMMS or a shift log. In Tiles a
      stop becomes one reading on an event stream, with `event_kind` downtime and the asset
      ([Warning performance](../guides/user.md#warning-performance)): stamped at the **start** of
      the stop, with the reason code as its value. Import only the **unplanned** stops as downtime:
      Tiles counts every downtime event as one a warning should have caught, so planned stops
      (changeovers, planned maintenance) would show as missed. Keep the export itself: Tiles keeps
      no end times, so the baseline's downtime hours are computed from this file, and the ROI report
      recomputes them from the same file.
- [ ] **Scrap and rework events**, one row per scrapped part or batch: the time, the machine and the
      reason code (`event_kind` scrap, the reason code as the value). A per-shift count can't be
      imported as events (one reading would become one event, its count taken for a code): ask for
      the rows behind it, or keep the counts for the baseline only.
- [ ] **Production volume** over the same period, so rates can be normalised (downtime per 1,000
      parts, for example).
- [ ] **How the numbers are counted today:** the definitions behind OEE, MTBF and MTTR as the plant
      uses them, and who owns the figures.
- [ ] **Known gaps** in the logs: periods missing, machines not logged, reason codes changed.

### 3. Data sources

For each source, fill one row of the [data-landscape map](#data-landscape-map).

- [ ] **PLCs and OPC UA servers:** vendor, model, OPC UA availability and security mode, the
      endpoint, and whether the server's certificate can be pinned. Connector: OPC UA.
- [ ] **MQTT brokers:** broker, TLS, and topic layout, including whether payloads are Sparkplug B.
      Connector: MQTT.
- [ ] **Historians and SQL databases:** product (PI, Ignition, Canary, a SQL Server table), retention,
      and whether a read-only account can be had. The edge agent's SQL connector reads PostgreSQL,
      SQL Server and SQLite. Historians that keep their data elsewhere (PI, Canary, or Ignition on
      MySQL or Oracle) come in as CSV exports for backfill
      ([Import data](../guides/user.md#import-data)), with live data from the PLCs over OPC UA or MQTT.
- [ ] **Per candidate signal:** tag name, unit, sample rate, how much history exists, and the machine
      it belongs to.
- [ ] **Sample a week** of the candidate signals and the event logs. Load it into a Tiles evaluation
      install, run the [data-quality check](../guides/user.md#checking-data-quality), and note gaps,
      stuck values and unit problems.
- [ ] **The plant's hierarchy:** site, areas, lines and machines with the names people use. This
      seeds the ontology ([data model](../data-model.md)).

### 4. IT/OT, security and hosting

These answers start the security review (T3.15). Share [hybrid mode](../hybrid.md) and the
[threat model](../security/threat-model.md) with the plant's IT and OT leads at the first meeting.

- [ ] Network zones: where the PLCs, the historian and a small Linux host for the edge agent would sit
      (IEC 62443 zones and conduits if they use them).
- [ ] Whether an outbound-only HTTPS connection from the edge agent to Tiles is allowed, and through
      which proxy. The agent never accepts inbound connections.
- [ ] Hosting: Tiles' managed cloud, or the plant's own cluster ([install guide](../install.md)),
      and any data-residency rules.
- [ ] Sign-in: the identity provider (for example [Entra ID](../guides/entra-id.md)), the groups that
      map to Tiles' roles, and whether users are provisioned with SCIM.
- [ ] The approvals needed, who gives them and how long they take: security review, works council,
      purchasing.
- [ ] Their security questionnaire, if they have one, to answer from the
      [readiness plan](../security/compliance-readiness.md).

### 5. People and workflow

- [ ] Who would act on a warning, on each shift: shift lead, maintenance technician or process
      engineer. Who decides that a warning was a true alarm.
- [ ] How work is raised today: a CMMS work order, a radio call, a whiteboard.
- [ ] Devices on the line, such as tablets or a screen at the machine ([Shopfloor](../guides/user.md#shopfloor)),
      and the languages people work in.
- [ ] Where the SOPs, manuals and lessons learned live, for document search (T4.08). They are loaded in T5.03.
- [ ] The on-site contact for the FDE, and when the FDE can be on site.

## Interview guide

Plan 45–60 minutes per interview, one person or one role at a time. Start every interview the same
way: who you are, what the pilot is and isn't, and that you are looking for problems, not
judging anyone's work. Take notes against the checklist item numbers.

### Plant manager or sponsor

- Which losses on these lines would you most like gone next year? What are they costing you?
- What would make you call this pilot a success in six months? What number would you show your
  management?
- Who should we work with on the line, in maintenance and in IT? Who decides on going further?

Ask for: the cost figures (1), the sponsor's name (1), the improvement project list (1).

### Maintenance lead

- Which machine fails most often, or most expensively? What fails on it?
- When it fails, what did you see beforehand, if anything? How long before?
- How do you log a stop, and how reliable are the reason codes?
- What maintenance is planned today: time-based, counter-based, condition-based?

Ask for: the downtime log export (2), the CMMS work orders for the candidate machines (2), the
maintenance plans.

### Process or production engineer

- Which parameters do you watch for this process? Which ones drift, and what happens when they do?
- Where do the measurements live, and how often are they sampled?
- What have you already tried, in spreadsheets or the historian, to predict problems?

Ask for: the tag list for the candidate machines (3), a historian export of a typical week (3), any
analysis already done.

### Quality lead

- What are the main scrap and rework causes on these lines? Which ones trace back to the process?
- How is scrap counted and coded, per part, per batch or per shift?

Ask for: the scrap log with reason codes (2), the inspection points.

### IT and OT leads

- Walk us through the network from the PLCs to the office network. Where could a small agent host
  sit?
- What outbound access is allowed from that zone, and through which proxy?
- What do you need from us to approve this, and how long does it take?

Ask for: the network diagram (4), the security questionnaire (4), the identity provider details (4).

### Shift lead and operators

- What happens on your shift when this machine starts to misbehave? Who notices, and how?
- If a screen told you a stop was likely in the next hour, what would you do? Who would you call?
- What would make you ignore a warning?

Ask for: a walk of the line, and where a screen or tablet could go (5).

## Choosing the pilot problem

Score each candidate problem from 1 (poor) to 5 (strong) on each criterion, then multiply by the
weight. Pick the highest total, unless it scores 1 on any criterion: a single 1 rules it out.
When two totals tie, pick the one with the higher data-readiness score, then the higher value score.
If every candidate is ruled out, don't pick one: take the blockers to the sponsor (access refused,
say, or no events logged). Then remove one, or widen the candidates, and score again.

| Criterion | Weight | What scores 5 |
| --- | --- | --- |
| Value | 3 | A clear cost per event, and enough events that avoiding a third of them is worth a contract |
| Data readiness | 3 | The signals that show the problem coming are already logged at a useful rate, with months of history |
| Measurability | 2 | Each event is logged with machine and time, so warnings can be scored against it (the [backtest](../guides/model-author.md#tuning-with-the-backtest)) |
| Lead time | 2 | The problem shows itself early enough for someone to act, from minutes to days |
| Ownership | 2 | A named person on each shift will act on warnings and record the outcome |
| Access | 1 | The data can leave the plant through the edge agent or an export within weeks |

Write down why the runners-up lost. They are the candidates for the second line or site (T6.11).

## The assessment report

The report (T2.16) is the evidence for going ahead. Keep it to about five pages, plus the
appendices.

1. **Summary:** the chosen problem, its cost, and what the pilot will deliver.
2. **Problem statement**, signed by the sponsor: the machine or machines, the failure or loss mode,
   the people who act on warnings, and the success criteria. For example: "warn of at least half of
   unplanned stops on DC-01 at least 30 minutes ahead, with at most one false alarm per shift".
3. **Baseline metrics:** per machine, the events per month and per 1,000 parts, their duration
   (from the plant's export, which Tiles doesn't keep), and their cost. Give the period and the source of each number, so that the ROI report recomputes them
   in the same way.
4. **Data landscape:** the [map](#data-landscape-map) and the data-quality findings.
5. **Opportunities:** the scoring table, with the top two or three and why one was chosen.
6. **Plan:** data access and the edge-agent install (T2.17), the security review (T3.15), the pilot
   kickoff (T3.14), and the risks.

### Pre-visit questionnaire

Send it a week before the visit:

1. Which lines and machines should we look at first, and why?
2. Who should we interview (one name per role in the [interview guide](#interview-guide))?
3. Can you export the last 12 months of downtime and scrap logs for those machines?
4. Which systems hold machine data (PLCs, historian, MES, SCADA), and who looks after them?
5. Is there a network diagram, and a security questionnaire for new suppliers?
6. Which identity provider do people sign in with?

### Data-landscape map

One row per source. Copy this table into the report.

| Source | System and version | Machines | Signals (count, examples) | Rate | History | Access path | Owner | Tiles connector |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| e.g. DC-01 PLC | Siemens S7-1500, OPC UA | DC-01 | 40 (shot speed, hydraulic pressure) | 10 Hz | None | OPC UA, from the OT DMZ | OT lead | OPC UA |
| e.g. Historian | AVEVA PI 2018 | Line 2 | 300 | 1 s | 3 years | CSV export | IT | Import (backfill); live data from the PLC |
| e.g. MES stops | MES database | Line 2 | Stop events | Per event | 5 years | CSV export | Production | Import, as events |
