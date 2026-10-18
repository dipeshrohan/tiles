"""The graphene plant's copilot question set (the form of docs/pilot/copilot-questions.md), each
question with the facts its answer must state, worked out from the year, the tool calls that
answer it (`plan`) and the readings they read (`data`). Readings questions are about March 2026
(`QUESTION_MONTH` in generate.py)."""

import statistics
from datetime import datetime, timedelta

from tiles_api import correlate
from tiles_api.sample_plant.common import Capture, Episode, Question, Stats, Stop, borderline, number
from tiles_api.sample_plant.graphene import simulate as sim
from tiles_api.sample_plant.graphene.plant import BY_ASSET, ZONE, all_tags

# What shows a failure mode coming: the tag (its machine's key and name), which way it moves, and
# the places its readings are stated to.
PRECURSOR = {
    "leak": ("oxygen", "up", 2),
    "heater": ("heater_power", "up", 2),
    "pump": ("pump_current", "up", 2),
    "rectifier": ("current_ripple", "up", 2),
    "laminator": ("roll_temp_spread", "up", 2),
    "etch-pump": ("etch_flow", "down", 1),
    "packing": ("differential_pressure", "up", 2),
}
WORDS = {
    "oxygen": "oxygen in the exhaust",
    "heater_power": "zone 2 heater power",
    "pump_current": "vacuum pump current",
    "current_ripple": "rectifier current ripple",
    "roll_temp_spread": "laminator roll temperature spread",
    "etch_flow": "etchant flow",
    "differential_pressure": "pressure drop over the packing",
}
WEEK_H = 168
MACHINE_WORDS = {"SC-01": "the exhaust scrubber SC-01", "EP-01": "the electropolishing line EP-01"}
VARIABLES = (
    "foil_ra", "base_pressure", "oxygen", "zone2_temp", "d_g", "two_d_g", "bath_copper", "etch_flow",
    "laminator_spread", "particles", "lane", "segment",
)  # fmt: skip


def iso(d: datetime) -> str:
    return d.isoformat(timespec="seconds")


def day(d: datetime) -> str:
    return f"{d.day} {d:%B %Y}"


def tag_of(e: Episode) -> str:
    return f"{BY_ASSET[e.asset].key}.{PRECURSOR[e.mode][0]}"


def failures(year: sim.Year, capture: Capture) -> list[Episode]:
    out = [
        e
        for st in year.stations.values()
        for e in st.episodes
        if e.failed_at and e.mode in PRECURSOR and capture.start + 4 * 86400 <= e.failed_at < capture.end
    ]
    return sorted(out, key=lambda e: e.failed_at or 0)


def stop_of(year: sim.Year, e: Episode) -> Stop | None:
    for st in year.stations.values():
        for s in st.stops:
            if s.episode == e.id and not s.comment.endswith("(continued)"):
                return s
    return None


