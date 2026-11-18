# Partner sign-off pack

The pack for the meeting where the partner signs the pilot's ROI report (T6.02,
[#94](https://github.com/dipeshrohan/tiles/issues/94), for v1.0; T12.02,
[#354](https://github.com/dipeshrohan/tiles/issues/354), for three times the return) and hears the
case for the next plant. The product lead (PM) and the tech lead (TL) prepare it. The partner's
sponsor, the one named in the [assessment](assessment.md#1-the-business-case), signs it.

It is a template. Every figure in it comes from the ROI report Tiles makes
([the user guide](../guides/user.md#the-roi-report), `POST /sites/{id}/roi`,
`api/src/tiles_api/roi.py`). Each figure is shown twice: as a slot for the partner's report, and as
a worked example from the die-casting sample plant.

## Contents

- [How to use this pack](#how-to-use-this-pack)
- [The worked example](#the-worked-example)
- [The result](#the-result)
- [Against the three-times target](#against-the-three-times-target)
- [The case for the next plant](#the-case-for-the-next-plant)
- [The meeting](#the-meeting)
- [Sign-off record](#sign-off-record)
- [Making the example's numbers again](#making-the-examples-numbers-again)

## How to use this pack

1. Make the ROI report on the partner's site, on the Warning performance page, with the periods and
   inputs agreed in the [assessment report](assessment.md#the-assessment-report). Download its
   Markdown and note its digest.
2. Copy this page. In each table, replace each `‹partner: …›` slot with the figure from that
   report, under the same heading. Delete the example's columns, or keep them for comparison.
3. Make the v1.0 report and the v1.1 report the same way: the same baseline, codes, warning
   horizon, mean stop length, costs and asset scope. Only the pilot period changes. A report made
   another way can't be compared, so the three-times test doesn't apply to it.
4. Before the meeting, make each report again and check the digest is unchanged. A different digest
   means the data changed since the first run: find out why before anyone signs.
5. Send the pack, the reports' Markdown and their digests to the sponsor a week before the meeting.

Write numbers as the report gives them. Don't round them again, and don't add figures the report
doesn't make. A number Tiles can't make, such as the cost of an engineer-day, stays a marked slot
until the partner gives it, with its source.

## The worked example

The example is [Aldermoor Castings' Kesselbach plant](../../data/sample-plants/die-casting/README.md),
the die-casting sample plant. The company and its numbers are made up. Its pilot line is Line 2
(cells DC-01 to DC-04). Its three failure-mode models
([failure modes](../failure-modes.md#the-three)) are bound on every cell, as
[bindings.json](../../data/sample-plants/die-casting/backtests/bindings.json) says.

**Read the example for the method, not the result.** The sample year is simulated without anyone
acting on Tiles' warnings. A warned-of stop still happens, so nothing in it is avoided because of
Tiles. The differences between its periods are the plant's own variation. That makes it a fair test
of the arithmetic: a pilot that changed nothing shows about nothing, sometimes less than nothing.

The example's three periods, on the plant's clock (Europe/Berlin):

| Period | Stands for | Dates | Line 2 parts |
| --- | --- | --- | --: |
| Baseline | The month-2 baseline | 1 October 2025 to 1 January 2026 | 240,994 |
| v1.0 pilot | T6.01's pilot report | 1 January to 1 April 2026 | 254,665 |
| v1.1 pilot | Months 10–12 of [ROADMAP-2](../ROADMAP-2.md#goal) | 1 July to 1 October 2026 | 221,691 |

The inputs, taken from the plant's own files for the baseline and used unchanged in every report:

| Input | Partner | Example | Where the example's figure comes from |
| --- | --- | --: | --- |
| Downtime codes counted | ‹partner: codes› | all | Every unplanned code |
| Warning horizon | ‹partner: hours› | 8 h | The report's default |
| Mean stop length | ‹partner: hours, source› | 0.742 h | The mean of Line 2's 385 unplanned stops in the baseline with an end time, in `mes/stops.csv` (3 have none, a known gap) |
| Cost of an hour of downtime | ‹partner: currency per hour, source› | 2,870 EUR | Each of those stops' hours at its cell's cost in `plant/costs.csv`, divided by their hours |
| Cost of a scrap event | ‹partner: currency per event, source› | 36.31 EUR | The mean of the cost per part in `plant/costs.csv`, over Line 2's 5,762 scrapped parts in the baseline (`mes/scrap.csv`) |
| Parts made | ‹partner: per period› | the table above | Line 2's `parts` in `mes/production.csv`, by day |

With parts given for both periods, rates are per 1,000 parts. That matters here: the baseline holds
the Christmas shutdown and the v1.1 period the summer one.

## The result

### What counts

The report counts exactly what [roi.py](../../api/src/tiles_api/roi.py) counts:

- **Events** are readings on event signals that have an asset: downtime (an unplanned stop, stamped
  at its start, its reason code the value) and scrap. A reading of 0 or false isn't an event. Each
  period runs from its start up to, not including, its end.
- **Planned downtime is left out.** A downtime event whose code is one of the site's planned codes,
  or which starts in a planned stop for its asset or the whole site, isn't counted. Scrap is always
  counted. The report names the planned codes and the number of planned stops. Both are in its digest.
- **Only the codes chosen** count as downtime, or every code when none is chosen. Scrap is never
  filtered by code.
- **Rates** are events per day, or per 1,000 parts when both periods' parts are given.
- **Avoided** is the baseline's rate applied to the pilot period, less what the pilot period had.
  A negative number means more events than the baseline's rate.
- **Hours** are avoided stops times the mean stop length, because Tiles keeps no end times. **Cost**
  is hours times the cost of an hour, plus scrap avoided times the cost of a scrap event.
- **Warning figures** are Warning performance's for each period's unplanned stops: stops warned
  of, warnings followed by a stop, false warnings per day and the median warning time.
- **The digest** is a SHA-256 of the inputs, the periods, every counted event and the stops each
  detector warned of first. The same data gives the same digest. A changed reading changes it.

In the example, planned codes PL-DIE, PL-PM, PL-SHD, PL-TIP and PL-TRL and 483 planned stops were
left out.

### Rates and warnings

| Measure | Baseline | v1.0 pilot | v1.1 pilot | Partner: baseline, v1.0, v1.1 |
| --- | --: | --: | --: | --- |
| Unplanned stops per 1,000 parts | 1.61 | 1.75 | 1.57 | ‹partner› |
| Scrap events per 1,000 parts | 23.91 | 23.19 | 22.10 | ‹partner› |
| Stops warned of | 1% | 1% | 0% | ‹partner› |
| Warnings followed by a stop | 40% | 38% | 0% | ‹partner› |
| False warnings per day | 0.03 | 0.11 | 0.02 | ‹partner› |
| Median warning time | 197 min | 252 min | not measured | ‹partner› |

The example's detectors ran over the whole year, the baseline too. A real baseline comes before
any detector, so its warning figures are "not measured".

### Avoided

| Avoided in the pilot period | v1.0 pilot | v1.1 pilot | Partner: v1.0 | Partner: v1.1 |
| --- | --: | --: | --- | --- |
| Unplanned stops | -37.0 | 8.0 | ‹partner› | ‹partner› |
| Downtime hours | -27.5 | 5.9 | ‹partner› | ‹partner› |
| Scrap events | 182.9 | 400.5 | ‹partner› | ‹partner› |
| Cost | -72,252 EUR | 31,583 EUR | ‹partner› | ‹partner› |
| Digest | `109c68ce…ed5b` | `3d7ec73b…8208` | ‹partner› | ‹partner› |

The digests in full: v1.0 `109c68ce6ddd2f8d1d1abed3432a570c366adf1d69725cff253ffcf07b82ed5b`, v1.1
`3d7ec73bed3d74a6e4ad276b0565977cf191f7e3b9c56eb7c45b4d21339a8208`.

### By machine

Each machine's baseline rate over the pilot period, less its pilot count. The rows add up to the
totals above.

| Machine | v1.0: stops | v1.0: hours | v1.0: scrap | v1.0: cost | v1.1: stops | v1.1: hours | v1.1: scrap | v1.1: cost |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| DC-01 | 2.0 | 1.5 | 503.9 | 22,463 EUR | 12.6 | 9.3 | 461.0 | 43,551 EUR |
| DC-02 | 7.4 | 5.5 | 39.7 | 17,102 EUR | 18.0 | 13.4 | -2.3 | 38,309 EUR |
| DC-03 | -25.5 | -18.9 | -472.8 | -71,390 EUR | -28.4 | -21.1 | -101.3 | -64,173 EUR |
| DC-04 | -20.9 | -15.5 | 112.0 | -40,428 EUR | 5.8 | 4.3 | 43.1 | 13,896 EUR |
| ‹partner: machine› | ‹partner› | ‹partner› | ‹partner› | ‹partner› | ‹partner› | ‹partner› | ‹partner› | ‹partner› |

The roadmap's answer to "is it Tiles or the plant's own work" is here: compare the machines that
got new models with those that didn't ([ROADMAP-2's risks](../ROADMAP-2.md#risks)). In the example
every Line 2 cell has the same models, so there is no such comparison. Name the partner's
comparison machines before the meeting: ‹partner: machines without new models›.

### By model

Each detector's share of the avoided stops, hours and their cost, in proportion to the pilot's
stops its warning came first for. Scrap avoided isn't shared out, because the warnings are of stops.

The horizon has to fit the models. Their warnings come days ahead (median 2.1 to 7.5 days in the
[backtests](../failure-modes.md#targets-and-results)), so with the default 8-hour horizon almost
none counts. The headline v1.1 report has no detector that warned first of a stop. So the example
also makes the report the way the backtests score: only the three modelled codes (DT-HYD, HYD,
DT-FUR, DT-DIE) and a 14-day (336-hour) horizon, with the same baseline and inputs.

| Detector | Stops warned of first | Share | Stops avoided | Hours | Cost |
| --- | --: | --: | --: | --: | --: |
| v1.1: dc01-accumulator-charge | 2 | 67% | 0.5 | 0.3 | 965 EUR |
| v1.1: dc04-accumulator-charge | 1 | 33% | 0.2 | 0.2 | 482 EUR |
| v1.0: dc04-furnace-heater | 2 | 50% | -1.4 | -1.0 | -2,953 EUR |
| v1.0: dc01-furnace-heater | 1 | 25% | -0.7 | -0.5 | -1,476 EUR |
| v1.0: dc03-furnace-heater | 1 | 25% | -0.7 | -0.5 | -1,476 EUR |
| ‹partner: detector› | ‹partner› | ‹partner› | ‹partner› | ‹partner› | ‹partner› |

In that version the modelled stops are few: 4 in the baseline, 7 in the v1.0 pilot and 3 in the
v1.1 pilot. Stops warned of were 57% in v1.0 and 100% in v1.1; avoided stops were -2.8 and 0.7;
the cost was 734 EUR and 15,989 EUR, most of it scrap, which no code filter touches. Digests: v1.0
`96b4b390354b1cf8e7986ab5b3a633c2459d194fe2f53b2c97f4b5f3edbbb6a8`, v1.1
`b4288454258be2e832e59d1bde319893363d75d44fc1544b4d61ec4a4c918637`.

A share of a negative total is negative: a detector that warned first of every stop on a machine
that stopped more than its baseline gets a share of the loss. That is the method, not a fault of
the detector.

## Against the three-times target

[ROADMAP-2](../ROADMAP-2.md#goal) sets the goal: the ROI report over months 10–12, against the same
month-2 baseline, shows at least three times the avoided cost of the v1.0 report, and the partner
signs it off. Its [decisions](../ROADMAP-2.md#decisions-and-open-questions) add that the target is
relative: made the same way, against the same baseline.

So the test is:

> v1.1 avoided cost ≥ 3 × v1.0 avoided cost, both from reports with the same baseline and inputs.

| | Partner | Example |
| --- | --- | --: |
| v1.0 avoided cost | ‹partner› | -72,252 EUR |
| Three times that | ‹partner› | -216,756 EUR |
| v1.1 avoided cost | ‹partner› | 31,583 EUR |
| Met | ‹partner: yes or no› | see below |

**The example shows a gap in the definition.** Its v1.0 avoided cost is below zero, so three times
it is lower still, and any v1.1 result passes. The ratio means nothing unless v1.0's avoided cost
is above zero. The meeting has to decide what applies when it isn't
([decisions asked for](#decisions-asked-for)). A sensible rule: the ratio applies only when v1.0's
avoided cost is above zero; otherwise the v1.1 report must reach a minimum avoided cost agreed in
advance, ‹partner: amount›.

**Still owed before the partner can sign:**

- The partner's v1.0 report (T6.01) made and signed, with its digest. Until then there is no
  number to multiply.
- The v1.1 report over months 10–12 against the same baseline, after the models were live for the
  whole period (T8.05) and the weekly tuning reviews had run (T5.02).
- Agreement that both reports use the same inputs, or a recalculation of v1.0 with the v1.1
  inputs if a figure changed, such as the cost of an hour. Either way, both digests are recorded.
- The comparison machines without new models, so the extra return can be put down to Tiles.
- The rule above for a v1.0 result at or below zero.

## The case for the next plant

### What carries over

| What | Where | At the next plant |
| --- | --- | --- |
| The three failure-mode models, versioned | `models/failure_modes.py`, [failure modes](../failure-modes.md#the-models) | Bound as they are where the machines and signals match; backtested on the new plant's history before going live |
| The bindings and detector settings | [bindings.json](../../data/sample-plants/die-casting/backtests/bindings.json) | The checklist for binding: one binding and one detector per model and cell, the settings kept until the plant's own backtest replaces them |
| Detector templates by machine type | `api_detector_templates.py` (T7.02) | Applied to every machine of the type at once, each tuned on its own history |
| The process model and its fitting | [process model](../process-model.md#fitting-it-again) | Fitted again on the new plant's shots; the method and its target carry over, the coefficients don't |
| Recommendations with their guard rails | [recommendations](../recommendations.md#the-guard-rails) | The limits are set again by the new plant's engineers |
| The edge agent, connectors and install | [hybrid mode](../hybrid.md), [install guide](../install.md) | Same agent; the plant's firewall rules and security review are new |
| The assessment kit and this pack | [assessment](assessment.md), this page | Used as they are |
| The ROI report, its digest and this method | `roi.py` | The same, so the plants can be compared |

What doesn't carry over: the plant's data, its ontology, its baseline, its costs, its tuned
settings and its people's trust. Each is made again.

### Effort

The build work of ROADMAP-2 (about 79 engineer-days) is done and isn't repeated. What repeats is the
work per plant. These are the estimates in [TASKS.md](../TASKS.md), in engineer-days:

| Task | Estimate | Partner's figure |
| --- | --: | --- |
| `T2.16` Run the partner assessment | 5 | ‹partner› |
| `T2.17` Data access agreement and edge-agent install | 2 | ‹partner› |
| `T3.15` Security review started early | 1 | ‹partner› |
| `T3.14` Pilot kickoff | 2 | ‹partner› |
| `T7.04` Map the line (edge agent tags, ontology) | 5 | ‹partner› |
| `T3.06` Tune on the plant's history | 3 | ‹partner› |
| `T8.05` Bind the models and go live | 2 | ‹partner› |
| `T5.01` Go live: warnings on the line, workflow signed off | 2 | ‹partner› |
| `T5.02` Weekly tuning reviews (4 × 0.5) | 2 | ‹partner› |
| `T4.05` The copilot's evaluation set | 3 | ‹partner› |
| `T6.01` The ROI report | 3 | ‹partner› |
| `T6.02` The sign-off meeting | 1 | ‹partner› |
| **Total** | **31** | ‹partner› |

The estimates are for the work alone, before travel, waiting for access and overruns. New failure
modes at the next plant are extra, about 5 days each as T8.02 to T8.04 were.

### Cost

| Line | Amount | Source |
| --- | --- | --- |
| Engineering: 31 engineer-days at ‹partner: day rate› | ‹partner› | ‹partner› |
| Travel and time on site | ‹partner› | ‹partner› |
| Hosting: managed cloud or customer-hosted | ‹partner› | ‹partner: the production-deployment quote (T6.02)› |
| Licences | ‹partner› | ‹partner› |
| The partner's own people (IT/OT, maintenance, shift leads) | ‹partner› | ‹partner› |
| **Total** | ‹partner› | |
| Expected avoided cost a year, from the pilot plant's v1.1 report scaled to the next plant's baseline | ‹partner› | ‹partner: the method agreed› |

## The meeting

About 90 minutes, at the pilot plant or online. The sponsor, the plant manager, the maintenance
lead, a shift lead, controlling, and from Tiles the PM, the TL and the on-site engineer.

### Agenda

| Time | Item | Who |
| --- | --- | --- |
| 10 min | The goal and the test, as agreed at the start | PM |
| 20 min | The result: totals, by machine, by model, each with its digest | PM, TL |
| 10 min | How it was counted: planned downtime, codes, horizon, costs | TL |
| 15 min | What the line says: the shift lead and the maintenance lead | Partner |
| 15 min | The case for the next plant: what carries over, effort, cost | PM |
| 10 min | Decisions | Sponsor |
| 10 min | Sign-off and next steps | Sponsor, PM |

### Decisions asked for

1. **The report:** the v1.1 ROI report, with digest ‹partner: digest›, is accepted as the measure.
2. **The target:** it meets three times v1.0's avoided cost, or it doesn't. If v1.0's avoided cost
   is at or below zero, which rule applies ([above](#against-the-three-times-target)).
3. **The inputs:** the mean stop length and the costs used are controlling's figures, with their
   source.
4. **Production:** v1.1 stays deployed on the pilot line under the production-deployment quote.
5. **The next plant:** which plant and line, the sponsor there, and a start date for its assessment.
6. **Open items:** the CMMS connection for work orders (CSV export until the partner's IT allows an
   API connection, [ROADMAP-2](../ROADMAP-2.md#decisions-and-open-questions)) and any others.

## Sign-off record

| Item | Value |
| --- | --- |
| Plant and line | |
| Baseline period | |
| v1.0 pilot period and digest | |
| v1.1 pilot period and digest | |
| v1.0 avoided cost | |
| v1.1 avoided cost | |
| Three times the return met | Yes / No |
| Decisions taken (by number, above) | |

| Role | Name | Signature | Date |
| --- | --- | --- | --- |
| Partner sponsor | | | |
| Plant manager | | | |
| Controlling | | | |
| Tiles product lead | | | |
| Tiles tech lead | | | |

## Making the example's numbers again

The example's figures come from four ROI reports, each made twice with the same digest, on a fresh
database with the sample plant's Line 2 loaded through the API:

1. From `api/`, in a database migrated to head with the demo site seeded, load with the sample
   plant's loader (`tiles_api.sample_plant.load.Loader`), as `tiles-sample-plant load die-casting`
   does: the plant model; the MES's unplanned stops and scrap for DC-01 to DC-04
   (`event_readings`, kept to those four assets); the readings the three models need, simulated by
   `failure_backtest.readings` for the four cells (5,053,948 readings); the signal catalogue; the
   planned codes and stops; then `failure_models`, which bound the 12 bindings of `bindings.json`,
   ran them and their detectors, and raised 33 warnings.
2. Work out the inputs from the committed files as the table in [the worked example](#the-worked-example)
   says.
3. Make the reports with `POST /sites/{id}/roi`. The headline v1.0 report's request:

```json
{
  "baseline_start": "2025-10-01T00:00:00+02:00",
  "baseline_end": "2026-01-01T00:00:00+01:00",
  "pilot_start": "2026-01-01T00:00:00+01:00",
  "pilot_end": "2026-04-01T00:00:00+02:00",
  "horizon_hours": 8,
  "codes": [],
  "hours_per_stop": 0.742,
  "hours_source": "mes/stops.csv, Line 2's unplanned stops, October to December 2025",
  "cost_per_hour": 2870.0,
  "cost_per_scrap": 36.31,
  "currency": "EUR",
  "baseline_parts": 240994.0,
  "pilot_parts": 254665.0
}
```

The v1.1 report has `pilot_start` `2026-07-01T00:00:00+02:00`, `pilot_end`
`2026-10-01T00:00:00+02:00` and `pilot_parts` `221691.0`. The by-model version of each has
`codes` `["DT-HYD", "HYD", "DT-FUR", "DT-DIE"]` and `horizon_hours` `336`. The same requests on the
same data give the digests above; a change to the sample plant's generator or to `roi.py` changes them,
and this page has to be made again.
