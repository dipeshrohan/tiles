"""The biologics site's documents: SOPs whose limits are the simulation's, a site overview,
lessons-learned reports on the year's costliest breakdowns, and monthly operations reports."""

from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path

from tiles_api.sample_plant.biologics import simulate as sim
from tiles_api.sample_plant.biologics.plant import (
    BATCH_COST_EUR,
    BY_ASSET,
    CODES,
    END,
    MACHINES,
    PART_COSTS,
    START,
    ZONE,
)
from tiles_api.sample_plant.common import Episode, Stats, Stop

SOPS: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "SOP-USP-01": (
        "Seed train and inoculation",
        """Applies to the incubator IN-01, the rocking bioreactors WB-01 and WB-02 and the N-1 bioreactors
SB-01 and SB-02. Owner: upstream process lead.

A vial of the BRN-217 working cell bank is thawed into shake flasks, which grow for 9 days in IN-01.
The culture goes to a 50 L rocking bioreactor for 3 days, then to a 500 L N-1 bioreactor for 3.5
days. About 5 million cells a millilitre, with at least 95 % viable, is what the N-1 culture should
reach at transfer. 200 L of it inoculates 1,500 L of medium in a production bioreactor.

An N-1 culture can be held for up to 24 hours when its production bioreactor isn't ready; it then
starts the production culture a little older and less viable.
""",
        ("in-01", "wb-01", "wb-02", "sb-01", "sb-02"),
    ),
    "SOP-USP-02": (
        "Production bioreactors: fed-batch culture",
        """Applies to the production bioreactors BR-01 to BR-04 (2,000 L). Owner: upstream process lead.

Set points: pH 7.05, dissolved oxygen 40 % of air saturation (oxygen sparged on demand), agitation
85 rpm and 110 rpm from day 3. The culture runs at 36.8 °C until day 5 and at 33.5 °C after it: the
temperature shift. Feeds are added daily from day 3.

A sample is taken at 08:00 every day for the viable cell density, viability, glucose, lactate, dissolved
CO2, osmolality and, from day 3, the titre. The cell density peaks at about 23 million cells a
millilitre around day 8 or 9. About 4.5 g/L of antibody is the titre expected at harvest.

On day 14 the culture is harvested; below 70 % viability it is harvested earlier. A culture that
waits for the centrifuge loses viability, and its harvest carries more host cell protein.
""",
        ("br-01", "br-02", "br-03", "br-04"),
    ),
    "SOP-USP-03": (
        "Agitator mechanical seals",
        """Applies to the production bioreactors' agitators. Owner: maintenance and reliability.

Each agitator has a double mechanical seal with a pressurised barrier fluid. Its loss (`seal_loss`)
is logged every 5 minutes. Normally a seal loses about 0.6 mL/h of barrier fluid.

- A seal losing more than 3 mL/h of barrier fluid is replaced at the next turnaround.
- At 6 mL/h the seal has reached its limit: the sterile boundary is at risk.
- A seal that fails during a batch breaches the sterile boundary: the batch is lost (BATCH-SEAL) and
  the reactor stops for the seal's replacement (DT-SEAL). A worn seal also makes a contamination
  likelier.

Each bioreactor has a 36-hour maintenance every 6 batches: seals, valves and probes.
""",
        ("br-01", "br-02", "br-03", "br-04"),
    ),
    "SOP-USP-04": (
        "Bioreactor turnaround: CIP, SIP and media",
        """Applies to the production bioreactors, CIP-01 and MP-01. Owner: upstream process lead.

Between batches each bioreactor is cleaned in place for 3 hours (CIP-01), sterilised in place with
clean steam at 121.5 °C for 2.5 hours, and filled with medium from MP-01 and conditioned for 10
hours. Medium is held for at most 72 hours. WFI out of specification stops media preparation and
the CIP skids (DT-WFI).
""",
        ("br-01", "br-02", "br-03", "br-04", "cip-01", "mp-01"),
    ),
    "SOP-DSP-01": (
        "Harvest: centrifugation and depth filtration",
        """Applies to the centrifuge CF-01, the depth filtration DF-01 and the hold tank HT-01. Owner:
downstream process lead.

The centrifuge runs at 6,500 rpm for about 6 hours a harvest; the centrate goes straight to depth
filtration. Its spindle vibration is normally about 1.9 mm/s; above 4.5 mm/s a bearing change is
planned (PL-BRG). At 7.1 mm/s of spindle vibration the centrifuge trips (DT-CEN).

The clarified harvest is held at 2 to 8 °C in HT-01 for at most 72 hours before capture.
""",
        ("cf-01", "df-01", "ht-01"),
    ),
    "SOP-DSP-02": (
        "Protein A capture",
        """Applies to the chromatography skid CS-01 and its 80 L Protein A column. Owner: downstream process
lead.

At most 35 g of antibody is loaded per litre of resin in a cycle: a harvest takes three or four
cycles of 3.5 hours each. A step yield of about 95 % is normal for a fresh Protein A resin; it falls
as the resin ages, and its pressure drop rises from about 1.1 bar. The resin's dynamic binding
capacity is tested every 25 cycles.

After 150 cycles the Protein A resin is replaced (PL-RSN). 80 L of resin costs about 960,000 EUR.
""",
        ("cs-01",),
    ),
    "SOP-DSP-03": (
        "Low-pH viral inactivation",
        """Applies to the tank VT-01. Owner: downstream process lead.

The Protein A eluate is titrated with acid to pH 3.55 and held for 90 minutes. The pool is held at
pH 3.5 to 3.7 for 60 to 120 minutes to inactivate viruses. A hold above pH 3.70, or shorter than 60
minutes, is a major deviation.
""",
        ("vt-01",),
    ),
    "SOP-DSP-04": (
        "Polishing: cation and anion exchange",
        """Applies to the chromatography skid CS-02. Owner: downstream process lead.

The pool is polished by cation exchange (bind and elute, two cycles of 4 hours) and anion exchange
(flow-through). Before each batch the CEX column's pre-use test measures its peak asymmetry,
normally about 1.1, and its pressure drop, normally about 1.4 bar. Above 1.6 asymmetry at the
pre-use test, the CEX column is repacked (PL-COL). A compressed bed clears fewer aggregates (HMW),
which the drug substance's release test then finds.
""",
        ("cs-02",),
    ),
    "SOP-DSP-05": (
        "Virus filtration and UF/DF",
        """Applies to VF-01 and UF-01. Owner: downstream process lead.

The polished pool is filtered through a Planova 20N filter, whose integrity is tested after use; a
failed test means filtering again through a new filter. UF/DF concentrates the pool to 100 g/L and
exchanges it into the formulation buffer.

Before each batch the cassettes' water flux is measured: normally about 100 LMH/bar. Below 70
LMH/bar of water flux at the pre-use test, the UF/DF cassettes are replaced (PL-UF). Fouled
cassettes run at a higher transmembrane pressure (normally 1.1 to 1.4 bar) and more slowly.
""",
        ("vf-01", "uf-01"),
    ),
    "SOP-DSP-06": (
        "Bulk fill, freezing and release",
        """Applies to BF-01 and the freezer FZ-01. Owner: downstream process lead and QC.

The formulated drug substance is filtered into bags at 100 g/L and frozen at -40 °C in FZ-01. QC tests
each lot. Drug substance is released with at most 2.0 % aggregates, 50 ppm host cell protein and
0.10 EU/mg endotoxin, and a concentration of 95 to 105 g/L. A lot out of specification is rejected
(DS-OOS).
""",
        ("bf-01", "fz-01"),
    ),
    "SOP-FF-01": (
        "Aseptic filling",
        """Applies to the filler FL-01 in the filling room FR-01. Owner: fill-finish lead.

Each vial is filled with 10.30 g; the checkweigher rejects outside 10.15 to 10.45 g (FIL-WT). The
filler's 8 needles fill 60 vials a minute; a worn dosing pump under-fills the vials of its needle.

Normally the filling room is 15 Pa above the corridor. Below 10 Pa between the filling room and the
corridor, filling stops (DT-HVAC). The grade A settle plates at the needles must show no growth: any
colony is a deviation.
""",
        ("fl-01", "fr-01"),
    ),
    "SOP-FF-02": (
        "Lyophilisation",
        """Applies to the lyophiliser LY-01. Owner: fill-finish lead.

The chamber's leak rate is tested before every cycle: normally about 4 µbar·L/s. Above 20 µbar·L/s at
the leak test before a cycle, the lyophiliser is repaired, not run (DT-LYO).

A lyophilisation cycle takes 62 hours from loading to unloading: freezing, primary drying at a shelf
temperature of -15 °C, and secondary drying at 30 °C. The chamber is held at 100 µbar in primary
drying; a leak raises the pressure, and with it the product's temperature. A product that passes
its collapse temperature loses its cake (VIS-CAKE). Up to 2.0 % residual moisture is allowed in a
released lot (LOT-MOIST otherwise).
""",
        ("ly-01",),
    ),
    "SOP-FF-03": (
        "Capping and visual inspection",
        """Applies to CP-01 and AVI-01. Owner: fill-finish lead and QA.

Every vial is capped and inspected by AVI-01's cameras. The reject codes: VIS-CAKE (collapsed cake),
VIS-PART (particles), VIS-COS (cosmetic defects of the glass), VIS-CRIMP (crimp defects). Vials the
checkweigher rejected (FIL-WT) never reach inspection. About 140 EUR is what a rejected vial costs.
""",
        ("cp-01", "avi-01"),
    ),
    "SOP-UT-01": (
        "Water for injection",
        """Applies to WFI-01 (the still and the loop). Owner: maintenance and reliability.

The loop runs at about 81 °C. 1.3 µS/cm is the WFI's conductivity limit; at 1.0 µS/cm the alert
sounds. Its total organic carbon may be at most 500 ppb. WFI out of specification stops media and
buffer preparation and the CIP skids (DT-WFI) until the still is serviced and the loop sanitised. The
still is serviced every month.
""",
        ("wfi-01",),
    ),
    "SOP-UT-02": (
        "Fill-finish HVAC",
        """Applies to AHU-01, which supplies the filling room FR-01. Owner: maintenance and reliability.

The final filters' pressure drop (`filter_dp`) is normally about 175 Pa and checked every month. At
450 Pa the AHU's final filters are changed on the next weekday day shift, and every six months
anyway (PL-FLT). Loaded filters lower the room's pressure and raise its particle counts.
""",
        ("ahu-01", "fr-01"),
    ),
    "SOP-QA-01": (
        "Deviations and CAPA",
        """Applies to the whole site. Owner: head of quality assurance.

A deviation is minor, major or critical. A lost batch is a critical deviation and needs a CAPA, as
does every major deviation. About 850,000 EUR is what a lost batch costs: media, consumables, labour
and the reactor's fortnight.
""",
        ("carrowmore",),
    ),
}


