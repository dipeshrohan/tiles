"""The copilot's question set for the sample plant (T4.05's form: docs/pilot/copilot-questions.md):
questions a plant's people ask, each with the facts its answer must state, worked out from the year
itself, and the tools that answer it.

Two more columns, which `tiles-evaluate` ignores, make the set checkable: `plan`, the tool calls
that answer the question (JSON), and `data`, the readings those calls read (`tag@from/to`, a `;`
between them). The sample plant's test loads that data and asks each question of an oracle that
calls the plan, so every fact is proved to be in what the tools give. Readings questions are about
May 2026 (`QUESTION_MONTH`), the month with most breakdowns on Line 2.
"""

import json
import math
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

from tiles_api import correlate
from tiles_api.sample_plant import simulate as sim
from tiles_api.sample_plant.plant import CELLS, PILOT, ZONE, Cell

if TYPE_CHECKING:
    from tiles_api.sample_plant.generate import Year

VARIABLES = (
    "cycle_time",
    "shot_speed_1st",
    "shot_speed_2nd",
    "fill_time",
    "intensification_pressure",
    "pressure_buildup_time",
    "biscuit_length",
    "vacuum_level",
    "die_temp_fixed",
    "die_temp_moving",
    "plunger_pressure_1st",
    "spray_pressure",
    "bath_temp",
    "hydrogen",
)
PRECURSOR = {
    "plunger": ("plunger_pressure_1st", "up"),
    "accumulator": ("pressure_buildup_time", "up"),
    "cooling": ("cooling_flow_moving", "down"),
    "spray": ("spray_pressure", "down"),
    "furnace": ("heater_power", "up"),
    "oil": ("hydraulic_oil_temp", "up"),
}


@dataclass
class Question:
    id: str
    question: str
    tools: list[str] = field(default_factory=list)
    facts: list[str] = field(default_factory=list)  # a fact's alternatives joined by " | "
    absent: list[str] = field(default_factory=list)
    decline: bool = False
    notes: str = ""
    plan: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    data: list[tuple[str, str, str]] = field(default_factory=list)  # (tag, from, to)


def iso(d: datetime) -> str:
    return d.isoformat(timespec="seconds")


def day(d: datetime) -> str:
    return f"{d.day} {d:%B %Y}"


def number(v: float, places: int) -> str:
    """As the grounding check reads it: rounded half up, without a trailing .0."""
    text = f"{math.floor(v * 10.0**places + 0.5) / 10.0**places:.{places}f}"
    return text[:-2] if text.endswith(".0") else text


def borderline(v: float, places: int) -> bool:
    """Too near a rounding boundary to be stated safely (the API sums in another order)."""
    x = v * 10.0**places
    return abs(x - math.floor(x) - 0.5) < 0.01


def stat(year: "Year", tag: str, d: datetime) -> list[float] | None:
    return year.stats.days.get((tag, d.date().isoformat()))


def days_of_month(year: "Year") -> Iterator[datetime]:
    d = datetime.fromtimestamp(year.capture.start, ZONE)
    while d.timestamp() < year.capture.end:
        yield d
        d += timedelta(days=1)


def failures(year: "Year") -> list[sim.Episode]:
    """Line 2's breakdowns in the question month, in order."""
    out = [
        e
        for c in PILOT
        for e in year.cells[c.asset].episodes
        if e.failed_at and year.capture.start + 4 * 86400 <= e.failed_at < year.capture.end and e.mode in PRECURSOR
    ]
    return sorted(out, key=lambda e: e.failed_at or 0)


def cell_of(asset: str) -> Cell:
    return next(c for c in CELLS if c.asset == asset)


