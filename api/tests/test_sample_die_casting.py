"""The die-casting sample plant (data/sample-plants/die-casting): its files are what the generator
makes, its year behaves like a die-casting plant's, its physics is the plunger model's, and its
copilot questions are answered by the tools from the data, once it is loaded into a site."""

import csv
import io
import json
import math
import statistics
from collections import Counter
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from test_agents import ENG, api, site  # noqa: F401 - api and site are fixtures

from tiles_api import evaluation, grounding, ontology, ontology_io
from tiles_api.assistant import Turn
from tiles_api.evaluation import Case
from tiles_api.models.plunger import PlungerFriction
from tiles_api.sample_plant.die_casting import generate, questions, simulate
from tiles_api.sample_plant.die_casting.plant import PILOT, ZONE
from tiles_api.sample_plant.load import Loader, event_readings, historian_readings

DATA = Path(__file__).resolve().parents[2] / "data" / "sample-plants" / "die-casting"


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, generate.Year]:
    out = tmp_path_factory.mktemp("sample-plant")
    year, _ = generate.build(out, big=False)
    return out, year


def test_the_committed_files_are_what_the_generator_makes(built: tuple[Path, generate.Year]) -> None:
    out, _ = built
    made = sorted(p.relative_to(out) for p in out.rglob("*") if p.is_file() and p.name != "manifest.json")
    kept = sorted(
        p.relative_to(DATA)
        for p in DATA.rglob("*")
        if p.is_file()
        and p.parts[len(DATA.parts)] not in ("generated",)
        and p.name not in ("manifest.json", "README.md")
    )
    assert made == kept, (
        "run `uv run tiles-sample-plant generate die-casting` and commit data/sample-plants/die-casting"
    )
    stale = [str(p) for p in made if (out / p).read_bytes() != (DATA / p).read_bytes()]
    assert stale == [], "run `uv run tiles-sample-plant generate die-casting` and commit data/sample-plants/die-casting"
    new, old = json.loads((out / "manifest.json").read_text()), json.loads((DATA / "manifest.json").read_text())
    assert {k: v for k, v in new.items() if k != "generated"} == {k: v for k, v in old.items() if k != "generated"}


def test_the_year_runs_like_a_die_casting_plant(built: tuple[Path, generate.Year]) -> None:
    _, year = built
    working_h = year.working.cum[-1] / 3600
    assert 6000 < working_h < 6600  # three shifts, five days and some Saturdays, less holidays
    failed_modes: Counter[str] = Counter()
    for c in PILOT:
        r = year.cells[c.asset]
        unplanned = sum(s.end - s.start for s in r.stops if not s.planned) / 3600
        assert 0.03 < unplanned / working_h < 0.10, c.asset  # unplanned downtime
        assert 0.015 < len(r.scrap) / r.parts < 0.045, c.asset  # scrap
        assert {s.code for s in r.stops if s.planned} >= {"PL-PM", "PL-TIP", "PL-DIE"}
        failed_modes.update(e.mode for e in r.episodes if e.failed_at)
        caught = [e for e in r.episodes if e.resolved_at and not e.failed_at]
        assert all(e.outcome for e in caught)
        for e in r.episodes:  # a failure is a stop of its code
            if e.failed_at:
                assert any(s.episode == e.id and s.code == simulate.MODES[e.mode].code for s in r.stops)
    assert set(failed_modes) >= {"plunger", "accumulator", "cooling", "spray", "furnace"}
    # The MES's per-shift production adds up to the shots cast.
    rows = list(csv.DictReader(io.StringIO((DATA / "mes" / "production.csv").read_text())))
    for c in PILOT:
        assert sum(int(r["shots"]) for r in rows if r["asset"] == c.asset) == year.cells[c.asset].shots


def _day(year: generate.Year, tag: str, t: float) -> list[float] | None:
    return year.stats.days.get((tag, datetime.fromtimestamp(t, ZONE).date().isoformat()))


