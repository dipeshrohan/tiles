# Biologics: a year of Brannock Biologics' Carrowmore site

A complete, made-up monoclonal-antibody site to build and test Tiles on: what a design partner hands
over at the assessment ([T2.16](../../../docs/pilot/assessment.md)), for a year. Brannock Biologics,
its Carrowmore site and its antibody BRN-217 don't exist; the equipment is named by the makers of
such equipment, as a site's asset register would name it.

The year is simulated batch by batch and vial by vial (`api/src/tiles_api/sample_plant/biologics/`),
so every reading follows from the state of the equipment and every lot from its genealogy.
Agitator seals wear, the WFI still's heat exchanger fouls, the fill-finish HVAC's filters load up,
the centrifuge's spindle bearings wear, the CEX column's bed compresses, the UF/DF cassettes foul,
the lyophiliser's door seal starts to leak and a filler's dosing pump wears. Each shows in its
signals beforehand, and some show again downstream: a leaking lyophiliser runs at a higher chamber
pressure, its product runs warmer, and its cakes collapse at inspection. The ground truth says what
happened. The same seed gives the same year on every run.

## Contents

- [The site](#the-site)
- [The files](#the-files)
- [Data-landscape map](#data-landscape-map)
- [Known gaps](#known-gaps)
- [What happened: the ground truth](#what-happened-the-ground-truth)
- [Making the large files](#making-the-large-files)
- [Loading it into Tiles](#loading-it-into-tiles)
- [Asking the copilot's questions](#asking-the-copilots-questions)
- [What it is for](#what-it-is-for)

## The site

BRN-217, a humanised IgG1, as drug substance and as a lyophilised drug product of 1,000 mg in a 20R
vial. The overview is [documents/SITE-OVERVIEW.md](documents/SITE-OVERVIEW.md).

| Area | What | Data |
| --- | --- | --- |
| Seed train | Shake flask incubator IN-01, rocking bioreactors WB-01 and WB-02 (50 L), N-1 bioreactors SB-01 and SB-02 (500 L) | Temperature, pH and dissolved oxygen every 5 minutes; each N-1 culture's cell density and viability at transfer |
| Production bioreactors | BR-01 to BR-04 (2,000 L, 14-day fed-batch), media preparation MP-01, CIP skid CIP-01 | 11 values every 5 minutes each, among them the agitator seal's barrier fluid loss; a daily sample of cell density, viability, glucose, lactate, titre, CO2 and osmolality; MES stops and lost batches |
| Purification train | Centrifuge CF-01, depth filtration DF-01, hold tank HT-01, buffer preparation BP-01, Protein A skid CS-01, viral inactivation VT-01, CEX and AEX skid CS-02, virus filtration VF-01, UF/DF UF-01, bulk fill BF-01, CIP-02, freezer FZ-01 | Chromatograms, pressures and TMP every minute while running; each cycle's yield and pressure drop; each batch's pre-use tests, hold pH and time; MES stops |
| Fill-finish line | Filling room FR-01 (grade B), filler FL-01, lyophiliser LY-01, capper CP-01, inspection AVI-01 | Every vial's fill weight; each lyophilisation cycle's shelf, product, chamber and condenser every minute and its leak test; room pressure and particles; MES stops and every rejected vial |
| Utilities, QC lab | WFI system WFI-01, clean steam CSG-01, air handler AHU-01, cold room CR-01; SEC-HPLC, ELISA, endotoxin and Karl Fischer | WFI conductivity, TOC and temperature, the AHU's filter pressure drop every 5 minutes; release tests, resin binding capacity, grade A settle plates |

Each lot's genealogy is kept: the working cell bank vial, the rocking and N-1 bioreactors, the
production bioreactor, the harvest, every Protein A cycle (with the resin's cycle number), the drug
substance lot and the fill lot, down to each vial's needle and its shelf in the lyophiliser. QC
results and the vials' fate come from that genealogy, by the process model in
[ground-truth/process-model.json](ground-truth/process-model.json).

The year runs from 1 October 2025 to 30 September 2026 on the site's clock (Europe/Dublin), around
the clock: four crews (A to D) on twelve-hour shifts (07:00 to 19:00 and 19:00 to 07:00) on a 2-2-3
rotation. Cell culture can't stop, so the site closes only for a fortnight's annual shutdown
(27 July to 10 August 2026), and no culture runs over it. [baseline.md](baseline.md) gives each
machine's stops, hours and their cost, the batches and the vials.

## The files

Everything here is made by `uv run tiles-sample-plant generate biologics` (from `api/`), except this
README; `api/tests/test_sample_biologics.py` fails when a file is not what the generator makes. The
large files are made with `--all` (below).

| File | What | In Tiles |
| --- | --- | --- |
| [plant/ontology.json](plant/ontology.json) | The plant model: enterprise, site, areas, lines, equipment, control systems, signals, processes, materials and documents, mapped to ISA-95 ([data model](../../../docs/data-model.md)) | Ontology import |
| [plant/tags.csv](plant/tags.csv) | Every tag: unit, rate, description, machine, what it measures, expected range, stuck limit, wear limit | The signal catalogue |
| [plant/equipment.csv](plant/equipment.csv) | The asset register | |
| [plant/products.csv](plant/products.csv), [plant/costs.csv](plant/costs.csv) | BRN-217, and controlling's costs of a stop hour, a lost batch, a gram of drug substance, a vial and the spare parts | The ROI report's figures |
| [plant/people.csv](plant/people.csv) | Who does what, with the Tiles role each would have | Site members |
| [mes/stops.csv](mes/stops.csv) | Every stop: start, end, machine, reason code, planned or not, shift, crew, comment | Unplanned stops as downtime events |
| [mes/reason-codes.csv](mes/reason-codes.csv) | The MES's downtime and scrap codes | Planned codes |
| [mes/scrap.csv](mes/scrap.csv) | Every lost batch, rejected lot and rejected vial with its code | Scrap events |
| [mes/production.csv](mes/production.csv) | Batches inoculated, harvested and lost, drug substance lots and kilograms, vials filled, rejected and passed, per shift | Rates per 1,000 parts |
| [batch-records/](batch-records/) | The electronic batch records: every batch with its seed train and harvest, its unit operations, its Protein A cycles, the media and buffer lots, the drug substance lots and the fill lots | |
| [qms/deviations.csv](qms/deviations.csv), [qms/capa.csv](qms/capa.csv) | The quality system's year: every deviation (minor, major, critical) with its root cause, and the CAPAs | |
| [calendar/shifts.csv](calendar/shifts.csv), [calendar/planned-stops.csv](calendar/planned-stops.csv) | The shifts worked; the shutdown and the planned stops | Planned stops |
| [cmms/work-orders.csv](cmms/work-orders.csv) | The CMMS's year: corrective, preventive and condition-based work orders, with hours, parts and costs | |
| [lab/](lab/) | Release tests of every drug substance and drug product lot, grade A settle plates, the resin's binding capacity | Also the `lab.*` signals |
| [documents/](documents/) | SOPs, lessons-learned reports on the year's costliest breakdowns, monthly operations reports | Document search |
| [copilot/questions.csv](copilot/questions.csv) | 100+ questions with the facts their answers must state ([below](#asking-the-copilots-questions)) | The copilot's evaluation |
| [ground-truth/](ground-truth/) | What really happened: each degradation, the process model, the known gaps | |
| [manifest.json](manifest.json) | Each file's rows; for the large files, rows and the SHA-256 of their text; the batch tables | |

## Data-landscape map

As the assessment's [map](../../../docs/pilot/assessment.md#data-landscape-map) has it.

| Source | System and version | Machines | Signals (count, examples) | Rate | History | Access path | Owner | Tiles connector |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Upstream DCS | Emerson DeltaV, OPC UA | Seed train, bioreactors, media, CIP | 54 (temperature, pH, dissolved oxygen, gas flows, weight, seal barrier fluid loss) | 5 minutes | 1 year | OPC UA, from the OT DMZ | Automation | OPC UA |
| Upstream samples | Cell counter and bioprocess analyser, through the DCS | BR-01 to BR-04, SB-01, SB-02, MP-01, CIP-01 | 35 (cell density, viability, glucose, lactate, titre, CO2, osmolality; media lots, CIP rinses) | Daily, per lot | 1 year | OPC UA | Upstream | OPC UA |
| Downstream DCS | Emerson DeltaV, OPC UA | Centrifuge, skids, tanks, bulk fill | 26 (chromatograms, pressures, TMP, pre-use tests, cycle yields) | Every minute while running; per cycle and batch | 1 year | OPC UA | Automation | OPC UA |
| Fill-finish PLC | Siemens S7-1500, OPC UA | Filler, lyophiliser, room | 10 (every vial's fill weight; shelf, product, chamber, condenser; leak test; room pressure and particles) | Per vial; every minute in a cycle | 1 year | OPC UA | Fill-finish | OPC UA |
| BMS and utilities | Siemens Desigo CC; Rockwell ControlLogix with Kepware | AHU-01, CR-01, WFI-01, CSG-01 | 10 (filter pressure drop, supply air, cold room, WFI conductivity, TOC) | 5 minutes | 1 year | OPC UA | Facilities | OPC UA |
| Historian | Exports of the above | Every area | 141 | as above | 1 year | CSV export (`generated/historian/`) | IT | Import (backfill) |
| LIMS | LabWare LIMS 8 | QC lab | 7 (aggregates, host cell protein, endotoxin, concentration, moisture, binding capacity, settle plates) | Per lot | 1 year | SQL, read-only (`lab/`) | QC | SQL |
| MES and EBR | Stops, scrap, batch records | 26 machines | Stops, lost batches, rejected vials, batch records | Per event, per batch | 1 year | CSV export (`mes/`, `batch-records/`) | Production | Import, as events |
| QMS | Deviations and CAPA | Every area | Deviations, CAPAs | Per record | 1 year | CSV export (`qms/`) | Quality | |
| Vial genealogy | MES traceability and inspection | Every vial | Fill lot, batch, reactor, needle, shelf, cycle, result | Per vial | 1 year | CSV export (`generated/tables/`) | Quality | Batch tables |
| CMMS | Work orders | Every machine | Work orders | Per job | 1 year | CSV export (`cmms/`) | Maintenance | |

## Known gaps

What a real export has, and what the assessment's data-quality check should find
([ground-truth/quirks.csv](ground-truth/quirks.csv)):

- **A drifting sensor:** br02.do reads 6 points high from 2 February 2026 08:00, when its membrane was
  changed, until its calibration on 23 February 10:00 (a minor deviation records the find).
- **The wrong unit:** ly01.chamber_pressure is in mTorr (0.75 of the µbar values) from 9 March 08:00
  to 16 March 08:00, after a gauge software update.
- **A historian outage:** no readings of the chromatography skids (cs01.\*, cs02.\*) from 14 April
  2026 00:00 to 16 April 06:00. The batch records kept going.
- **A clock offset:** the lyophiliser's clock stayed on winter time from 29 March to 5 April, so
  ly01.\* readings are an hour early.
- **A renamed code:** lyophiliser leak failures are `LYO` until the MES update on 19 January 2026,
  `DT-LYO` after.
- **Booking errors:** about 0.4% of stops are logged twice; about 0.3% of unplanned stops have no
  end time.
- **The plant model:** a retired 500 L bioreactor (BR-05) entered with no relationships.

## What happened: the ground truth

[ground-truth/episodes.csv](ground-truth/episodes.csv) has every degradation of the year: the
machine, the failure mode, when it began, when it failed or was found, and the signals that show
it. Each builds up over working days and either stops the machine or is found first: at planned
maintenance, by a pre-use test, at a turnaround check or by a planned change.

| Mode | Machines | Stops the machine with | Shows in | Builds up over |
| --- | --- | --- | --- | --- |
| Agitator seal wear | BR-01 to BR-04 | DT-SEAL; during a batch the batch is lost (BATCH-SEAL), unless the turnaround check changes the seal | `seal_loss` up; contamination likelier | 12 to 30 working days |
| WFI still fouling | WFI-01 | DT-WFI, stopping media and buffer preparation and the CIP skids | `wfi01.conductivity` and `wfi01.toc` up | 7 to 18 days |
| HVAC final filter loading | AHU-01 | DT-HVAC on FR-01, stopping filling and capping, unless the six-monthly change comes first | `ahu01.filter_dp` up, then `fr01.room_dp` down and particles up | 9 to 24 days |
| Centrifuge spindle bearings | CF-01 | DT-CEN, a vibration trip at start-up; the culture waits | `cf01.vibration` up | 20 to 25 days |
| CEX bed compression | CS-02 | DT-COL, or a planned repack when the pre-use test finds it | `cs02.cex_asymmetry` and `cs02.cex_dp` up; the drug substance's aggregates up | 9 to 20 days |
| UF/DF cassette fouling | UF-01 | DT-UF | `uf01.nwp` down, `uf01.tmp` up | 8 to 24 days |
| Lyophiliser leak | LY-01 | DT-LYO, at the leak test before a cycle | `ly01.leak_rate` and the chamber pressure up; moisture and collapsed cakes up | 16 to 19 days |
| Dosing pump wear | FL-01 | DT-FIL | One needle's `fl01.fill_weight` down; FIL-WT rejects | 8 to 9 days |

Besides these, the equipment stops for control system faults, vial jams, camera faults, missing
materials and other faults that nothing foretells. A contamination can lose a batch at any time,
and likelier with a worn seal; a culture that waits for the centrifuge loses viability and carries
more host cell protein; the Protein A resin yields less as it ages and is replaced after 150 cycles.

The process model, [ground-truth/process-model.json](ground-truth/process-model.json):

- **Protein A:** each cycle's step yield falls and its pressure drop rises with the resin's cycles.
- **Aggregates:** the harvest's from its viability; the CEX column clears fewer as its bed compresses.
- **Host cell protein:** from the viability at harvest and the hold before capture.
- **Cakes and moisture:** the chamber pressure rises with the leak rate; a vial's product temperature
  with the pressure, its shelf and whether it stands at the edge; past the collapse temperature its
  cake collapses. Moisture rises with the pressure.
- **Fill weights:** a worn pump fills its needle's vials less and less evenly.

The specifications are those of the SOPs: drug substance at most 2.0 % aggregates, 50 ppm host cell
protein and 0.10 EU/mg endotoxin; drug product at most 2.0 % moisture. A model of the quality driver
(T11.01) can be judged against it.

## Making the large files

```sh
cd api
uv run tiles-sample-plant generate biologics --all
```

This writes `generated/` (about 36 MB, not in Git) in about two minutes:

- `historian/<month>/<stream>.csv.gz`: the historian export, one row per reading (timestamp in UTC,
  tag, value, quality): about 8.5 million readings.
- `tables/vials-<month>.csv.gz`: every vial filled that month (about 375,000 in the year) with its
  genealogy, needle, fill weight, shelf, the cycle's leak rate and pressure, its product
  temperature, its batch's harvest viability, resin cycle, CEX asymmetry and aggregates, and its
  inspection.

The manifest's `generated` section gives each file's rows and the SHA-256 of its text, so a run can
be checked against the one recorded.

## Loading it into Tiles

With the API running (`uv run tiles-api`) and a site whose engineer you are, give the site the
plant's clock (Europe/Dublin), then:

```sh
uv run tiles-sample-plant load biologics --site <site id> --as <engineer's email>
```

This loads:

1. **The plant model:** imported and committed.
2. **The readings:** every historian file.
3. **The MES:** its unplanned stops (as downtime events, at their start, the reason code as the value)
   and its scrap: lost batches, rejected lots and vials (as scrap events).
4. **The signal catalogue:** each signal described and linked to its Signal node, with the wear limits
   of the agitator seals, the centrifuge, the resin, the CEX column, the cassettes, the
   lyophiliser, the WFI and the AHU's filters.
5. **Planned stops:** the planned codes and every planned stop, including the shutdown.
6. **Documents:** every document, for search.
7. **The vial tables:** one batch table per month (`Vials 2026-06`).

The readings take a little less than the die-casting plant's (about 15 minutes against a local
API). `--no-readings` leaves out the historian and the vial tables (everything else loads in about a
minute); `--token` signs in with an access token instead of the API's development sign-in.
`--shift-to-now` moves every time on by whole weeks, so the year ends last week and the pages' "last
30 days" find it; weekdays and shifts stay as they were, but the question set's dates no longer
hold.

From there, the [user guide](../../../docs/guides/user.md) applies:
- **Plant:** the production bioreactors' Coverage card lists what each has.
- **Remaining life:** the seals, the centrifuge, the resin, the CEX column, the cassettes, the
  lyophiliser, the WFI and the AHU's filters have wear limits.
- **Warning performance and the ROI report:** they compare a pilot period with its baseline.
- **Data explorer:** shows a breakdown's lead-up, and a culture's 14 days.
- **Correlation finder:** finds what goes with the collapsed cakes in a month's vial table.

## Asking the copilot's questions

[copilot/questions.csv](copilot/questions.csv) is a partner set in the form of
[the guide](../../../docs/pilot/copilot-questions.md):
- **The plant model:** its lines and equipment, its control systems, and the gap in it.
- **Signals:** what each one is and its unit.
- **Readings:** May and June 2026's highs, lows and means on the days that matter.
- **MES events:** the reason codes of stops, and why a vial was rejected.
- **Wear and root causes:** the wear check and the root cause of each breakdown of May and June.
- **Documents:** what the SOPs and the lessons learned say.
- **Correlations:** on June's vial table.
- **Declines:** questions the data can't answer, or that ask Tiles to write to a control system or
  release a lot.

Each answer's facts are worked out from the year. Two more columns make the set checkable:
- `plan`: the tool calls that answer the question.
- `data`: the readings those calls read.

The test loads that data into a site and has an oracle answer every question from what the tools
give, through the grounding check. To ask Claude, load the plant without `--shift-to-now`, then:

```sh
uv run tiles-evaluate --cases ../data/sample-plants/biologics/copilot/questions.csv --site <site id> --as <engineer's email>
```

## What it is for

- **A batch process for the assessment (T2.16):** cultures that can't be paused, lots worth
  850,000 EUR, and a quality system's deviations and CAPAs, against the other plants' continuous and
  discrete lines. [baseline.md](baseline.md) and the ground truth give the scoring of candidate
  problems real numbers.
- **Detectors that save a batch (T3.06, T7.02):** a seal's barrier fluid loss rises for weeks before
  it leaks.
- **Remaining life (T9.01) and work orders (T9.02, T9.03):** the resin's cycles, the seals and the
  filters, with planned stops and turnarounds to fit the work into.
- **The copilot's evaluation (T4.05, T4.06):** 100+ questions, answerable from the data.
- **The process model (T11.01):** the vials' cakes and the lots' aggregates from a known model and
  their genealogy.
- **The ROI report (T6.01, T12.01):** costs, stops, lost batches and rejected vials, by machine and by
  mode.