def plant_questions() -> list[Question]:
    qs = []
    for c in PILOT:
        n = f"{c.number:02d}"
        qs.append(
            Question(
                f"cell-{c.key}",
                f"What equipment is in Cell {c.asset}?",
                ["graph_query"],
                [c.asset, f"HF-{n}", f"SR-{n}", f"ER-{n}", f"TP-{n}", f"VU-{n}"],
                plan=[("graph_query", {"node": f"Cell {c.asset}"})],
            )
        )
    for c in CELLS:
        qs.append(
            Question(
                f"plc-{c.key}",
                f"Which PLC controls {c.asset}, and which protocol does it speak?",
                ["graph_query"],
                [f"PLC {c.asset}", c.protocol],
                plan=[("graph_query", {"node": f"{c.asset} die-casting machine"})],
            )
        )
    qs += [
        Question(
            "feeds-dc03",
            "Which holding furnace feeds DC-03?",
            ["graph_query"],
            ["HF-03"],
            plan=[("graph_query", {"node": "DC-03 die-casting machine"})],
        ),
        Question(
            "maker-dc04",
            "Who built DC-04, and in which year?",
            ["graph_query"],
            ["Idra", "2017"],
            plan=[("graph_query", {"node": "DC-04 die-casting machine"})],
        ),
        Question(
            "products-dc04",
            "Which products does DC-04 cast?",
            ["graph_query"],
            ["EM-220", "CV-90"],
            plan=[("graph_query", {"node": "DC-04 die-casting machine"})],
        ),
        Question(
            "force-dc03",
            "What is the locking force of DC-03?",
            ["graph_query"],
            ["16000 | 16,000"],
            plan=[("graph_query", {"node": "DC-03 die-casting machine"})],
        ),
        Question(
            "machining-line",
            "Which machines are on the machining line?",
            ["graph_query"],
            ["CNC-01", "CNC-02", "CNC-03", "CNC-04", "WS-01", "LT-01"],
            plan=[("graph_query", {"node": "Machining line"})],
        ),
        Question(
            "line1-melt",
            "Which melting furnace supplies Line 1's holding furnaces?",
            ["graph_query"],
            ["MF-02"],
            plan=[("graph_query", {"node": "Holding furnace HF-05"})],
        ),
        Question(
            "hpdc-alloys",
            "Which alloys does high-pressure die casting use at Kesselbach?",
            ["graph_query"],
            ["AlSi9Cu3", "AlSi10MnMg"],
            plan=[("graph_query", {"node": "High-pressure die casting"})],
        ),
        Question(
            "virtual-sensor",
            "What does the plunger friction virtual sensor read, and which machine does it watch?",
            ["graph_query"],
            ["velocity", "metal pressure", "DC-01"],
            plan=[("graph_query", {"node": "Plunger friction virtual sensor"})],
        ),
        Question(
            "model-gaps",
            "Is anything wrong with the plant model?",
            ["ontology_health"],
            ["CP-02", "SC-01"],
            plan=[("ontology_health", {})],
            notes="Two known gaps: a spare compressor with no relationships, a conveyor with no vendor",
        ),
    ]
    return qs


def signal_questions(year: "Year") -> list[Question]:
    any_day = datetime.fromtimestamp(year.capture.start, ZONE) + timedelta(days=4)
    window = (iso(any_day), iso(any_day + timedelta(hours=6)))
    qs = []
    for c in PILOT[:2]:
        tag = f"{c.key}.plunger_pressure_1st"
        qs.append(
            Question(
                f"friction-tag-{c.key}",
                f"Which signal shows the friction on {c.asset}'s plunger?",
                ["find_signals"],
                [tag],
                plan=[("find_signals", {"query": f"friction {c.asset}"})],
                data=[(tag, *window)],
            )
        )
    qs += [
        Question(
            "vacuum-unit",
            "In which unit is DC-03's cavity vacuum logged?",
            ["find_signals"],
            ["mbar"],
            plan=[("find_signals", {"query": "dc03.vacuum_level"})],
            data=[("dc03.vacuum_level", *window)],
        ),
        Question(
            "hydrogen-unit",
            "What does the lab.hydrogen signal measure, and in which unit?",
            ["find_signals"],
            ["hydrogen", "ml/100g"],
            plan=[("find_signals", {"query": "lab.hydrogen"})],
            data=[("lab.hydrogen", iso(any_day), iso(any_day + timedelta(days=1)))],
        ),
        Question(
            "furnace-signals",
            "Which signals does the holding furnace HF-02 have?",
            ["find_signals"],
            ["hf02.bath_temp", "hf02.heater_power"],
            plan=[("find_signals", {"query": "HF-02"})],
            data=[("hf02.bath_temp", *window), ("hf02.heater_power", *window)],
        ),
        Question(
            "buildup-tag",
            "Which signal tells me the accumulator on DC-04 is losing its precharge?",
            ["find_signals"],
            ["dc04.pressure_buildup_time"],
            plan=[("find_signals", {"query": "dc04 build-up"})],
            data=[("dc04.pressure_buildup_time", *window)],
        ),
        Question(
            "stops-tag",
            "Which signal records DC-02's stops?",
            ["find_signals"],
            ["mes.dc02.downtime"],
            plan=[("find_signals", {"query": "DC-02 stops"})],
        ),
        Question(
            "line1-tags",
            "What does the historian log for DC-05?",
            ["find_signals"],
            ["dc05.cycle_time", "dc05.die_temp_fixed"],
            plan=[("find_signals", {"query": "dc05"})],
            data=[("dc05.cycle_time", *window), ("dc05.die_temp_fixed", *window)],
        ),
    ]
    return qs


