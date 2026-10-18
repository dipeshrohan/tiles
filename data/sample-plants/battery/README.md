# Battery cells: a year of Kestrel Energy's Varnhem plant

A complete, made-up lithium-ion cell plant to build and test Tiles on: what a design partner hands
over at the assessment ([T2.16](../../../docs/pilot/assessment.md)), for a year. Kestrel Energy and
its Varnhem plant don't exist; the equipment is named by the makers of such machines, as a plant's
asset register would name it.

The year is simulated coil by coil and cell by cell (`api/src/tiles_api/sample_plant/battery/`), so
every reading follows from the state of the machines and every cell from its genealogy. Slot die lips
build up, dryer fans and calender bearings wear, slitter blades chip, stacker dancers lose tension,
welding horns wear, dosing pumps lose their stroke, formation contacts corrode, and the dry room's
desiccant wheel loads up. Each shows in its signals beforehand, and some show again weeks later, at
the end of the line: a chipped blade's burrs become self-discharge fails two weeks on. The ground
truth says what happened. The same seed gives the same year on every run.

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

KX60 prismatic cells for car makers: NMC811 cathode, graphite anode, 60 Ah, about 1,900 a day. The
overview is [documents/PLANT-OVERVIEW.md](documents/PLANT-OVERVIEW.md).

| Area | What | Data |
| --- | --- | --- |
| Cathode and anode lines | A mixer, coater, calender, slitter and vacuum oven each (MX, CT, CL, SL, VD); a spare oven VD-C2 | Each slurry batch's viscosity and solid content; the coaters' and calenders' values every minute while running, and every 5 minutes; each coil's coating weight, streaks and peel; each roll's burrs; MES stops and scrap |
| Assembly, in the dry room | Dry room DR-01 and its dehumidifier DH-01, notchers NT-C1 and NT-A1, stackers ST-01 and ST-02, tab welder UW-01, electrolyte filler EF-01 | The dew point and the desiccant wheel every 5 minutes; each cell's overhang, separator tension, weld energy and fill weight; MES stops and scrap |
| Formation and aging | Formation racks FM-01 to FM-04 (512 channels each), aging room AG-01, end-of-line tester EOL-01 | Rack temperature and contact resistance every 5 minutes; each cell's capacity, resistance (DCIR) and self-discharge (K-value) |
| Utilities, quality lab | NMP recovery, chiller, compressor; Karl Fischer titrator and peel tester | Utility values every 5 minutes; the lab's electrode moisture, peel and weld-pull tests |

Each cell's genealogy is kept: its cathode and anode coil and roll, the slurry batches behind them,
its stacker and its formation rack. The cell's end-of-line results come from that genealogy, by the
quality model in [ground-truth/quality-model.json](ground-truth/quality-model.json).

The year runs from 1 October 2025 to 30 September 2026 on the plant's clock (Europe/Stockholm),
around the clock: four crews (A to D) on twelve-hour shifts (06:00 to 18:00 and 18:00 to 06:00) on a
2-2-3 rotation, stopping only for Christmas, New Year and a summer maintenance week (27 July to
3 August). [baseline.md](baseline.md) gives each machine's stops, hours and their cost, and the
cells' yield and scrap.

## The files

Everything here is made by `uv run tiles-sample-plant generate battery` (from `api/`), except this
README; `api/tests/test_sample_battery.py` fails when a file is not what the generator makes. The
large files are made with `--all` (below).