def test_each_breakdown_shows_in_its_signal_beforehand(built: tuple[Path, generate.Year]) -> None:
    """What makes the plant worth piloting on: on the day a watched component fails, its signal has
    moved well away from its level of the week before the trouble began (the median of that
    week's daily means, so a weekend doesn't count)."""
    _, year = built
    shown, total = 0, 0
    for c in PILOT:
        for e in year.cells[c.asset].episodes:
            if not e.failed_at or e.mode not in questions.PRECURSOR:
                continue
            name, direction = questions.PRECURSOR[e.mode]
            tag = f"hf{c.number:02d}.{name}" if name == "heater_power" else f"{c.key}.{name}"
            week = [d for k in range(1, 8) if (d := _day(year, tag, e.onset - k * 86400)) is not None]
            last = _day(year, tag, e.failed_at)
            if len(week) < 3 or last is None:
                continue
            baseline = statistics.median(d[2] / d[3] for d in week)
            extreme = last[1] if direction == "up" else last[0]
            total += 1
            shown += (
                (extreme - baseline) / abs(baseline) >= 0.08
                if direction == "up"
                else (extreme - baseline) / abs(baseline) <= -0.08
            )
    assert total >= 30 and shown == total, (shown, total)


def test_the_shot_curves_give_the_friction_the_plunger_model_finds() -> None:
    import random

    model = PlungerFriction()
    rng = random.Random(1)  # noqa: S311 - the shot noise of a test
    for friction in (9000.0, 18000.0, 30000.0):
        v, ph, pm = simulate.trace_shot(rng, friction)
        t = [i * simulate.DT for i in range(simulate.SAMPLES)]
        found = model.run({"t": t, "v": v, "ph": ph, "pm": pm}, {p.name: p.default for p in model.spec.params})[
            "friction"
        ][0]
        assert found is not None and abs(found - friction) / friction < 0.05
        # The slow-phase pressure the cell logs is the same physics at constant speed.
        slow = statistics.mean(ph[8:30])  # the steady slow phase
        assert abs(slow - simulate.friction_to_pressure(friction)) / slow < 0.03


def test_the_plant_model_imports_with_its_two_known_gaps() -> None:
    content = (DATA / "plant" / "ontology.json").read_text()
    graph = ontology_io.from_json(content)
    report = ontology.health_check(graph)
    problems = sorted({i["ref"] for i in report["issues"]})  # an orphan (warn) and a missing vendor (info)
    assert problems == ["cp-02", "sc-01"]
    tags = {r["tag"] for r in csv.DictReader(io.StringIO((DATA / "plant" / "tags.csv").read_text()))}
    signal_tags = {n["props"].get("tag") for n in graph["nodes"].values() if n["type"] == "Signal"}
    assert signal_tags <= tags  # every Signal node names a tag of the list


def test_the_questions_are_a_set_tiles_evaluate_can_score() -> None:
    cases = evaluation.read_csv((DATA / "copilot" / "questions.csv").read_text())
    assert len(cases) >= 100
    assert sum(c.decline for c in cases) >= 8
    assert {t for c in cases for t in c.tools} >= {
        "graph_query",
        "find_signals",
        "time_series",
        "events",
        "wear_check",
        "root_cause",
        "search_documents",
        "correlate",
        "ontology_health",
    }


def test_the_historian_files_read_back_as_they_were_written(tmp_path: Path) -> None:
    stats = generate.Stats()
    month = datetime(2026, 5, 1, tzinfo=ZONE).timestamp()
    hist = generate.Historian(tmp_path / "generated", stats, generate.Capture(month, month + 86400))
    t = datetime(2026, 4, 30, 23, 59, 59, tzinfo=ZONE).timestamp()  # 21:59:59 UTC: April's file
    hist.write("site", "lab.hydrogen", t, 0.12)
    hist.write("site", "lab.hydrogen", t + 4 * 3600, 0.13)  # 01:59:59 UTC on 1 May: May's file
    hist.close()
    assert sorted(hist.files) == ["historian/2026-04/site.csv.gz", "historian/2026-05/site.csv.gz"]
    assert all(f["rows"] == 1 and len(f["sha256"]) == 64 for f in hist.files.values())
    assert list(historian_readings(tmp_path)) == [
        ("lab.hydrogen", "2026-04-30T21:59:59.000Z", 0.12),
        ("lab.hydrogen", "2026-05-01T01:59:59.000Z", 0.13),
    ]
    assert stats.days[("lab.hydrogen", "2026-04-30")][:2] == [0.12, 0.12]
    assert (
        generate.quirk("dc04.intensification_pressure", datetime(2026, 5, 12, tzinfo=ZONE).timestamp(), 940.0) == 94.0
    )