def reading_questions(year: "Year") -> list[Question]:
    """Daily highs, lows and means of May's readings, on the days that matter."""
    qs: list[Question] = []
    picked: set[tuple[str, str]] = set()

    def add(kind: str, tag: str, d: datetime, words: str, places: int, why: str = "") -> None:
        s = stat(year, tag, d)
        in_month = year.capture.start <= d.timestamp() < year.capture.end  # the readings the test loads
        if s is None or not in_month or ((tag, d.date().isoformat()) in picked and kind == "mean"):
            return
        value = {"max": s[1], "min": s[0], "mean": s[2] / s[3]}[kind]
        if kind == "mean" and borderline(value, places):
            return
        picked.add((tag, d.date().isoformat()))
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

    for e in failures(year):
        cell = cell_of(e.asset)
        fail = datetime.fromtimestamp(e.failed_at or 0, ZONE)
        before = fail.replace(hour=0, minute=0, second=0) - timedelta(days=1)
        week = before - timedelta(days=6)
        name, direction = PRECURSOR[e.mode]
        tag = f"hf{cell.number:02d}.{name}" if name == "heater_power" else f"{cell.key}.{name}"
        words = {
            "plunger_pressure_1st": f"slow-phase plunger pressure on {e.asset}",
            "pressure_buildup_time": f"intensification build-up time on {e.asset}",
            "cooling_flow_moving": f"moving-half cooling flow on {e.asset}",
            "spray_pressure": f"spray manifold pressure on {e.asset}",
            "heater_power": f"heater power of HF-{cell.number:02d}",
            "hydraulic_oil_temp": f"hydraulic oil temperature on {e.asset}",
        }[name]
        extreme = "max" if direction == "up" else "min"
        add(
            extreme,
            tag,
            before,
            words,
            2 if name in ("spray_pressure", "plunger_pressure_1st") else 1,
            f"The day before {e.asset}'s {sim.MODES[e.mode].code} stop",
        )
        add(
            "mean",
            tag,
            week,
            words,
            2 if name in ("spray_pressure", "plunger_pressure_1st") else 1,
            "A week before: the baseline",
        )
        add(
            "mean",
            tag,
            before,
            words,
            2 if name in ("spray_pressure", "plunger_pressure_1st") else 1,
            f"The day before {e.asset}'s stop",
        )
    month = list(days_of_month(year))
    for c in PILOT:
        vac = f"{c.key}.vacuum_level"
        worst = max((d for d in month if stat(year, vac, d)), key=lambda d: (stat(year, vac, d) or [0, 0])[1])
        add("max", vac, worst, f"cavity vacuum on {c.asset}", 0, "The month's worst vacuum: a clogging filter")
        die = f"{c.key}.die_temp_moving"
        add("mean", die, month[12], f"moving die half temperature on {c.asset}", 1)
        oil = f"{c.key}.hydraulic_oil_temp"
        hot = max((d for d in month if stat(year, oil, d)), key=lambda d: (stat(year, oil, d) or [0, 0])[1])
        add("max", oil, hot, f"hydraulic oil temperature on {c.asset}", 1)
        bath = f"hf{c.number:02d}.bath_temp"
        add("mean", bath, month[19], f"bath temperature in HF-{c.number:02d}", 1)
    add(
        "mean",
        "dc04.intensification_pressure",
        month[12],
        "intensification pressure on DC-04",
        1,
        "In the week the PLC logged MPa, not bar: a tenth of the usual",
    )
    add(
        "mean",
        "dc04.intensification_pressure",
        month[20],
        "intensification pressure on DC-04",
        1,
        "After the week in MPa",
    )
    add("max", "hall.ambient_temp", month[27], "air temperature in the die-casting hall", 1)
    add("mean", "ct01.supply_temp", month[27], "cooling water supply temperature", 1)
    add("mean", "dc05.cycle_time", month[5], "cycle time of DC-05", 1)
    add("min", "cp01.header_pressure", month[8], "compressed air pressure", 2)
    # The month's hydrogen: one question over the whole month.
    a, b = iso(month[0]), iso(month[-1] + timedelta(days=1))
    values = year.capture.readings.get("lab.hydrogen")
    if values:
        qs.append(
            Question(
                "max-hydrogen-month",
                "What was the highest hydrogen the lab measured in May 2026?",
                ["time_series"],
                [number(max(values[1]), 3)],
                plan=[("time_series", {"tag": "lab.hydrogen", "from": a, "to": b, "points": 200})],
                data=[("lab.hydrogen", a, b)],
            )
        )
    return qs


