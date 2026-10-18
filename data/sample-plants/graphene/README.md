# Graphene film: a year of Sorrel Carbon's Ashcombe plant

A complete, made-up graphene film plant to build and test Tiles on: what a design partner hands
over at the assessment ([T2.16](../../../docs/pilot/assessment.md)), for a year. Sorrel Carbon and
its Ashcombe plant don't exist; the equipment is named by the makers of such machines, as a plant's
asset register would name it.

The year is simulated run by run and roll by roll (`api/src/tiles_api/sample_plant/graphene/`), so
every reading follows from the state of the machines and every roll from its genealogy. Things wear:
- the CVD tubes' seals start to leak;
- zone 2's heating elements age, and the dry vacuum pumps wear;
- the methane controllers drift while still reading their set point;
- the electropolishing rectifier ripples;
- the laminator rolls wear, and the etchant pumps weaken;
- the exhaust scrubber's packing fouls until it trips the whole CVD hall.

Each shows in its signals beforehand, and in the film. A leak lets oxygen in, and the graphene comes
out defective (Raman D/G) and more resistive. A tired etch bath with a weak pump leaves copper
behind and costs transmittance. A rough copper lot grows smaller grains. The ground truth says what
happened. The same seed gives the same year on every run.

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

SG-300 transparent conductive film for touch sensors and transparent heaters: monolayer graphene,
grown by roll-to-roll chemical vapour deposition on 18 µm copper foil, transferred onto 125 µm PET,
and sold in 150 mm rolls of 100 m. The overview is
[documents/PLANT-OVERVIEW.md](documents/PLANT-OVERVIEW.md).

| Area | What | Data |
| --- | --- | --- |
| Foil preparation | Electropolishing line EP-01 | Current density and foil speed every minute while polishing; bath temperature and conductivity, and the rectifier's ripple, every 5 minutes; the lab's roughness of each foil lot |
| CVD hall | Reactors CVD-01 to CVD-04 (14-hour runs of 300 m), exhaust scrubber SC-01, gas supply GS-01 | Foil speed and tension, methane and hydrogen flows and chamber pressure every minute while growing; the three zones' temperatures, zone 2's heater power, the exhaust's oxygen and the pump's current every 5 minutes; each run's base pressure; the scrubber's pressure drop, flow and pH |
| Transfer cleanroom | Transfer lines TL-01 and TL-02 (lamination onto PET, copper etching), cleanroom CR-01 | Web speed, nip pressure, etch rate and rinse conductivity every minute while running; the laminator roll's temperature and its spread, the etch bath's temperature, flow and copper every 5 minutes; the cleanroom's particles |
| Inspection and finishing | Inline inspection IN-01, slitter and packer SP-01 | Sheet resistance, transmittance and defects every minute of film inspected |
| Utilities, quality lab | Chiller, DI water; Raman, four-point probe, AFM | Utility values every 5 minutes; each run's Raman D/G and 2D/G and four-point sheet resistance |

Each roll's genealogy is kept: its CVD run and reactor, its foil roll, lot and supplier, and its
transfer line. Its inspection results come from that genealogy, by the quality model in
[ground-truth/quality-model.json](ground-truth/quality-model.json).

The year runs from 1 October 2025 to 30 September 2026 on the plant's clock (Europe/London). There
are three eight-hour shifts from Monday 06:00 to Saturday 06:00, with three crews rotating weekly.
There are no shifts on England's bank holidays, in the Christmas shutdown (19 December to 4 January)
or in the summer shutdown (3 to 9 August). A run is started only if it can finish within the
working week and before its reactor's planned maintenance. [baseline.md](baseline.md) gives each
machine's stops, hours and their cost, and the film's yield and scrap.

## The files

Everything here is made by `uv run tiles-sample-plant generate graphene` (from `api/`), except this
README; `api/tests/test_sample_graphene.py` fails when a file is not what the generator makes. The
large files are made with `--all` (below).