def overview() -> str:
    rows = "\n".join(f"| {m.asset} | {m.label} | {m.vendor} {m.model} | {m.area} |" for m in MACHINES)
    return f"""# Carrowmore biologics site: overview

Brannock Biologics' Carrowmore site makes BRN-217, a humanised IgG1 monoclonal antibody, as drug
substance and as a lyophilised drug product of 1,000 mg a vial. Four 2,000 L bioreactors run 14-day
fed-batch cultures; one purification train and one fill-finish line follow them. The site runs
around the clock: four crews (A to D) on twelve-hour shifts, stopping only for a fortnight's annual
shutdown at the end of July.

## Equipment

| Asset | What | Machine | Where |
| --- | --- | --- | --- |
{rows}

## Who acts on a warning

The shift manager (crews A to D) receives the warnings and calls the maintenance technician of the
shift. The maintenance and reliability lead decides whether a warning was a true alarm. The
upstream, downstream and fill-finish leads own the process settings; the head of quality assurance
owns deviations, CAPAs and release.

## Costs (controlling, 2026)

A lost batch costs about {BATCH_COST_EUR:,.0f} EUR. An hour's stop of a bioreactor costs 2,500 EUR,
the lyophiliser (the fill-finish line's bottleneck) 3,200 EUR, the filler 1,800 EUR, the Protein A skid
1,500 EUR. A rejected vial costs 140 EUR. Parts: {", ".join(f"{k} {v:,.0f} EUR" for k, v in PART_COSTS.items())}.
"""