def event_questions(year: "Year") -> list[Question]:
    qs = []
    for e in failures(year):
        cell = cell_of(e.asset)
        stop = next(s for s in year.cells[e.asset].stops if s.episode == e.id)
        at = datetime.fromtimestamp(stop.start, ZONE)
        code = sim.MODES[e.mode].code
        others = [s for s in year.cells[e.asset].stops if abs(s.start - stop.start) < 3600 and s is not stop]
        if others:
            continue
        qs.append(
            Question(
                f"code-{cell.key}-{at:%m%d}",
                f"What reason did the MES record when {e.asset} stopped at {at:%H:%M} on {day(at)}?",
                ["events"],
                [code],
                plan=[
                    (
                        "events",
                        {
                            "kind": "events",
                            "tag": f"mes.{cell.key}.downtime",
                            "since": iso(at - timedelta(minutes=30)),
                            "until": iso(at + timedelta(minutes=30)),
                        },
                    )
                ],
            )
        )
    # The first scrap after a weekend is warm-up scrap.
    for c in PILOT[:3]:
        for d in days_of_month(year):
            if d.weekday() != 6 or d.day < 8:
                continue
            start = d.replace(hour=21)
            first = [s for s in year.cells[c.asset].scrap if start.timestamp() <= s[0] < start.timestamp() + 3 * 3600]
            if first and all(s[2] == "WU" for s in first[:5]):
                qs.append(
                    Question(
                        f"weekend-scrap-{c.key}-{d:%m%d}",
                        f"Why were {c.asset}'s first parts scrapped on the night of {day(d)}?",
                        ["events"],
                        ["WU | warm-up"],
                        plan=[
                            (
                                "events",
                                {
                                    "kind": "events",
                                    "tag": f"mes.{c.key}.scrap",
                                    "since": iso(start),
                                    "until": iso(start + timedelta(hours=3)),
                                    "limit": 20,
                                },
                            )
                        ],
                    )
                )
                break
    # Quality holds in the month.
    for c in PILOT:
        holds = [
            s
            for s in year.cells[c.asset].stops
            if s.code == "DT-QH" and year.capture.start <= s.start < year.capture.end
        ]
        if holds:
            at = datetime.fromtimestamp(holds[0].start, ZONE)
            qs.append(
                Question(
                    f"hold-{c.key}-{at:%m%d}",
                    f"Why did {c.asset} stop at {at:%H:%M} on {day(at)}?",
                    ["events"],
                    ["DT-QH | quality hold"],
                    plan=[
                        (
                            "events",
                            {
                                "kind": "events",
                                "tag": f"mes.{c.key}.downtime",
                                "since": iso(at - timedelta(minutes=10)),
                                "until": iso(at + timedelta(minutes=10)),
                            },
                        )
                    ],
                )
            )
    return qs


def wear_questions(year: "Year") -> list[Question]:
    qs = []
    for e in failures(year):
        cell = cell_of(e.asset)
        name, direction = PRECURSOR[e.mode]
        tag = f"hf{cell.number:02d}.{name}" if name == "heater_power" else f"{cell.key}.{name}"
        end = datetime.fromtimestamp((e.failed_at or 0) - 600, ZONE)
        a = iso(end - timedelta(hours=96))
        qs.append(
            Question(
                f"wear-{tag.replace('.', '-')}-{end:%m%d}",
                f"Was {tag} moving away from its usual level in the day before {end:%H:%M} on {day(end)}?",
                ["wear_check"],
                ["wearing"],
                notes=f"{e.asset} stopped ten minutes later ({sim.MODES[e.mode].code})",
                plan=[
                    (
                        "wear_check",
                        {"tag": tag, "end": iso(end), "recent_hours": 24, "baseline_hours": 72, "direction": direction},
                    )
                ],
                data=[(tag, a, iso(end))],
            )
        )
    return qs