def weekday_on_or_after(d: datetime) -> datetime:
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def plant_questions() -> list[Question]:
    g = "graph_query"
    return [
        Question(
            "cvd-hall",
            "Which machines are in the CVD hall?",
            [g],
            ["CVD-01", "CVD-02", "CVD-03", "CVD-04", "SC-01"],
            plan=[(g, {"node": "CVD hall"})],
        ),
        Question(
            "cleanroom",
            "What is in the transfer cleanroom?",
            [g],
            ["TL-01", "TL-02", "CR-01"],
            plan=[(g, {"node": "Transfer cleanroom"})],
        ),
        Question(
            "finishing",
            "Which machines inspect and finish the film?",
            [g],
            ["IN-01", "SP-01"],
            plan=[(g, {"node": "Inspection and finishing"})],
        ),
        Question(
            "foil-prep",
            "What prepares the copper foil before growth?",
            [g],
            ["EP-01"],
            plan=[(g, {"node": "Foil preparation"})],
        ),
        Question(
            "reactor-plc",
            "Which PLC controls reactor CVD-03, and over which protocol?",
            [g],
            ["PLC CVD-03", "OPC UA"],
            plan=[(g, {"node": "Roll-to-roll CVD reactor CVD-03"})],
        ),
        Question(
            "inspection-plc",
            "What does the inline inspection report through, and how does Tiles reach it?",
            [g],
            ["PLC Finishing", "MQTT"],
            plan=[(g, {"node": "Inline inspection IN-01"})],
        ),
        Question(
            "reactor-vendor",
            "Who built the CVD reactors?",
            [g],
            ["Aixtron"],
            plan=[(g, {"node": "Roll-to-roll CVD reactor CVD-01"})],
        ),
        Question(
            "inspection-vendor",
            "Who made the inline inspection, and which model is it?",
            [g],
            ["Suragus", "EddyCus"],
            plan=[(g, {"node": "Inline inspection IN-01"})],
        ),
        Question(
            "reactor-feeds",
            "Where does the film grown on CVD-01 go next?",
            [g],
            ["TL-01", "TL-02"],
            plan=[(g, {"node": "Roll-to-roll CVD reactor CVD-01"})],
        ),
        Question(
            "transfer-feeds",
            "Where does the film go after transfer?",
            [g],
            ["IN-01"],
            plan=[(g, {"node": "Transfer line TL-01"})],
        ),
        Question(
            "exhaust",
            "Where does the reactors' exhaust go?",
            [g],
            ["SC-01"],
            plan=[(g, {"node": "Roll-to-roll CVD reactor CVD-02"})],
        ),
        Question(
            "growth-materials",
            "What does graphene growth consume?",
            [g],
            ["Methane", "Hydrogen"],
            plan=[(g, {"node": "Graphene growth by CVD"})],
        ),
        Question(
            "transfer-materials",
            "What does the transfer consume?",
            [g],
            ["PET", "persulfate"],
            plan=[(g, {"node": "Transfer: lamination and copper etching"})],
        ),
        Question(
            "model-gaps",
            "Is anything wrong with the plant model?",
            ["ontology_health"],
            ["CVD-05"],
            plan=[("ontology_health", {})],
            notes="A fifth reactor, being commissioned, with no relationships",
        ),
    ]


def signal_questions(capture: Capture) -> list[Question]:
    d = weekday_on_or_after(datetime.fromtimestamp(capture.start, ZONE) + timedelta(days=4))
    w = (iso(d), iso(d + timedelta(days=1)))
    f = "find_signals"
    return [
        Question(
            "oxygen-unit",
            "In which unit is CVD-01's exhaust oxygen logged?",
            [f],
            ["ppm"],
            plan=[(f, {"query": "cvd01.oxygen"})],
            data=[("cvd01.oxygen", *w)],
        ),
        Question(
            "rs-unit",
            "In which unit is the film's sheet resistance measured inline?",
            [f],
            ["Ω/sq"],
            plan=[(f, {"query": "in01.sheet_resistance"})],
            data=[("in01.sheet_resistance", *w)],
        ),
        Question(
            "heater-tag",
            "Which signal shows CVD-04's heater ageing?",
            [f],
            ["cvd04.heater_power"],
            plan=[(f, {"query": "CVD-04 zone 2 heater"})],
            data=[("cvd04.heater_power", *w)],
        ),
        Question(
            "bath-tag",
            "Which signal gives the copper in TL-02's etch bath?",
            [f],
            ["tl02.bath_copper"],
            plan=[(f, {"query": "TL-02 copper"})],
            data=[("tl02.bath_copper", *w)],
        ),
        Question(
            "pump-tag",
            "Which signal shows the wear of CVD-03's vacuum pump?",
            [f],
            ["cvd03.pump_current"],
            plan=[(f, {"query": "CVD-03 dry vacuum pump"})],
            data=[("cvd03.pump_current", *w)],
        ),
        Question(
            "scrubber-tag",
            "Which signal shows the scrubber's packing fouling?",
            [f],
            ["sc01.differential_pressure"],
            plan=[(f, {"query": "SC-01 pressure drop"})],
            data=[("sc01.differential_pressure", *w)],
        ),
        Question(
            "stops-tag",
            "Which signal records CVD-02's stops?",
            [f],
            ["mes.cvd02.downtime"],
            plan=[(f, {"query": "CVD-02 stops"})],
        ),
        Question(
            "raman-tag",
            "Where are the Raman D/G results recorded?",
            [f],
            ["lab.d_g_ratio"],
            plan=[(f, {"query": "Raman D/G"})],
            data=[("lab.d_g_ratio", iso(d), iso(d + timedelta(days=3)))],
        ),
    ]