def _month(t: float) -> str:
    return datetime.fromtimestamp(t, ZONE).strftime("%Y-%m")


def monthly_reports(year: sim.Year) -> dict[str, str]:
    by_month: dict[str, list[Stop]] = defaultdict(list)
    for st in year.stations.values():
        for s in st.stops:
            if not s.planned and s.asset != "AHU-01":
                by_month[_month(s.start)].append(s)
    made: dict[str, Counter[str]] = defaultdict(Counter)
    for b in year.batches:
        if b.inoculated:
            made[_month(b.inoculated)]["inoculated"] += 1
        if b.lost:
            made[_month(b.lost_at)]["lost"] += 1
        if b.bulk_end:
            made[_month(b.bulk_end)]["bulk"] += 1
    for lot in year.lots:
        made[_month(lot.fill[0])]["vials"] += lot.vials
        made[_month(lot.fill[0])]["rejected"] += len(lot.rejects)
    devs: dict[str, Counter[str]] = defaultdict(Counter)
    for d in year.deviations:
        devs[_month(d.opened)][d.classification] += 1
    out = {}
    months = []
    first = START.replace(day=1)
    while first < END:
        months.append(first.strftime("%Y-%m"))
        first = (first + timedelta(days=32)).replace(day=1)
    for month in months:
        title = datetime.strptime(month, "%Y-%m").strftime("%B %Y")
        rows = []
        for m in MACHINES:
            mine = [x for x in by_month[month] if x.asset == m.asset]
            if not mine:
                continue
            hours = sum(x.end - x.start for x in mine) / 3600
            top = Counter(x.code for x in mine).most_common(3)
            rows.append(f"| {m.asset} | {len(mine)} | {hours:.1f} | {', '.join(f'{k} ({v})' for k, v in top)} |")
        notes = (
            "\n".join(
                f"- {datetime.fromtimestamp(x.start, ZONE):%d %B, %H:%M}: {x.asset}"
                f" {CODES[x.code].description.lower()} ({x.comment})."
                for x in sorted(by_month[month], key=lambda x: x.start)
                if x.episode and not x.comment.endswith("(continued)")
            )
            or "- No breakdowns of the watched components."
        )
        c, dv = made[month], devs[month]
        out[f"MR-{month}"] = f"""# Operations report, {title}

{c["inoculated"]} batches inoculated, {c["lost"]} lost, {c["bulk"]} drug substance lots filled;
{c["vials"]:,} vials filled, {c["rejected"]:,} rejected. Deviations opened: {dv["critical"]} critical,
{dv["major"]} major, {dv["minor"]} minor.

| Machine | Unplanned stops | Hours | Most frequent codes |
| --- | --- | --- | --- |
{chr(10).join(rows)}

## Breakdowns

{notes}
"""
    return out