| File | What | In Tiles |
| --- | --- | --- |
| [plant/ontology.json](plant/ontology.json) | The plant model: enterprise, site, workcenters, lines, machines, PLCs, signals, processes and materials, mapped to ISA-95 ([data model](../../../docs/data-model.md)) | Ontology import |
| [plant/tags.csv](plant/tags.csv) | Every tag: unit, rate, description, machine, what it measures, expected range, stuck limit, wear limit | The signal catalogue |
| [plant/equipment.csv](plant/equipment.csv) | The asset register | |
| [plant/products.csv](plant/products.csv), [plant/costs.csv](plant/costs.csv) | SG-300, and controlling's costs in GBP: a stop hour, a rejected roll, a scrapped run and the spare parts | The ROI report's figures |
| [plant/people.csv](plant/people.csv) | Who does what, with the Tiles role each would have | Site members |
| [mes/stops.csv](mes/stops.csv) | Every stop: start, end, machine, reason code, planned or not, shift, crew, comment | Unplanned stops as downtime events |
| [mes/reason-codes.csv](mes/reason-codes.csv) | The MES's downtime and scrap codes | Planned codes |
| [mes/scrap.csv](mes/scrap.csv) | Every scrapped run and rejected roll with its code | Scrap events |
| [mes/foil-lots.csv](mes/foil-lots.csv), [mes/runs.csv](mes/runs.csv), [mes/rolls.csv](mes/rolls.csv) | Every copper lot, CVD run (with its transfer and bath) and finished roll | |
| [mes/production.csv](mes/production.csv) | Foils polished, runs grown and transferred, and rolls graded, per shift | Rates per 1,000 parts |
| [calendar/shifts.csv](calendar/shifts.csv), [calendar/planned-stops.csv](calendar/planned-stops.csv) | The shifts worked; the weekends, holidays, shutdowns and planned stops | Planned stops |
| [cmms/work-orders.csv](cmms/work-orders.csv) | The CMMS's year: corrective, preventive and condition-based work orders, with hours, parts and costs | |
| [lab/raman.csv](lab/raman.csv), [lab/four-point-probe.csv](lab/four-point-probe.csv), [lab/foil-roughness.csv](lab/foil-roughness.csv) | The lab's tests | Also the `lab.*` signals |
| [documents/](documents/) | SOPs, lessons-learned reports on the year's worst breakdowns, monthly maintenance reports | Document search |
| [copilot/questions.csv](copilot/questions.csv) | 110 questions with the facts their answers must state ([below](#asking-the-copilots-questions)) | The copilot's evaluation |
| [ground-truth/](ground-truth/) | What really happened: each degradation, each run's hidden values (the true growth temperature and methane flow, grain size, bilayer, copper left), the quality model, the known gaps | |
| [manifest.json](manifest.json) | Each file's rows; for the large files, rows and the SHA-256 of their text; the batch tables | |

## Data-landscape map

As the assessment's [map](../../../docs/pilot/assessment.md#data-landscape-map) has it.

| Source | System and version | Machines | Signals (count, examples) | Rate | History | Access path | Owner | Tiles connector |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Reactor PLCs | Beckhoff CX5240, OPC UA, one a reactor | CVD-01 to CVD-04 | 48: 20 while growing (foil speed and tension, methane and hydrogen flows, chamber pressure), 24 on the grid (zone temperatures, heater power, oxygen, pump current), and 4 base pressures, one each run | Every minute while growing; 5 minutes | 1 year | OPC UA, from the OT DMZ | OT lead | OPC UA |
| Foil and transfer PLCs | Siemens S7-1500, OPC UA | EP-01, TL-01, TL-02 | 23: 10 while running (current density, speeds, nip pressure, etch rate, rinse conductivity), 13 on the grid (bath temperatures and conductivity, ripple, laminator temperature and spread, etch flow, bath copper) | Every minute while running; 5 minutes | 1 year | OPC UA | OT lead | OPC UA |
| Inline inspection | Suragus gateway, MQTT | IN-01 | 3 (sheet resistance, transmittance, defects) | Every minute of film | 1 year | MQTT | Quality | MQTT |
| Utilities PLC | Schneider M580, Modbus TCP | SC-01, GS-01, CR-01, CH-01, DI-01 | 8 (scrubber pressure drop, flow and pH, hydrogen pressure, particles, cleanroom temperature, cooling water, DI water) | 5 minutes | 1 year | Modbus TCP | Facilities | Modbus |
| Historian | Exports of the above, and the lab's results | Every line | 86 | as above | 1 year | CSV export (`generated/historian/`) | IT | Import (backfill) |
| MES | Stop and scrap logs, runs and rolls | 10 machines | Stops, scrap, runs, rolls, production per shift | Per event, per run, per shift | 1 year | CSV export (`mes/`) | Production | Import, as events |
| Roll genealogy | MES traceability and the inspection | Every roll | Run, reactor, foil and lot, line, process values, grade | Per roll | 1 year | CSV export (`generated/tables/`) | Quality | Batch tables |
| Lab | Raman, four-point probe, AFM | Each run, each foil lot | D/G, 2D/G, sheet resistance, roughness | Per sample | 1 year | CSV export (`lab/`) | Quality | Import |
| CMMS | Work orders | Every machine | Work orders | Per job | 1 year | CSV export (`cmms/`) | Maintenance | |

## Known gaps

What a real export has, and what the assessment's data-quality check should find
([ground-truth/quirks.csv](ground-truth/quirks.csv)):

- **A drifting thermocouple, with a real effect:**
  - from 12 January 2026 06:00 to 6 February 10:00, CVD-02's zone 2 thermocouple read 8 °C high;
  - the controller held the furnace 8 °C cooler than `cvd02.zone2_temp` shows, and its runs grew
    smaller grains;
  - the historian and `mes/runs.csv` show 1,035 °C; only the ground truth's runs have the actual
    temperature.
- **The wrong unit:** tl01.etch_temp is in °F from 11 May 2026 06:00 to 18 May 06:00, after an HMI
  update.
- **A historian outage:** no readings of the scrubber (sc01.\*) from 14 April 2026 00:00 to 15 April
  12:00.
- **A renamed tag:** ep01.current_ripple was logged as ep01.ripple_pct until the PLC update on
  1 December 2025.
- **A stuck value:** cr01.particles froze at one reading from 18 May 2026 10:00 to 21 May 14:00.
- **A renamed code:** the scrubber's stops are `SCRB` until the MES update on 2 February 2026,
  `DT-EXH` after.
- **Booking errors:** about 0.4% of stops are logged twice; about 0.3% of unplanned stops have no
  end time.
- **The plant model:** a fifth reactor (CVD-05), being commissioned, entered with no relationships.
- **A hidden one:** a drifting methane controller still reads its 30 sccm set point (`ch4_flow`), so
  the flow can't show it; only the film's transmittance and Raman 2D/G do.

## What happened: the ground truth

[ground-truth/episodes.csv](ground-truth/episodes.csv) has every degradation of the year: the
machine, the failure mode, when it began, when it failed or was found, and the signals that show
it. Each builds up over working days and either stops the machine or is found first, at planned
maintenance or by a check.

| Mode | Machines | Stops the machine with | Shows in | Builds up over |
| --- | --- | --- | --- | --- |
| Tube seal leak | CVD-01 to CVD-04 | DT-VAC: the base pressure too high to start | `oxygen` up, `base_pressure` up; Raman D/G and sheet resistance up | 11 to 22 working days |
| Heater element ageing | CVD-01 to CVD-04 | DT-HTR, or found at maintenance | `heater_power` up, then `zone2_temp` down; sheet resistance up | 20 to 40 days |
| Dry pump wear | CVD-02 | DT-PMP | `pump_current` up, `base_pressure` up | 6 to 16 days |
| Methane controller drift | CVD-01 to CVD-03 | Found at the monthly calibration, or DT-MFC by the transmittance check (SOP-CVD-03) | `in01.transmittance` down, Raman 2D/G down; not `ch4_flow` | 5 to 13 days |
| Rectifier ripple | EP-01 | DT-EPL | `current_ripple` up; the foil's roughness up | 6.5 to 11 days |
| Laminator roll wear | TL-01, TL-02 | DT-LAM | `roll_temp_spread` up; defects and tears | 3 to 9 days |
| Etch pump wear | TL-02 | DT-ETC | `etch_flow` down, `etch_rate` down; transmittance down | 7 days |
| Scrubber packing fouling | SC-01 | DT-EXH at 14 mbar, stopping the CVD hall and aborting its runs, or found at its monthly check | `differential_pressure` up, `exhaust_flow` down | 15.5 to 19 days |

Besides these, the machines stop for foil breaks, gas alarms, web breaks, vision, electrical and
other faults that nothing foretells, and the scrubber's monthly check stops the hall for 4 hours
(PL-EXH), planned for. A run's foil can wrinkle in the furnace (CVD-WRK), and the film
can tear at transfer (TL-TEAR). Each etch bath gathers about 3.9 g/L of copper a run. Its change is
planned at 45 g/L for the next shift and done before 55 g/L; past that, a weak pump leaves copper
behind.

The rolls' results come from their genealogy by
[ground-truth/quality-model.json](ground-truth/quality-model.json):

- **Sheet resistance** from the graphene's defects (Raman D/G, from oxygen), its grain size (from
  the growth temperature and the foil's roughness), bilayer patches, the laminator's wear and any
  copper left.
- **Transmittance** from bilayer patches (a drifting methane controller), defects and copper left.
- **Defects** from the laminator's wear, the cleanroom's particles and copper left.

A roll is grade A at most 350 Ω/sq, at least 97.0 % and at most 3 defects a m²; grade B at 450 Ω/sq,
96.0 % and 8 a m²; otherwise NG. A model of the quality driver (T11.01) can be judged against it.

## Making the large files

```sh
cd api
uv run tiles-sample-plant generate graphene --all
```

This writes `generated/` (about 45 MB, not in Git) in a few minutes:

- `historian/<month>/<stream>.csv.gz`: the historian export, one row per reading (timestamp in UTC,
  tag, value, quality): about 11.2 million readings.
- `tables/rolls-<month>.csv.gz`: every roll inspected that month (8,064 in the year) with its
  genealogy, process values, inspection results, grade and scrap code.

The manifest's `generated` section gives each file's rows and the SHA-256 of its text, so a run can
be checked against the one recorded.

## Loading it into Tiles

With the API running (`uv run tiles-api`) and a site whose engineer you are, give the site the
plant's clock (Europe/London), then:

```sh
uv run tiles-sample-plant load graphene --site <site id> --as <engineer's email>
```

This loads:

1. **The plant model:** imported and committed.
2. **The readings:** every historian file.
3. **The MES:** its unplanned stops (as downtime events, at their start, the reason code as the value)
   and its scrap (as scrap events).
4. **The signal catalogue:** each signal described and linked to its Signal node. Wear limits are set
   on the heater power, oxygen, pump current, ripple, laminator spread, bath copper and the
   scrubber's pressure drop.
5. **Planned stops:** the planned codes and every planned stop, including the weekends and shutdowns.
6. **Documents:** every document, for search.
7. **The roll tables:** one batch table per month (`Film rolls 2026-03`).

The readings take a little less time than the die-casting plant's. `--no-readings` leaves out the
historian and the roll tables (everything else loads in about a minute). `--token` signs in with an
access token instead of the API's development sign-in. `--shift-to-now` moves every time on by whole
weeks, so the year ends last week and the pages' "last 30 days" find it. Weekdays and shifts stay as
they were, but the question set's dates no longer hold.

From there, the [user guide](../../../docs/guides/user.md) applies:
- **Plant:** the CVD hall's Coverage card lists what each reactor has.
- **Remaining life:** the heaters, tube seals, pumps, rectifier, laminator rolls, etch baths and
  scrubber packing have wear limits.
- **Warning performance and the ROI report:** they compare a pilot period with its baseline, in GBP.
- **Data explorer:** shows a breakdown's lead-up, and a bath's copper against the etch rate.
- **Correlation finder:** finds what goes with the sheet resistance rejects in a month's roll table.

## Asking the copilot's questions

[copilot/questions.csv](copilot/questions.csv) is a partner set in the form of
[the guide](../../../docs/pilot/copilot-questions.md):
- **The plant model:** its halls and machines, and the gap in it.
- **Signals:** what each one is and its unit.
- **Readings:** March 2026's highs, lows and means on the days that matter.
- **MES events:** the reason codes of stops, an aborted run and rejected rolls.
- **Wear and root causes:** the wear check against the week before, and the root cause of each March
  breakdown.
- **Documents:** what the SOPs and the lessons learned say.
- **Correlations:** on March's roll table.
- **Declines:** questions the data can't answer, or that ask Tiles to write to a machine.

Each answer's facts are worked out from the year. Two more columns make the set checkable:
- `plan`: the tool calls that answer the question.
- `data`: the readings those calls read.

The test loads that data into a site and has an oracle answer every question from what the tools
give, through the grounding check. To ask Claude, load the plant without `--shift-to-now`, then:

```sh
uv run tiles-evaluate --cases ../data/sample-plants/graphene/copilot/questions.csv --site <site id> --as <engineer's email>
```

## What it is for

- **A plant that stops at weekends (T2.16):** long runs that must fit the week, a whole hall stopped
  by one utility, and a process whose output is measured only after two more steps.
  [baseline.md](baseline.md) and the ground truth give the scoring of candidate problems real
  numbers.
- **Detectors and the data-quality check (T2.09, T3.06, T7.02):**
  - a leak's oxygen weeks before the reactor stops;
  - a scrubber's pressure drop before the hall trips;
  - a thermocouple whose drift only the film reveals;
  - a controller that reads its set point.
- **Remaining life (T9.01) and work orders (T9.02, T9.03):** slow wear with limits, and weekends and
  planned stops to fit the work into.
- **The copilot's evaluation (T4.05, T4.06):** 110 questions, answerable from the data.
- **The process model (T11.01):** the rolls' grades from a known model and their genealogy.
- **The ROI report (T6.01, T12.01):** costs, stops and scrap, by machine and by mode, in GBP.