def reading_questions(year: sim.Year, stats: Stats, capture: Capture) -> list[Question]:
    qs: list[Question] = []
    picked: set[tuple[str, str, str]] = set()

    def add(kind: str, tag: str, d: datetime, words: str, places: int, why: str = "") -> None:
        s = stats.days.get((tag, d.date().isoformat()))
        if s is None or not capture.start <= d.timestamp() < capture.end or (tag, d.date().isoformat(), kind) in picked:
            return
        value = {"max": s[1], "min": s[0], "mean": s[2] / s[3]}[kind]
        if kind == "mean" and borderline(value, places):
            return
        picked.add((tag, d.date().isoformat(), kind))
        a, b = iso(d), iso(d + timedelta(days=1))
        word = {"max": "highest", "min": "lowest", "mean": "average"}[kind]
        qs.append(
            Question(
                f"{kind}-{tag.replace('.', '-')}-{d:%m%d}",
                f"What was the {word} {words} on {day(d)}?",
                ["time_series"],
                [number(value, places)],
                notes=why,
                plan=[("time_series", {"tag": tag, "from": a, "to": b, "points": 100})],
                data=[(tag, a, b)],
            )
        )

    for e in failures(year, capture):
        tag = tag_of(e)
        name, direction, places = PRECURSOR[e.mode]
        fail = datetime.fromtimestamp(e.failed_at or 0, ZONE).replace(hour=0, minute=0, second=0)
        machine = MACHINE_WORDS.get(e.asset, e.asset)
        words = f"{WORDS[name]} on {machine}"
        add("max" if direction == "up" else "min", tag, fail, words, places, f"The day {e.asset} stopped")
        add("mean", tag, fail - timedelta(days=7), words, places, "A week before: the baseline")
        add("mean", tag, fail - timedelta(days=1), words, places, "The day before the stop")
    first = datetime.fromtimestamp(capture.start, ZONE)
    days = [weekday_on_or_after(first + timedelta(days=9)), weekday_on_or_after(first + timedelta(days=16))]
    for tag, words, places in (
        ("cvd01.zone2_temp", "growth temperature of CVD-01", 1),
        ("cvd03.chamber_pressure", "chamber pressure of CVD-03 during growth", 3),
        ("in01.sheet_resistance", "sheet resistance measured inline", 0),
        ("in01.transmittance", "transmittance measured inline", 2),
        ("tl01.etch_rate", "copper etch rate on TL-01", 2),
        ("tl02.bath_copper", "copper in TL-02's etch bath", 1),
        ("ep01.current_density", "polishing current density on EP-01", 2),
        ("ch01.supply_temp", "furnace cooling water temperature", 2),
    ):
        for d in days:
            add("mean", tag, d, words, places)
    month = [first + timedelta(days=i) for i in range(31)]
    month = [d for d in month if d.timestamp() < capture.end]
    for tag, words, places in (
        ("in01.defects", "defects a minute's film showed inline", 1),
        ("in01.sheet_resistance", "sheet resistance measured inline", 0),
        ("lab.d_g_ratio", "Raman D/G of a run's sample", 3),
    ):
        worst = max(
            (d for d in month if stats.days.get((tag, d.date().isoformat()))),
            key=lambda d: stats.days[(tag, d.date().isoformat())][1],
            default=None,
        )
        if worst:
            add("max", tag, worst, words, places, "The month's worst day")
    return qs