ROOT_CAUSES = {
    "seal": "the agitator's mechanical seal faces wore; the barrier fluid loss rose until the seal leaked.",
    "wfi": "the still's heat exchanger fouled; the distillate's conductivity and TOC crept up.",
    "filter": "the AHU's final filters loaded up; the supply air fell and the room lost its pressure.",
    "bearing": "the centrifuge's spindle bearings wore; its vibration rose until it tripped.",
    "bed": "the CEX column's bed compressed; its peaks tailed and it cleared fewer aggregates.",
    "membrane": "the UF/DF cassettes fouled; their water flux fell and the transmembrane pressure rose.",
    "leak": "the lyophiliser's door seal wore; the chamber leaked and ran at a higher pressure.",
    "pump": "a dosing pump's piston wore; its needle under-filled the vials.",
}
ACTIONS = {
    "seal": "trend the barrier fluid loss through each batch: a seal past 3 mL/h at the turnaround is changed then"
    " (SOP-USP-03), but one that wears fast fails before it.",
    "wfi": "clean the still's heat exchanger when the conductivity passes 1.0 µS/cm (SOP-UT-01).",
    "filter": "change the filters within the shift once they pass 450 Pa, not on the next weekday day shift"
    " (SOP-UT-02).",
    "bearing": "trend the vibration from harvest to harvest: the change planned at 4.5 mm/s (SOP-DSP-01) comes too"
    " late for bearings that wear fast.",
    "bed": "repack at an asymmetry of 1.6, and trend the drug substance's aggregates (SOP-DSP-04).",
    "membrane": "replace the cassettes when the water flux falls below 70 LMH/bar (SOP-DSP-05).",
    "leak": "stop at a leak rate of 20 µbar·L/s, and trend it from cycle to cycle (SOP-FF-02).",
    "pump": "watch the fill weights by needle, not only the checkweigher's rejects (SOP-FF-01).",
}
FIRST = {
    "seal": "seal_loss",
    "wfi": "conductivity",
    "filter": "filter_dp",
    "bearing": "vibration",
    "bed": "cex_asymmetry",
    "membrane": "nwp",
    "leak": "leak_rate",
    "pump": "fill_weight",
}


