# Die casting: a year of Aldermoor Castings' Kesselbach plant

A complete, made-up plant to build and test Tiles on before a partner's data arrives: what a
design partner hands over at the assessment ([T2.16](../../../docs/pilot/assessment.md)), for a year.
Aldermoor Castings and its Kesselbach plant don't exist; the equipment is named by the makers of
such machines, as a plant's asset register would name it.

The year is simulated shot by shot (`api/src/tiles_api/sample_plant/die_casting/`), so every reading follows
from the state of the machines: plunger tips wear and score, accumulators lose their precharge,
dies scale up and run hot, vacuum filters clog, spray nozzles block, heater elements age. Each
breakdown shows in its signals beforehand, the way it would at a real plant, and the ground truth
says what happened. The same seed gives the same year on every run.

## Contents

- [The plant](#the-plant)
- [The files](#the-files)
- [Data-landscape map](#data-landscape-map)
- [Known gaps](#known-gaps)
- [What happened: the ground truth](#what-happened-the-ground-truth)
- [Making the large files](#making-the-large-files)
- [Loading it into Tiles](#loading-it-into-tiles)
- [Asking the copilot's questions](#asking-the-copilots-questions)
- [What it is for](#what-it-is-for)

## The plant

High-pressure aluminium die casting: transmission housings (TH-410), e-motor housings (EM-220),
gearbox covers (CV-90) and mounting brackets (BR-35), from two lines of die-casting cells, with
melting, finishing, machining, a quality lab and utilities. The overview is
[documents/PLANT-OVERVIEW.md](documents/PLANT-OVERVIEW.md).

| Area | What | Data |
| --- | --- | --- |
| Melting | Tower furnaces MF-01 (feeds Line 2) and MF-02 (Line 1), degassing station DG-01 | MF-01's melt temperature and gas flow every 5 minutes; the lab's hydrogen tests twice a shift; MES stops |
| Die casting, Line 2 (the pilot) | Cells DC-01 to DC-04: a die caster, holding furnace, spray robot, extraction robot, trim press and vacuum unit each, one Siemens S7-1500 PLC (OPC UA) | 12 values every shot, 7 every 5 minutes, shot curves for DC-01, MES stops and scrap, X-ray grades |
| Die casting, Line 1 | Older cells DC-05 and DC-06 (S7-300, MQTT) | Two 5-minute averages, MES stops and scrap |
| Finishing, machining | Shot blast, fettling, impregnation; four machining centres, washer, leak tester | MES stops only |
| Quality lab, utilities | X-ray XR-01 and XR-02, CMM; compressor, cooling tower | X-ray results per shot; air pressure, cooling water and hall temperatures |

The year runs from 1 October 2025 to 30 September 2026 on the plant's clock (Europe/Berlin): three
shifts from Sunday night to Saturday morning, a Saturday early shift outside July, August and
December, German public holidays, and the Christmas and summer shutdowns.
[baseline.md](baseline.md) gives each cell's stops, hours, scrap and their cost.

## The files

Everything here is made by `uv run tiles-sample-plant generate die-casting` (from `api/`), except this README;
`api/tests/test_sample_die_casting.py` fails when a file is not what the generator makes. The large files
are made with `--all` (below).

| File | What | In Tiles |
| --- | --- | --- |
| [plant/ontology.json](plant/ontology.json) | The plant model: enterprise, site, areas, lines, cells, machines, PLCs, signals, processes, materials, documents and the plunger virtual sensor, mapped to ISA-95 ([data model](../../../docs/data-model.md)) | Ontology import |
| [plant/tags.csv](plant/tags.csv) | Every tag: unit, rate, description, machine, what it measures, expected range, stuck limit, wear limit | The signal catalogue |
| [plant/equipment.csv](plant/equipment.csv) | The asset register | |
| [plant/products.csv](plant/products.csv), [plant/costs.csv](plant/costs.csv) | Products, and controlling's costs of a stop hour and a scrapped part | The ROI report's figures |
| [plant/people.csv](plant/people.csv) | Who does what, with the Tiles role each would have | Site members |
| [mes/stops.csv](mes/stops.csv) | Every stop: start, end, machine, reason code, planned or not, shift, crew, comment | Unplanned stops as downtime events |
| [mes/reason-codes.csv](mes/reason-codes.csv) | The MES's downtime and scrap codes | Planned codes |
| [mes/scrap.csv](mes/scrap.csv) | Every scrapped part with its defect code | Scrap events |
| [mes/production.csv](mes/production.csv) | Shots, parts, scrap and stop minutes per shift and cell | Rates per 1,000 parts |
| [calendar/shifts.csv](calendar/shifts.csv), [calendar/planned-stops.csv](calendar/planned-stops.csv) | The shifts worked; the time without shifts and the planned stops | Planned stops |
| [cmms/work-orders.csv](cmms/work-orders.csv) | The CMMS's year: corrective, preventive and condition-based work orders, with hours, parts and costs | |
| [lab/hydrogen.csv](lab/hydrogen.csv) | The lab's density-index tests | Also the `lab.hydrogen` signal |
| [documents/](documents/) | SOPs, a hydraulics handbook, lessons-learned reports on the year's worst breakdowns, monthly maintenance reports | Document search |
| [copilot/questions.csv](copilot/questions.csv) | 100+ questions with the facts their answers must state ([below](#asking-the-copilots-questions)) | The copilot's evaluation |
| [ground-truth/](ground-truth/) | What really happened: each degradation, the process model behind the X-ray grades, the known gaps | |
| [manifest.json](manifest.json) | Each file's rows; for the large files, rows and the SHA-256 of their text | |

## Data-landscape map

As the assessment's [map](../../../docs/pilot/assessment.md#data-landscape-map) has it.

| Source | System and version | Machines | Signals (count, examples) | Rate | History | Access path | Owner | Tiles connector |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Cell PLCs, Line 2 | Siemens S7-1500, OPC UA | DC-01 to DC-04, HF-01 to HF-04 | 76 (shot speeds, intensification pressure, vacuum, die temperatures, slow-phase pressure, oil temperature, cooling flows) | Every shot (about 100 s); 5 minutes | 1 year | OPC UA, from the OT DMZ | OT lead | OPC UA |
| Shot monitoring, DC-01 | Cell PLC's shot curves | DC-01 | 3 (velocity, shot cylinder and metal pressure) | 200 Hz during a shot | 2 weeks | Export | Process engineering | Import |
| Cell PLCs, Line 1 | Siemens S7-300 behind an MQTT gateway | DC-05, DC-06 | 4 (cycle time, die temperature) | 5-minute averages | 1 year | MQTT, Sparkplug B | OT lead | MQTT |
| Historian | Exports of the above | Line 1 and 2, melting, utilities | 86 | as above | 1 year | CSV export (`generated/historian/`) | IT | Import (backfill) |
| MES | Stop and scrap logs | 16 machines | Stops, scrap, production per shift | Per event, per shift | 1 year | CSV export (`mes/`) | Production | Import, as events |
| X-ray | Yxlon inspection, per part | Line 2's parts | Grade, porosity, result per shot | Per shot | 1 year | CSV export (`generated/quality/`) | Quality | Batch tables |
| Lab | Density-index tests | MF-01, DG-01 | Hydrogen | Twice a shift | 1 year | CSV export (`lab/`) | Melting | Import |
| CMMS | Work orders | Every machine | Work orders | Per job | 1 year | CSV export (`cmms/`) | Maintenance | |

## Known gaps

What a real export has, and what the assessment's data-quality check should find
([ground-truth/quirks.csv](ground-truth/quirks.csv)):

- **A historian outage:** no readings of Cell DC-03 (dc03.\*, hf03.\*) from 10 February 2026 06:00 to
  12 February 14:00. The MES kept logging.
- **A stuck thermocouple:** dc02.die_temp_fixed reads 238.4 °C from 19 January 10:00 to 22 January
  15:30, then the thermocouple was replaced.
- **The wrong unit:** dc04.intensification_pressure is in MPa (a tenth of the bar values) from 11 May
  08:00 to 18 May 07:00, after a PLC firmware update.
- **A renamed code:** hydraulic faults are `HYD` until the MES update on 1 December 2025, `DT-HYD` after.
- **Booking errors:** two stops of DC-04 booked on DC-03; about 0.4% of stops logged twice; about
  0.3% of unplanned stops without an end time.
- **Not logged:** Line 1's cells send two averages; finishing and machining have no signals. The plant
  model has a spare compressor nobody connected (CP-02) and a conveyor entered without its vendor
  (SC-01).

## What happened: the ground truth

[ground-truth/episodes.csv](ground-truth/episodes.csv) has every degradation of the year: the
machine, the failure mode, when it began, when it failed or was found, and the signals that show
it. Each builds up over working days and either stops the machine or is found first, at planned
maintenance, in a quality hold, or by a die change.

| Mode | Stops the machine with | Shows in | Builds up over |
| --- | --- | --- | --- |
| Plunger tip scoring | DT-PLG (4 to 8 h) | `plunger_pressure_1st`: about 15 bar with a new tip, 21 bar at the end of its life, over 30 bar before it seizes | 2 to 6 working days |
| Accumulator precharge loss | DT-HYD | `pressure_buildup_time` up, `intensification_pressure` and `accumulator_pressure` down, porosity up | 1 to 4 days |
| Die cooling blockage | DT-DIE | `cooling_flow_moving` down, `die_temp_moving` up, soldering | 6 to 18 days |
| Vacuum filter clogging | DT-VAC, or a quality hold first | `vacuum_level` up, porosity rejects | 3 to 9 days |
| Spray nozzles blocking | DT-SPR | `spray_pressure` down, sticking | 1 to 2.5 days |
| Heater element ageing | DT-FUR | `heater_power` up, then `bath_temp` down, cold shuts | 6 to 25 days |
| Oil cooler fouling (summer) | DT-OIL | `hydraulic_oil_temp` up to the 58 °C trip | 2 to 7 days |
| Degassing rotor wear | none (quality) | `lab.hydrogen` up, porosity on every cell | 3 to 10 days |

Besides these, the cells stop for electrical, robot, trim-press, sensor and other faults that
nothing foretells, for want of metal when MF-01 stops for more than 20 minutes, and for quality
holds after five porosity rejects in thirty shots. After a stop of more than half an hour, the first
shots are warm-up scrap.

The X-ray grades come from a process model,
[ground-truth/process-model.json](ground-truth/process-model.json): a shot's porosity from its vacuum,
intensification, hydrogen, die temperature, shot speed and build-up time against the die's set
points, plus noise and the odd shot with air entrapped. A model of the quality driver (T11.01) can be
judged against it.

The slow-phase pressure is the plunger-friction model's physics (`js/lib/physics.ts`): at constant
speed Ph·Ah = Pm·Am + F, with the same mass and areas, so DC-01's shot curves give the friction the
cell's own pressure reflects.

## Making the large files

```sh
cd api
uv run tiles-sample-plant generate die-casting --all
```

This writes `generated/` (about 100 MB, not in Git) in about five minutes:

- `historian/<month>/<stream>.csv.gz`: the historian export, one row per reading (timestamp in UTC,
  tag, value, quality): about 14 million readings.
- `quality/<cell>-<month>.csv.gz`: every shot of Line 2 with its process values and X-ray result.
- `traces/dc01-shots.csv.gz`: DC-01's shot curves for the two weeks before its plunger seized on
  26 May 2026.

The manifest's `generated` section gives each file's rows and the SHA-256 of its text, so a run can
be checked against the one recorded.

## Loading it into Tiles

With the API running (`uv run tiles-api`) and a site whose engineer you are:

```sh
uv run tiles-sample-plant load die-casting --site <site id> --as <engineer's email>
```

This loads:

1. **The plant model:** imported and committed.
2. **The readings:** every historian file and the shot curves.
3. **The MES:** its unplanned stops (as downtime events, at their start, the reason code as the value)
   and its scrap (as scrap events).
4. **The signal catalogue:** each signal described and linked to its Signal node.
5. **The failure-mode models:** each of [backtests/bindings.json](backtests/bindings.json)'s bindings
   (three models on each Line 2 cell) with its detector, run over the year, so their warnings are in
   the warnings inbox ([docs/failure-modes.md](../../../docs/failure-modes.md#going-live)).
6. **Planned stops:** the planned codes and every planned stop, including the time without shifts.
7. **Documents:** every document, for search.
8. **The X-ray tables:** one batch table per cell and month (`X-ray results DC-01 2026-05`).

Everything takes about 20 minutes against a local API (the readings 15, the X-ray tables 2).
`--no-readings` leaves out the historian and X-ray files, and so the failure-mode models (everything
else loads in about a minute);
`--token` signs in with an access token instead of the API's development sign-in. `--shift-to-now`
moves every time on by whole weeks, so the year ends last week and the pages' "last 30 days" find it;
weekdays and shifts stay as they were, but the question set's dates no longer hold.

From there, the [user guide](../../../docs/guides/user.md) applies:
- **Plant:** Line 2's Coverage card lists what each machine has.
- **Detector templates:** a template for `friction` on `die-caster` machines backtests DC-01 to DC-04's
  slow-phase pressure against their DT-PLG stops.
- **Warning performance and the ROI report:** they compare a pilot period with its baseline.
- **Data explorer:** shows a breakdown's lead-up.
- **Correlation finder:** finds what goes with the porosity rejects.

## Asking the copilot's questions

[copilot/questions.csv](copilot/questions.csv) is a partner set in the form of
[the guide](../../../docs/pilot/copilot-questions.md):
- **The plant model:** its equipment and the gaps in it.
- **Signals:** what each one is and its unit.
- **Readings:** May 2026's highs, lows and means on the days that matter.
- **MES events:** the reason codes of stops, and the scrap after a weekend.
- **Wear and root causes:** the wear check and the root cause of each May breakdown.
- **Documents:** what the SOPs say.
- **Correlations:** on the X-ray tables.
- **Declines:** questions the data can't answer, or that ask Tiles to write to a machine.

Each answer's facts are worked out from the year. Two more columns make the set checkable:
- `plan`: the tool calls that answer the question.
- `data`: the readings those calls read.

The test loads that data into a site and has an oracle answer every question from what the tools
give, through the grounding check. To ask Claude, load the plant without `--shift-to-now`, then:

```sh
uv run tiles-evaluate --cases ../data/sample-plants/die-casting/copilot/questions.csv --site <site id> --as <engineer's email>
```

## What it is for

- **Rehearsing the assessment (T2.16):** the checklist's every item has its file here. The scoring of
  candidate problems has real numbers to work with: [baseline.md](baseline.md) and the ground truth.
- **Tuning detectors before partner history (T3.06, T7.02):** the backtest scores settings against
  stops whose precursors are known.
- **The copilot's evaluation (T4.05, T4.06):** 100+ questions, answerable from the data.
- **The knowledge base (T5.03):** SOPs and reports to search.
- **Choosing failure modes (T8.01):** stops, hours and cost per mode and machine, with the history
  each needs.
- **The failure-mode models (T8.02 to T8.04):** [backtests/](backtests/) has each model's backtest on
  Line 2's year (`tiles-sample-plant backtest die-casting`), against the target it was set
  ([docs/failure-modes.md](../../../docs/failure-modes.md)).
- **The process model (T11.01):** X-ray grades from known physics, to fit and to check against;
  [process-model/](process-model/) has the fit (`tiles-sample-plant fit die-casting`,
  [docs/process-model.md](../../../docs/process-model.md)).
- **The ROI report (T6.01, T12.01):** costs, stops and scrap, by machine and by mode.