class Oracle:
    """Calls each question's plan, then states its facts as the tools put them, citing them."""

    def __init__(self, cases: list[Case], plans: dict[str, list[tuple[str, dict[str, Any]]]]) -> None:
        self.by_question = {c.question: c for c in cases}
        self.plans = plans

    def stream(self, *, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> Iterator[Turn]:
        case = self.by_question[grounding.text_of(messages[0])]
        plan = self.plans.get(case.id, [])
        if len(messages) == 1 and plan:
            yield Turn(
                [
                    {"type": "tool_use", "id": f"t{n}", "name": name, "input": args}
                    for n, (name, args) in enumerate(plan)
                ],
                "tool_use",
            )
            return
        if not plan:
            yield Turn([{"type": "text", "text": f"{grounding.DECLINE}."}], "end_turn")
            return
        results = " ".join(str(b.get("content")) for b in messages[-1]["content"] if b.get("type") == "tool_result")
        said = []
        for fact in case.facts:
            options = fact if isinstance(fact, tuple) else (fact,)
            said.append(next((o for o in options if o.lower() in results.lower()), options[0]))
        yield Turn([{"type": "text", "text": "From the site's data: " + ", ".join(said) + " [1]."}], "end_turn")


def test_every_question_is_answered_from_the_loaded_plant(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    built: tuple[Path, generate.Year],
) -> None:
    out, year = built
    rows = list(csv.DictReader(io.StringIO((out / "copilot" / "questions.csv").read_text())))
    plans = {r["id"]: [(name, args) for name, args in json.loads(r["plan"])] for r in rows if r["plan"]}
    windows: dict[str, list[tuple[float, float]]] = {}
    for r in rows:
        for item in filter(None, (x.strip() for x in r["data"].split(";"))):
            tag, span = item.split("@")
            a, b = span.split("/")
            windows.setdefault(tag, []).append(
                (datetime.fromisoformat(a).timestamp(), datetime.fromisoformat(b).timestamp())
            )

    loader = Loader(api, site, ENG)
    loader.ontology(out)
    readings = []
    for tag, spans in windows.items():
        times, values = year.capture.readings[tag]
        for t, v in zip(times, values, strict=True):
            if any(a - 3600 <= t < b + 3600 for a, b in spans):
                readings.append((tag, generate.iso(t), v))
    loader.readings("questions' readings", readings)
    start, end = year.capture.start, year.capture.end
    may = [r for r in event_readings(out) if start <= datetime.fromisoformat(r[1]).timestamp() < end]
    loader.readings("May's MES events", may)
    loader.catalogue(out)
    loader.documents(out)
    month = datetime.fromtimestamp(start, ZONE)
    for c in PILOT:
        loader.dataset(questions.dataset_name(c.asset, month), "", year.capture.quality[c.asset])

    cases = evaluation.read_csv((out / "copilot" / "questions.csv").read_text())
    summary = evaluation.run(
        Oracle(cases, plans), None, database_url, cases, on=evaluation.OnSite(site, ENG["X-Tiles-User"])
    )
    failed = [
        (r.case, r.missing, r.wrong, r.problems, r.error) for r in summary.results if not r.correct or not r.grounded
    ]
    assert failed == [], json.dumps(failed, indent=1)
    assert math.isclose(summary.accuracy, 1.0) and summary.unsupported == 0