def root_cause_questions(year: "Year") -> list[Question]:
    qs = []
    for e in failures(year):
        cell = cell_of(e.asset)
        stop = next(s for s in year.cells[e.asset].stops if s.episode == e.id)
        at = datetime.fromtimestamp(stop.start, ZONE)
        name, _ = PRECURSOR[e.mode]
        tags = [
            f"{cell.key}.{t}"
            for t in (
                "plunger_pressure_1st",
                "pressure_buildup_time",
                "spray_pressure",
                "vacuum_level",
                "die_temp_moving",
                "cooling_flow_moving",
                "intensification_pressure",
            )
        ]
        tags += [f"hf{cell.number:02d}.heater_power", f"hf{cell.number:02d}.bath_temp"]
        a, b = iso(at - timedelta(hours=25)), iso(at + timedelta(minutes=5))
        lead = f"hf{cell.number:02d}.{name}" if name == "heater_power" else f"{cell.key}.{name}"
        qs.append(
            Question(
                f"why-{cell.key}-{at:%m%d}",
                f"Why did {e.asset} stop at {at:%H:%M} on {day(at)}? What led up to it?",
                ["root_cause"],
                [sim.MODES[e.mode].code, lead],
                plan=[("root_cause", {"machine": e.asset, "at": iso(at + timedelta(minutes=1)), "hours": 24})],
                data=[(t, a, b) for t in tags],
            )
        )
    return qs


DOCUMENT_QUESTIONS = (
    ("tip-interval", "How often is the plunger tip changed?", "plunger tip changed every shots", ["20,000 | 20000"]),
    ("tip-new", "What does the slow-phase pressure read with a new plunger tip?", "new tip slow phase reads", ["15"]),
    (
        "tip-change-now",
        "Above what slow-phase pressure must the plunger tip be changed at once?",
        "tip seizes within hours",
        ["30"],
    ),
    ("tip-limit", "What is the plunger's wear limit?", "wear limit plunger", ["36"]),
    ("sleeve-cost", "What does a shot sleeve cost?", "shot sleeve costs", ["6,800 | 6800"]),
    (
        "warmup-weekend",
        "How many warm-up shots are scrapped after a weekend?",
        "warm-up shots weekend",
        ["twelve | 12"],
    ),
    (
        "warmup-rule",
        "How many warm-up shots should be scrapped after a stop of more than 30 minutes?",
        "warm-up shots scrap",
        ["three | 3", "two | 2"],
    ),
    (
        "accumulator-start",
        "What accumulator pressure must a cell have before the first shot?",
        "accumulator pressure first shot",
        ["150", "165"],
    ),
    ("vacuum-test", "What vacuum must the cavity reach in the vacuum test?", "vacuum test cavity", ["80"]),
    ("vacuum-normal", "What is a normal cavity vacuum at the shot?", "cavity vacuum normally", ["45", "55"]),
    ("vacuum-filter", "How often is the vacuum filter changed?", "vacuum filter changed", ["fourth | monthly"]),
    ("hydrogen-target", "How much hydrogen may the melt hold after degassing?", "hydrogen target", ["0.15"]),
    ("hydrogen-again", "At what hydrogen level is a ladle degassed again?", "degas again rotor", ["0.19"]),
    ("oil-trip", "At what oil temperature does a die-casting machine trip?", "oil trips", ["58"]),
    ("precharge", "What is the shot accumulator's nitrogen precharge?", "accumulator nitrogen precharge", ["90"]),
    ("buildup-normal", "What is a normal intensification build-up time?", "build-up time normally", ["22", "27"]),
    ("grade-3", "From what porosity is a part grade 3?", "grade porosity scrap", ["1.1"]),
    (
        "quality-hold",
        "When does quality hold a die-casting cell?",
        "quality holds the cell",
        ["five | 5", "thirty | 30"],
    ),
    ("descale-now", "Below what moving-half cooling flow must the die be descaled at once?", "descale now", ["32"]),
    (
        "spray-clean",
        "What spray manifold pressure means the nozzles are blocking?",
        "spray manifold pressure clean nozzles",
        ["4.6"],
    ),
    (
        "heater-ageing",
        "What heater power suggests a holding furnace's heater element is ageing?",
        "heater element ageing",
        ["58"],
    ),
    (
        "bath-hold",
        "At what temperature is the holding furnace bath kept in production?",
        "bath held production",
        ["690"],
    ),
)