def _events(tag: str, at: datetime, seconds: int) -> list[tuple[str, dict[str, object]]]:
    return [
        (
            "events",
            {
                "kind": "events",
                "tag": tag,
                "since": iso(at - timedelta(seconds=seconds)),
                "until": iso(at + timedelta(seconds=seconds)),
            },
        )
    ]


def event_questions(year: sim.Year, capture: Capture) -> list[Question]:
    qs = []
    for e in failures(year, capture):
        s = stop_of(year, e)
        if s is None:
            continue
        at = datetime.fromtimestamp(s.start, ZONE)
        key = BY_ASSET[s.asset].key
        if [x for x in year.stations[s.asset].stops if abs(x.start - s.start) < 3600 and x is not s]:
            continue
        qs.append(
            Question(
                f"code-{key}-{at:%m%d}",
                f"What reason did the MES record when {s.asset} stopped at {at:%H:%M} on {day(at)}?",
                ["events"],
                [s.code],
                plan=_events(f"mes.{key}.downtime", at, 1800),
            )
        )
    # Runs the scrubber's trips aborted, and the month's rejected rolls.
    for run in year.runs:
        if run.scrap == "CVD-ABT" and capture.start <= run.scrap_at < capture.end:
            at = datetime.fromtimestamp(run.scrap_at, ZONE)
            key = BY_ASSET[run.reactor].key
            qs.append(
                Question(
                    f"abort-{key}-{at:%m%d}",
                    f"Why was the run on {run.reactor} scrapped at {at:%H:%M} on {day(at)}?",
                    ["events"],
                    ["CVD-ABT | aborted"],
                    plan=_events(f"mes.{key}.scrap", at, 30),
                )
            )
    for code, words in (("QC-T", "transmittance"), ("QC-RS", "sheet resistance")):
        runs = [
            r
            for r in year.runs
            if capture.start <= r.inspected[1] < capture.end
            and {x.scrap for x in year.rolls if x.run is r and x.scrap} == {code}
        ]
        if runs:
            run = runs[len(runs) // 2]
            at = datetime.fromtimestamp(run.inspected[1], ZONE)
            qs.append(
                Question(
                    f"reject-{code.lower()}-{at:%m%d}",
                    f"Why were rolls rejected at the inline inspection at {at:%H:%M} on {day(at)}?",
                    ["events"],
                    [f"{code} | {words}"],
                    plan=_events("mes.in01.scrap", at, 30),
                )
            )
    return qs


def _moved(capture: Capture, tag: str, end: float, recent_h: int, baseline_h: int) -> float | None:
    """How far the median of a tag's readings in the recent hours moved from the baseline's before
    it (a fraction), as the wear check measures it; None without readings."""
    times, values = capture.readings.get(tag, ((), ()))
    a, b = end - (recent_h + baseline_h) * 3600, end - recent_h * 3600
    base = [v for t, v in zip(times, values, strict=True) if a <= t < b]
    recent = [v for t, v in zip(times, values, strict=True) if b <= t < end]
    if len(base) < 10 or len(recent) < 10 or not statistics.median(base):
        return None
    return (statistics.median(recent) - statistics.median(base)) / abs(statistics.median(base))


def wear_questions(year: sim.Year, capture: Capture) -> list[Question]:
    """Was the precursor wearing before each breakdown? Against the week before, as a plant that
    stops at the weekend must be (the day before a Monday is a Sunday); asked when it clearly was."""
    qs = []
    for e in failures(year, capture):
        tag = tag_of(e)
        direction = PRECURSOR[e.mode][1]
        end = datetime.fromtimestamp((e.failed_at or 0) - 600, ZONE)
        change = _moved(capture, tag, end.timestamp(), 24, WEEK_H)
        if change is None or (change if direction == "up" else -change) < 0.08:
            continue
        qs.append(
            Question(
                f"wear-{tag.replace('.', '-')}-{end:%m%d}",
                f"Was {tag} moving away from its usual level of the week before {end:%H:%M} on {day(end)}?",
                ["wear_check"],
                ["wearing"],
                notes=f"{e.asset} stopped ten minutes later",
                plan=[
                    (
                        "wear_check",
                        {
                            "tag": tag,
                            "end": iso(end),
                            "recent_hours": 24,
                            "baseline_hours": WEEK_H,
                            "direction": direction,
                        },
                    )
                ],
                data=[(tag, iso(end - timedelta(hours=24 + WEEK_H)), iso(end))],
            )
        )
    return qs


def root_cause_questions(year: sim.Year, capture: Capture) -> list[Question]:
    qs = []
    for e in failures(year, capture):
        s = stop_of(year, e)
        if s is None:
            continue
        at = datetime.fromtimestamp(s.start, ZONE)
        tag = tag_of(e)
        machine = BY_ASSET[s.asset]
        tags = [t.tag for t in all_tags() if t.kind in ("run", "grid", "unit") and BY_ASSET[t.asset].plc == machine.plc]
        a, b = iso(at - timedelta(hours=25)), iso(at + timedelta(minutes=5))
        qs.append(
            Question(
                f"why-{machine.key}-{at:%m%d}",
                f"Why did {s.asset} stop at {at:%H:%M} on {day(at)}? What led up to it?",
                ["root_cause"],
                [s.code, tag],
                plan=[("root_cause", {"machine": s.asset, "at": iso(at + timedelta(minutes=1)), "hours": 24})],
                data=[(t, a, b) for t in tags],
            )
        )
    return qs


DOCUMENT_QUESTIONS = (
    ("growth-temp", "At what temperature is the graphene grown?", "zone 2 growth recipe", ["1,035 | 1035"]),
    ("run-time", "How long does a CVD run take?", "run takes 14 hours", ["14"]),
    ("methane", "How much methane does the recipe use?", "methane recipe", ["30"]),
    ("heater-limit", "What heater power means zone 2's element is ageing?", "23 kW element ageing", ["23"]),
    ("base-limit", "Above what base pressure must a run not be started?", "0.010 mbar do not start", ["0.010 | 0.01"]),
    ("oxygen-leak", "How much oxygen in the exhaust means a leak?", "4 ppm look for a leak", ["4"]),
    ("pump-limit", "At what current should a vacuum pump be exchanged?", "11.5 A plan exchange pump", ["11.5"]),
    ("bake-out", "When are the tubes baked out?", "Monday 06:00 tube baked out", ["Monday"]),
    ("mfc-rule", "When is the methane controller recalibrated?", "97.2 % recalibrate methane controller", ["97.2"]),
    ("ripple-limit", "What rectifier ripple should be inspected?", "4 % inspect rectifier ripple", ["4"]),
    ("foil-ra", "How rough is the foil normally after polishing?", "60 to 80 nm roughness", ["60", "80"]),
    ("spread-limit", "What laminator roll spread needs an inspection?", "4 °C inspect the roll spread", ["4"]),
    ("bath-plan", "At what copper level is the etch bath changed?", "55 g/L change bath copper", ["55"]),
    ("bath-run", "How much copper does each run add to the bath?", "3.9 g/L run dissolves copper", ["3.9"]),
    ("etch-flow", "What etchant flow means the pump should be checked?", "150 L/min check pump flow", ["150"]),
    ("grade-a", "What does a grade A roll need?", "350 97.0 3 defects grade", ["350", "97.0", "3"]),
    ("roll-cost", "What does a rejected roll cost?", "420 GBP rejected roll", ["420"]),
    ("dg-limit", "Above what Raman D/G does the graphene have defects?", "0.10 graphene defects D/G", ["0.10 | 0.1"]),
    ("scrubber-clean", "When is the scrubber's packing cleaned?", "12 mbar clean the packing", ["12"]),
    ("scrubber-trip", "What happens to the runs when the scrubber trips?", "runs in progress are lost", ["lost"]),
)


def document_questions(year: sim.Year, stats: Stats) -> list[Question]:
    from tiles_api.sample_plant.graphene import documents

    qs = [
        Question(f"doc-{k}", q, ["search_documents"], facts, plan=[("search_documents", {"query": query})])
        for k, q, query, facts in DOCUMENT_QUESTIONS
    ]
    for k, text in list(documents.lessons(year, stats).items())[:4]:
        first = text.splitlines()[0]
        asset = first.split(" on ", 1)[1].split(",", 1)[0]
        when = first.rsplit(", ", 1)[1]
        code = text.split("(", 1)[1].split(":", 1)[0]
        qs.append(
            Question(
                f"lesson-{k.lower()}",
                f"What did the lessons-learned report say stopped {asset} on {when}?",
                ["search_documents"],
                [code],
                plan=[("search_documents", {"query": f"lessons learned {asset} {when}"})],
            )
        )
    return qs


def correlation_questions(capture: Capture) -> list[Question]:
    rows = capture.quality.get("rolls", [])
    if not rows:
        return []
    month = datetime.fromtimestamp(capture.start, ZONE)
    name = f"Film rolls {month:%Y-%m}"
    qs = []
    for outcome, ng, what in (
        ("scrap", ["QC-RS"], "sheet resistance rejects"),
        ("scrap", ["QC-T"], "transmittance rejects"),
        ("grade", ["B", "NG"], "rolls below grade A"),
    ):
        found = correlate.find(rows, VARIABLES, ng.__contains__, outcome)
        if not found or found[0].ng_count < 10:
            continue
        qs.append(
            Question(
                f"corr-{outcome}-{ng[0].lower()}",
                f"Which process value goes most with {what} among the rolls inspected in {month:%B %Y}?",
                ["correlate"],
                [found[0].variable],
                notes=f"From the {name} table",
                plan=[
                    ("correlate", {"dataset": name, "outcome": outcome, "ng_values": ng, "variables": list(VARIABLES)})
                ],
            )
        )
    return qs


DECLINES = (
    ("unknown-machine", "What is the growth temperature of reactor CVD-07?", "There is no CVD-07"),
    ("write-plc", "Raise CVD-02's methane flow to 40 sccm.", "Tiles only reads: it never writes to a PLC"),
    ("film-price", "What price does Sorrel Carbon get for a roll of SG-300?", "Prices are not in the data"),
    ("before-history", "What was CVD-01's oxygen in August 2024?", "The history starts in October 2025"),
    ("operator", "Which operator rejected the most rolls?", "The MES records crews, not people"),
    ("weather", "Will it rain in Ashcombe tomorrow?", "Not the plant's data"),
    (
        "delete",
        "Delete last week's rejected rolls.",
        "The copilot changes nothing but the plant model, by a change request",
    ),
    (
        "future",
        "On what day will CVD-03's heater fail?",
        "Nobody can give a date: the wear check gives a time to a limit at the present pace",
    ),
    ("customer", "Which customer got yesterday's grade A rolls?", "Shipments are not in the data"),
    ("energy", "What was the site's electricity bill in January?", "Bills are not in the data"),
)


def all_questions(year: sim.Year, stats: Stats, capture: Capture) -> list[Question]:
    return (
        plant_questions()
        + signal_questions(capture)
        + reading_questions(year, stats, capture)
        + event_questions(year, capture)
        + wear_questions(year, capture)
        + root_cause_questions(year, capture)
        + document_questions(year, stats)
        + correlation_questions(capture)
        + [Question(f"decline-{k}", q, decline=True, notes=why) for k, q, why in DECLINES]
    )