| File | What | In Tiles |
| --- | --- | --- |
| [plant/ontology.json](plant/ontology.json) | The plant model: enterprise, site, areas, lines, machines, PLCs, signals, processes and materials, mapped to ISA-95 ([data model](../../../docs/data-model.md)) | Ontology import |
| [plant/tags.csv](plant/tags.csv) | Every tag: unit, rate, description, machine, what it measures, expected range, stuck limit, wear limit | The signal catalogue |
| [plant/equipment.csv](plant/equipment.csv) | The asset register | |
| [plant/products.csv](plant/products.csv), [plant/costs.csv](plant/costs.csv) | The KX60 cell, and controlling's costs of a stop hour, a scrapped cell, a metre of coil and the spare parts | The ROI report's figures |
| [plant/people.csv](plant/people.csv) | Who does what, with the Tiles role each would have | Site members |
| [mes/stops.csv](mes/stops.csv) | Every stop: start, end, machine, reason code, planned or not, shift, crew, comment | Unplanned stops as downtime events |
| [mes/reason-codes.csv](mes/reason-codes.csv) | The MES's downtime and scrap codes | Planned codes |
| [mes/scrap.csv](mes/scrap.csv) | Every scrapped coil, roll and cell with its code | Scrap events |
| [mes/batches.csv](mes/batches.csv), [mes/coils.csv](mes/coils.csv), [mes/rolls.csv](mes/rolls.csv) | Every slurry batch, coil and slit roll: when each step finished, its measurements, whether it was scrapped | |
| [mes/production.csv](mes/production.csv) | Cells stacked, tested, graded and scrapped, and stop minutes, per shift | Rates per 1,000 parts |
| [calendar/shifts.csv](calendar/shifts.csv), [calendar/planned-stops.csv](calendar/planned-stops.csv) | The shifts worked; the shutdowns and the planned stops | Planned stops |
| [cmms/work-orders.csv](cmms/work-orders.csv) | The CMMS's year: corrective, preventive and condition-based work orders, with hours, parts and costs | |
| [lab/moisture.csv](lab/moisture.csv), [lab/peel.csv](lab/peel.csv), [lab/weld-pull.csv](lab/weld-pull.csv) | The lab's tests | Also the `lab.*` signals |
| [documents/](documents/) | SOPs, lessons-learned reports on the year's worst breakdowns, monthly maintenance reports | Document search |
| [copilot/questions.csv](copilot/questions.csv) | 100+ questions with the facts their answers must state ([below](#asking-the-copilots-questions)) | The copilot's evaluation |
| [ground-truth/](ground-truth/) | What really happened: each degradation, the cells' quality model, the known gaps | |
| [manifest.json](manifest.json) | Each file's rows; for the large files, rows and the SHA-256 of their text; the batch tables | |

## Data-landscape map

As the assessment's [map](../../../docs/pilot/assessment.md#data-landscape-map) has it.

| Source | System and version | Machines | Signals (count, examples) | Rate | History | Access path | Owner | Tiles connector |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Electrode line PLCs | Siemens S7-1500, OPC UA | Coaters, calenders | 14 (line speed, coating weight and its variation, slot die pressure, roll force, thickness and its spread) | Every minute while running | 1 year | OPC UA, from the OT DMZ | OT lead | OPC UA |
| Plant PLCs | Siemens S7-1500, OPC UA | Every machine with signals | 38 (dryer temperatures and fan current, bearing vibration, dew point, wheel pressure drop, oven vacuum, rack temperature and contact resistance, utilities) | 5 minutes | 1 year | OPC UA | OT lead | OPC UA |
| MES, per unit | Per batch, coil, roll and cell | Mixers, coaters, slitters, stackers, welder, filler, tester | 21 (viscosity, coating weight, burrs, overhang, separator tension, weld energy, fill weight, capacity, DCIR, K-value) | Per unit | 1 year | CSV export (`mes/`) | Production | Import |
| Historian | Exports of the above | Every line, the lab | 76 | as above | 1 year | CSV export (`generated/historian/`) | IT | Import (backfill) |
| MES, events | Stop and scrap logs | 23 machines | Stops, scrap, production per shift | Per event, per shift | 1 year | CSV export (`mes/`) | Production | Import, as events |
| Cell genealogy | MES traceability and the end-of-line tester | Every cell | Coils, rolls, stacker, rack, process values, grade | Per cell | 1 year | CSV export (`generated/tables/`) | Quality | Batch tables |
| Lab | Karl Fischer, peel and pull tests | Electrodes, welds | Moisture, peel, weld pull | Per sample | 1 year | CSV export (`lab/`) | Quality | Import |
| CMMS | Work orders | Every machine | Work orders | Per job | 1 year | CSV export (`cmms/`) | Maintenance | |

## Known gaps

What a real export has, and what the assessment's data-quality check should find
([ground-truth/quirks.csv](ground-truth/quirks.csv)):

- **A drifting sensor:** dr01.dew_point reads 3 °C too dry from 2 February 2026 08:00 until its
  calibration on 24 February 10:00.
- **The wrong unit:** cta1.coating_weight is in g/m² (ten times the mg/cm² values) from 9 March 08:00
  to 16 March 08:00, after a gauge software update.
- **A historian outage:** no readings of the formation racks (fm01.\* to fm04.\*) from 6 April 2026
  00:00 to 7 April 12:00. The MES kept logging.
- **A clock offset:** the end-of-line tester's clock stayed on winter time from 29 March to 5 April,
  so eol01.\* readings are an hour early.
- **A renamed code:** die cleaning is `SLOT` until the MES update on 15 January 2026, `DT-DIE` after.
- **Booking errors:** about 0.4% of stops are logged twice; about 0.3% of unplanned stops have no
  end time.
- **The plant model:** a spare vacuum oven (VD-C2) entered with no relationships.

## What happened: the ground truth

[ground-truth/episodes.csv](ground-truth/episodes.csv) has every degradation of the year: the
machine, the failure mode, when it began, when it failed or was found, and the signals that show
it. Each builds up over working days and either stops the machine or is found first, at planned
work (die cleaning, blade and horn changes, monthly maintenance) or by a measurement.

| Mode | Machines | Stops the machine with | Shows in | Builds up over |
| --- | --- | --- | --- | --- |
| Slot die lip build-up | CT-C1, CT-A1 | DT-DIE, unless the planned die cleaning comes first | `coating_weight_cv` and `streaks` up | 2.5 to 6 working days |
| Dryer fan bearing wear | CT-A1 | DT-DRY | `dryer_fan_current` up, `dryer_temp_z3` down, residual solvent up, peel down | 18 to 19 days |
| Calender roll bearing wear | CL-A1 | DT-CAL | `bearing_vibration` up, `thickness_sd` up | 32 to 35 days |
| Slitter blade chipping | SL-C1, SL-A1 | DT-BLD, or found by the burr measurement | `burr_height` up; self-discharge fails two weeks later | 1.4 to 4 days |
| Separator tension loss | ST-01, ST-02 | DT-STK | `separator_tension` down, `overhang_dev` up | 1.6 to 5 days |
| Welding horn wear | UW-01 | DT-WLD | `weld_energy` up, weld peel down, DCIR up | 2 to 5 days |
| Dosing pump wear | EF-01 | DT-FIL | `fill_weight` down, capacity down | 7 days |
| Formation contact corrosion | FM-01, FM-02 | DT-FRM | `contact_resistance` up, `rack_temp` up | 13 to 39 days |
| Desiccant wheel loading | DH-01 | DT-DRM, stopping assembly | `wheel_dp` up, then `dew_point` up, electrode moisture up | 13 to 17 days |

Besides these, the machines stop for web breaks, vision, robot, electrical and other faults that
nothing foretells, for want of material when the machine upstream has none to give, and for
quality holds. A formation rack that is down holds the cells for its channels.

The cells' results come from their genealogy by
[ground-truth/quality-model.json](ground-truth/quality-model.json):

- **Capacity** from the cathode's loading, less what moisture and an under-fill cost.
- **Resistance** from the weld and moisture.
- **Self-discharge** from moisture, plus a micro-short whose chance rises steeply with the burrs
  over 13 µm and with the overhang.

A cell is grade A at 60.0 Ah or more, at most 0.90 mΩ and a K-value of at most 0.20 mV a day; grade
B at 58.8 Ah, 0.95 mΩ and 0.25 mV a day; otherwise NG. A model of the quality driver (T11.01) can be
judged against it.

## Making the large files

```sh
cd api
uv run tiles-sample-plant generate battery --all
```

This writes `generated/` (about 80 MB, not in Git) in about four minutes:

- `historian/<month>/<stream>.csv.gz`: the historian export, one row per reading (timestamp in UTC,
  tag, value, quality): about 14 million readings.
- `tables/cells-<month>.csv.gz`: every cell stacked that month (692,262 in the year) with its
  genealogy, process values, end-of-line results, grade and scrap code.

The manifest's `generated` section gives each file's rows and the SHA-256 of its text, so a run can
be checked against the one recorded.

## Loading it into Tiles

With the API running (`uv run tiles-api`) and a site whose engineer you are, give the site the
plant's clock (Europe/Stockholm), then:

```sh
uv run tiles-sample-plant load battery --site <site id> --as <engineer's email>
```

This loads:

1. **The plant model:** imported and committed.
2. **The readings:** every historian file.
3. **The MES:** its unplanned stops (as downtime events, at their start, the reason code as the value)
   and its scrap (as scrap events).
4. **The signal catalogue:** each signal described and linked to its Signal node, with the wear limits
   of the slot dies, calender bearings, slitter blades, horn, formation contacts and desiccant wheel.
5. **Planned stops:** the planned codes and every planned stop, including the shutdowns.
6. **Documents:** every document, for search.
7. **The cell tables:** one batch table per month (`Cells 2026-06`).

The readings take about as long as the die-casting plant's (about 15 minutes against a local API).
`--no-readings` leaves out the historian and the cell tables (everything else loads in about a
minute); `--token` signs in with an access token instead of the API's development sign-in.
`--shift-to-now` moves every time on by whole weeks, so the year ends last week and the pages' "last
30 days" find it; weekdays and shifts stay as they were, but the question set's dates no longer
hold.

From there, the [user guide](../../../docs/guides/user.md) applies:
- **Plant:** the Assembly line's Coverage card lists what each machine has.
- **Remaining life:** the slot dies, calender bearings, slitter blades, welding horn, formation
  contacts and desiccant wheel have wear limits.
- **Warning performance and the ROI report:** they compare a pilot period with its baseline.
- **Data explorer:** shows a breakdown's lead-up, and the dew point against electrode moisture.
- **Correlation finder:** finds what goes with the self-discharge fails in a month's cell table.

## Asking the copilot's questions

[copilot/questions.csv](copilot/questions.csv) is a partner set in the form of
[the guide](../../../docs/pilot/copilot-questions.md):
- **The plant model:** its lines and machines, and the gap in it.
- **Signals:** what each one is and its unit.
- **Readings:** June 2026's highs, lows and means on the days that matter.
- **MES events:** the reason codes of stops.
- **Wear and root causes:** the wear check, and the root cause of each June breakdown.
- **Documents:** what the SOPs and the lessons learned say.
- **Correlations:** on June's cell table.
- **Declines:** questions the data can't answer, or that ask Tiles to write to a machine.

Each answer's facts are worked out from the year. Two more columns make the set checkable:
- `plan`: the tool calls that answer the question.
- `data`: the readings those calls read.

The test loads that data into a site and has an oracle answer every question from what the tools
give, through the grounding check. To ask Claude, load the plant without `--shift-to-now`, then:

```sh
uv run tiles-evaluate --cases ../data/sample-plants/battery/copilot/questions.csv --site <site id> --as <engineer's email>
```

## What it is for

- **A second industry for the assessment (T2.16):** a continuous process with genealogy, against the
  die-casting plant's discrete cells. [baseline.md](baseline.md) and the ground truth give the
  scoring of candidate problems real numbers.
- **Detectors that see a cause weeks before its effect (T3.06, T7.02):** the burrs ahead of the
  self-discharge fails, the desiccant wheel ahead of the dew point.
- **Remaining life (T9.01) and work orders (T9.02, T9.03):** slow wear with limits, and planned
  stops to fit the work into.
- **The copilot's evaluation (T4.05, T4.06):** 100+ questions, answerable from the data.
- **The process model (T11.01):** the cells' grades from a known model and their genealogy.
- **The ROI report (T6.01, T12.01):** costs, stops and scrap, by machine and by mode.
