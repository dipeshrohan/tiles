# Tiles: the next 6 months

**Window:** May – Oct 2027, after v1.0 · **Status:** agreed in review · **Tasks:** [TASKS.md](TASKS.md#months-712-deeper-on-the-pilot-line-may--oct-2027), issues #327–#355 · **Before it:** [ROADMAP.md](ROADMAP.md)

## Goal

**Three times the return on the pilot plant.** v1.0 proves Tiles on one machine problem on one line ([T6.01's ROI report](TASKS.md#month-6-prove-value-and-ship-v10-apr-2027)). The next six months go deeper on the same plant: every machine on the line watched, more failure modes covered by physics models, warnings that turn into planned maintenance, causes found faster, and recommendations the line acts on. The measure is the ROI report itself, made the same way, on the same plant.

**Done when:** the ROI report over months 10–12, against the same month-2 baseline, shows at least three times the avoided cost of the v1.0 report, and the partner signs it off.

## Where it starts

What v1.0 leaves in place, and what this plan builds on:

| Have | Use it for |
| --- | --- |
| Edge agent (OPC UA, MQTT, SQL), read-only | More machines' signals, no new connector |
| Model registry, runner, organisations' own models (HTTP, GitHub sandbox) | New physics models, each versioned |
| Detectors, backtest, Warning performance, ROI report | Tune and prove each new model |
| Warning workflow, notifications, Shopfloor and Plant pages | Act on warnings at the line |
| Wear check (time to a limit), correlation finder, insights | Remaining life and root cause |
| Design Studio sweeps, design runs | Search setpoints for recommendations |
| Copilot with grounded tools and change proposals | Explain causes; propose, never act alone |

## Principles

1. **Read-only stays read-only.** Tiles never writes to a PLC. A recommendation is a task for a person, approved by an engineer, and recorded with its outcome.
2. **Every model earns its place.** A new model goes live only after a backtest on the plant's history beats its target (recall, false warnings per day, warning time).
3. **Measure as v1.0 measured.** Same baseline, same ROI method, same digest, so the comparison holds.

## Monthly plan

### Month 7: The whole line

**Goal:** from one machine to every machine on the pilot line.

- **Line coverage map:** each machine on the line with its signals, detectors, models and events, and what is missing (no signals, no detector, no event stream).
- **Detector templates by machine type:** set up a die-casting cell's detectors once and apply them to every cell, each tuned by the backtest on its own history.
- **Planned stops:** a calendar of planned downtime (changeovers, maintenance) from the MES or entered by hand, so warnings and the ROI report leave them out.

**Done when:** every machine on the line has its signals mapped and at least one tuned detector, and the coverage map shows no unexplained gaps.

### Month 8: More failure modes

**Goal:** physics models for the line's next most costly failure modes, chosen from the partner's downtime by cost.

- **Pick three failure modes** from the baseline's downtime codes by hours and cost.
- **A model for each**, through the registry: for example, hydraulic leaks (pressure decay at hold), spindle or bearing wear (motor current against load), tool life (cycles and peak force). Each has a parity fixture where the browser runs it too.
- **Backtest each** on the plant's history before it goes live.

**Done when:** three new models are live on the line, each with a backtest report that beats its target.

### Month 9: From warning to planned work

**Goal:** a warning becomes a maintenance job planned before the stop.

- **Remaining life:** the wear check's time to a limit, shown per machine and component, with its uncertainty.
- **Work orders out:** a warning or a remaining-life threshold drafts a work order in the plant's CMMS (SAP PM, Maximo or a CSV export), outbound only, approved by a person.
- **Maintenance window fit:** suggest the next planned stop that comes before the predicted limit.

**Done when:** at least ten warnings in a month became planned work orders, and their outcomes are recorded.

### Month 10: Causes, faster

**Goal:** from "the machine stopped" to "why" in minutes.

- **Machine timeline:** warnings, events, changes (ontology, setpoints, maintenance) and readings on one time axis per machine.
- **Linked evidence:** a warning opens the correlation finder and similar past warnings with their outcomes.
- **Copilot root cause:** "why did DC-01 stop on Tuesday?" answered from the timeline, cited, with its evidence linked; added to the evaluation set.

**Done when:** the median time from a stop to its recorded cause halves against month 7's, measured in the warning workflow.

### Month 11: Recommendations the line acts on

**Goal:** suggest settings that avoid scrap and stops, for people to apply.

- **Setpoint recommendations:** sweeps over a process model (Design Studio's runner) on the live state of the line, suggesting a change within the engineer's limits.
- **Approval and outcome:** an engineer approves a recommendation, the line applies it by hand, and Tiles records what followed (scrap, stops) against what was expected.
- **Guard rails:** limits per parameter, no recommendation outside them, every one audited.

**Done when:** at least five recommendations were applied, with their outcomes recorded, and none broke a limit.

### Month 12: Prove it

**Goal:** the three-times return, measured and signed.

- **ROI report v2:** the same report, broken down per machine and per model, so each addition shows its share.
- **Partner sign-off** on the report, and the case for the next plant.
- **Release v1.1** with what this plan built.

**Done when:** the partner signs the ROI report and v1.1 is deployed on the pilot.

## Task list

`ID` · **title** · owner · estimate in engineer-days · depends on. The owners are as in [TASKS.md](TASKS.md).

### Month 7

- `T7.01` [#333](https://github.com/dipeshrohan/tiles/issues/333) **Line coverage map:** per machine, its signals, detectors, models and event streams, and what is missing · FE+BE · 3d
- `T7.02` [#334](https://github.com/dipeshrohan/tiles/issues/334) **Detector templates by machine type:** define once, apply to every machine of the type, each backtested on its own history · BE+ML · 4d · T7.01
- `T7.03` [#335](https://github.com/dipeshrohan/tiles/issues/335) **Planned stops calendar:** from the MES's planned-downtime codes or entered by hand; Warning performance and the ROI report leave them out · BE+FE · 3d
- `T7.04` [#336](https://github.com/dipeshrohan/tiles/issues/336) **Map the rest of the line** with the partner (edge agent tags, ontology) · FDE · 5d · T7.01

### Month 8

- `T8.01` [#337](https://github.com/dipeshrohan/tiles/issues/337) **Choose three failure modes** from the baseline's downtime by hours and cost, with the partner · PM+ML · 1d · T7.04
- `T8.02` [#338](https://github.com/dipeshrohan/tiles/issues/338) **Model 1** (registry, parity fixture, backtest) · ML · 5d · T8.01
- `T8.03` [#339](https://github.com/dipeshrohan/tiles/issues/339) **Model 2** · ML · 5d · T8.01
- `T8.04` [#340](https://github.com/dipeshrohan/tiles/issues/340) **Model 3** · ML · 5d · T8.01
- `T8.05` [#341](https://github.com/dipeshrohan/tiles/issues/341) **Bind and go live** on the line, each after its backtest beats its target · FDE+ML · 2d · T8.02–T8.04

### Month 9

- `T9.01` [#342](https://github.com/dipeshrohan/tiles/issues/342) **Remaining life per component:** time to a limit with its interval, on the machine's page and the Plant page · ML+FE · 4d
- `T9.02` [#343](https://github.com/dipeshrohan/tiles/issues/343) **Work orders out:** a draft in the CMMS (SAP PM or Maximo through their APIs, or CSV), outbound only, approved by a person, audited · BE · 5d
- `T9.03` [#344](https://github.com/dipeshrohan/tiles/issues/344) **Next maintenance window:** the planned stop before a predicted limit · BE+FE · 2d · T7.03, T9.01

### Month 10

- `T10.01` [#345](https://github.com/dipeshrohan/tiles/issues/345) **Machine timeline:** warnings, events, changes and readings on one axis · FE+BE · 5d
- `T10.02` [#346](https://github.com/dipeshrohan/tiles/issues/346) **Similar past warnings** with their outcomes, and the correlation finder opened from a warning · ML+FE · 4d
- `T10.03` [#347](https://github.com/dipeshrohan/tiles/issues/347) **Copilot root-cause tool** over the timeline, with evaluation cases · BE · 4d · T10.01
- `T10.04` [#348](https://github.com/dipeshrohan/tiles/issues/348) **Time to cause** measured in the warning workflow · BE · 1d

### Month 11

- `T11.01` [#349](https://github.com/dipeshrohan/tiles/issues/349) **Process model for recommendations** on the line's main quality driver · ML · 5d · T8.01
- `T11.02` [#350](https://github.com/dipeshrohan/tiles/issues/350) **Recommendations:** a sweep on the live state, within limits, approved by an engineer · BE+FE · 5d · T11.01
- `T11.03` [#351](https://github.com/dipeshrohan/tiles/issues/351) **Outcome tracking:** what followed an applied recommendation against what was expected · BE · 3d · T11.02
- `T11.04` [#352](https://github.com/dipeshrohan/tiles/issues/352) **Guard rails:** limits per parameter, refusal outside them, audit · BE · 2d · T11.02

### Month 12

- `T12.01` [#353](https://github.com/dipeshrohan/tiles/issues/353) **ROI report v2:** per machine and per model · BE+FE · 3d
- `T12.02` [#354](https://github.com/dipeshrohan/tiles/issues/354) **Partner sign-off** and the case for the next plant · PM+TL · 1d · T12.01
- `T12.03` [#355](https://github.com/dipeshrohan/tiles/issues/355) **Release v1.1** · TL · 1d

**Totals:** 24 tasks, about 79 engineer-days of build work, before review, pilot support and overruns.

## Risks

| Risk | Mitigation |
| --- | --- |
| The partner's data for new failure modes is thin (few events) | Choose failure modes with enough history (T8.01); fall back to physics-only thresholds with a longer review |
| CMMS integration is slow to approve | Start with CSV export; the API connection is a follow-up |
| Recommendations aren't trusted | Start with suggestions shown beside the warning, not pushed; record outcomes from the first one |
| Attribution: is the extra return Tiles' or the plant's own work? | Per-machine ROI with the same baseline, and machines without new models as a comparison |

## Decisions and open questions

Decided in review (October 2026):

- **The target is relative:** three times v1.0's avoided cost, made the same way, against the same baseline.
- **Recommendations stay in month 11,** after months 7–10, with their guard rails.

Open, for the partner:

- Which CMMS do they run, and will their IT allow an API connection for work orders (T9.02)? Until then, T9.02 starts with CSV export.