def document_questions(year: "Year") -> list[Question]:
    qs = [
        Question(f"doc-{k}", q, ["search_documents"], facts, plan=[("search_documents", {"query": query})])
        for k, q, query, facts in DOCUMENT_QUESTIONS
    ]
    from tiles_api.sample_plant import documents

    for k, text in list(documents.lessons(year).items())[:4]:
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


def correlation_questions(year: "Year") -> list[Question]:
    qs = []
    month = datetime.fromtimestamp(year.capture.start, ZONE)
    for c in PILOT:
        rows = year.capture.quality.get(c.asset, [])
        if not rows:
            continue
        name = dataset_name(c.asset, month)
        for outcome, ng, what in (("defect", ["POR"], "porosity rejects"), ("result", ["NG"], "scrap")):
            found = correlate.find(rows, VARIABLES, ng.__contains__, outcome)
            if not found or found[0].ng_count < 10:
                continue
            top = found[0].variable
            qs.append(
                Question(
                    f"corr-{outcome}-{c.key}",
                    f"Which process value goes most with {what} on {c.asset} in {month:%B %Y}?",
                    ["correlate"],
                    [top],
                    notes=f"From the {name} table",
                    plan=[
                        (
                            "correlate",
                            {"dataset": name, "outcome": outcome, "ng_values": ng, "variables": list(VARIABLES)},
                        )
                    ],
                )
            )
    return qs


def dataset_name(asset: str, month: datetime) -> str:
    return f"X-ray results {asset} {month:%Y-%m}"


DECLINES = (
    ("unknown-machine", "What is the cycle time of DC-09?", "There is no DC-09"),
    ("write-plc", "Set the second-phase shot speed on DC-01 to 5.2 m/s.", "Tiles only reads: it never writes to a PLC"),
    ("spindle", "What is the spindle speed of CNC-02 right now?", "The machining centres log no signals"),
    ("before-history", "What was DC-02's vacuum level in March 2024?", "The history starts in October 2025"),
    (
        "operator-blame",
        "Which operator caused the most stops on Line 2?",
        "The MES records crews, not who caused a stop",
    ),
    ("weather", "What will the weather be in Kesselbach tomorrow?", "Not the plant's data"),
    (
        "delete-stops",
        "Delete DC-03's stops from last week.",
        "The copilot changes nothing but the plant model, by a change request",
    ),
    ("price", "What does Aldermoor charge its customers for an EM-220 housing?", "Prices are not in the data"),
    (
        "future-failure",
        "On what date will DC-04's next plunger seizure happen?",
        "Nobody can give a date: the wear check gives a time to a limit at the present pace",
    ),
    ("energy", "How many kWh did the melting furnace MF-02 use in May?", "MF-02's energy is not logged"),
)


def all_questions(year: "Year") -> list[Question]:
    qs = (
        plant_questions()
        + signal_questions(year)
        + reading_questions(year)
        + event_questions(year)
        + wear_questions(year)
        + root_cause_questions(year)
        + document_questions(year)
        + correlation_questions(year)
        + [Question(f"decline-{k}", q, decline=True, notes=why) for k, q, why in DECLINES]
    )
    seen: set[str] = set()
    out = []
    for q in qs:
        if q.id not in seen:
            seen.add(q.id)
            out.append(q)
    return out


def write(out: Path, year: "Year") -> dict[str, int]:
    from tiles_api.sample_plant.generate import write_csv

    qs = all_questions(year)
    n = write_csv(
        out / "copilot" / "questions.csv",
        ("id", "question", "tools", "facts", "absent", "decline", "notes", "plan", "data"),
        (
            (
                q.id,
                q.question,
                "; ".join(q.tools),
                "; ".join(q.facts),
                "; ".join(q.absent),
                "yes" if q.decline else "",
                q.notes,
                json.dumps(q.plan, ensure_ascii=False) if q.plan else "",
                "; ".join(f"{t}@{a}/{b}" for t, a, b in q.data),
            )
            for q in qs
        ),
    )
    return {"copilot/questions.csv": n}


__all__ = ["Question", "all_questions", "dataset_name", "write"]