def lessons(year: sim.Year, stats: Stats) -> dict[str, str]:
    hours: dict[str, float] = defaultdict(float)
    first_stop: dict[str, Stop] = {}
    for st in year.stations.values():
        for s in st.stops:
            if s.episode:
                hours[s.episode] += (s.end - s.start) / 3600
                first_stop.setdefault(s.episode, s)
    lost = {b.id: b for b in year.batches if b.lost == "BATCH-SEAL"}
    failed = [e for st in year.stations.values() for e in st.episodes if e.failed_at and e.id in first_stop]

    def cost(e: Episode) -> float:
        s = first_stop[e.id]
        batch = next(
            (b for b in lost.values() if b.reactor == e.asset and abs(b.lost_at - (e.failed_at or 0)) < 60), None
        )
        return hours[e.id] * BY_ASSET[s.asset].downtime_cost_eur_h + (BATCH_COST_EUR if batch else 0.0)

    failed.sort(key=lambda e: -cost(e))
    numbers: Counter[int] = Counter()
    out = {}
    for e in sorted(failed[:10], key=lambda e: e.failed_at or 0):
        when = datetime.fromtimestamp(e.failed_at or 0, ZONE)
        numbers[when.year] += 1
        mode = sim.MODES[e.mode]
        s = first_stop[e.id]
        tag = f"{BY_ASSET[e.asset].key}.{FIRST[e.mode]}"
        before = _mean(stats, tag, (e.failed_at or 0) - 8 * 86400, e.onset)
        last = _mean(stats, tag, (e.failed_at or 0), e.onset, back=3)
        signal = (
            f"`{tag}` averaged {before:.2f} a week before and {last:.2f} at its last reading before the stop."
            if before is not None and last is not None
            else f"`{tag}` was not logged then."
        )
        what = CODES[mode.code].description.lower()
        batch = next(
            (b for b in lost.values() if b.reactor == e.asset and abs(b.lost_at - (e.failed_at or 0)) < 60), None
        )
        lost_text = f" Batch {batch.id} was lost with it." if batch else ""
        out[
            f"LL-{when:%Y}-{numbers[when.year]:02d}"
        ] = f"""# Lessons learned: {mode.component.lower()} on {s.asset}, {when:%d %B %Y}

**What happened:** {s.asset} stopped at {when:%H:%M} on {when:%A %d %B %Y} ({mode.code}: {what}).
The MES logged: "{s.comment}". It was down {hours[e.id]:.1f} hours, about {cost(e):,.0f} EUR.{lost_text}

**What the data showed:** the problem started around {datetime.fromtimestamp(e.onset, ZONE):%d %B}. {signal}

**Root cause:** {ROOT_CAUSES[e.mode]}

**Actions:** {ACTIONS[e.mode]}
"""
    return out


def _mean(stats: Stats, tag: str, t: float, onset: float, back: int = 0) -> float | None:
    """The tag's mean on the day of `t`, or (with `back`) on the latest day with readings in the
    `back` days before it."""
    for k in range(back + 1):
        at = t - k * 86400
        if back and at < onset:
            break
        s = stats.days.get((tag, datetime.fromtimestamp(at, ZONE).date().isoformat()))
        if s:
            return s[2] / s[3]
    return None


def all_documents(year: sim.Year, stats: Stats | None = None) -> dict[str, tuple[str, str, tuple[str, ...]]]:
    docs = {k: (title, f"# {k}: {title}\n\n{body}", about) for k, (title, body, about) in SOPS.items()}
    docs["SITE-OVERVIEW"] = ("Carrowmore biologics site overview", overview(), ("carrowmore",))
    if stats is not None:
        for k, text in lessons(year, stats).items():
            asset = text.split(" on ", 1)[1].split(",", 1)[0]
            docs[k] = (text.splitlines()[0].removeprefix("# "), text, (asset.lower(),))
    for k, text in monthly_reports(year).items():
        docs[k] = (text.splitlines()[0].removeprefix("# "), text, ("carrowmore",))
    return docs


def write(out: Path, year: sim.Year, stats: Stats) -> dict[str, int]:
    folder = out / "documents"
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob("*.md"):
        old.unlink()
    docs = all_documents(year, stats)
    for k, (_, text, _) in docs.items():
        (folder / f"{k}.md").write_text(text, encoding="utf-8")
    return {"documents": len(docs)}
