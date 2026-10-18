"""The die-casting sample plant (data/sample-plants/die-casting): its files are what the generator
makes, its year behaves like a die-casting plant's, its physics is the plunger model's, and its
copilot questions are answered by the tools from the data, once it is loaded into a site."""

import bisect
import csv
import io
import itertools
import json
import math
import statistics
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sample_plants import answer_all
from test_agents import ENG, api, site  # noqa: F401 - api and site are fixtures

from tiles_api import evaluation, ontology, ontology_io
from tiles_api.models.plunger import PlungerFriction
from tiles_api.sample_plant import common
from tiles_api.sample_plant.die_casting import failure_backtest, generate, process_fit, questions, simulate
from tiles_api.sample_plant.die_casting.plant import PILOT, ZONE
from tiles_api.sample_plant.load import historian_readings

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
        and p.parts[len(DATA.parts)] not in ("generated", "backtests", "process-model")
        and p.name not in ("manifest.json", "README.md")
    )
    assert made == kept, (
        "run `uv run tiles-sample-plant generate die-casting` and commit data/sample-plants/die-casting"
    )
    stale = [str(p) for p in made if (out / p).read_bytes() != (DATA / p).read_bytes()]
    assert stale == [], "run `uv run tiles-sample-plant generate die-casting` and commit data/sample-plants/die-casting"
    new, old = json.loads((out / "manifest.json").read_text()), json.loads((DATA / "manifest.json").read_text())
    assert {k: v for k, v in new.items() if k != "generated"} == {k: v for k, v in old.items() if k != "generated"}


def test_the_failure_mode_models_beat_their_targets_and_their_reports_are_current() -> None:
    # T8.02 to T8.04: each model's backtest on the year, as `tiles-sample-plant backtest die-casting`
    # writes it to backtests/, beats its target on the year and on the half it wasn't tuned on.
    results = failure_backtest.all_results(DATA)
    for r in results:
        assert r.passed, failure_backtest.report(r)
        assert r.year.events >= 4 and r.held_out.events >= 1  # enough stops to judge it by
    stale = [n for n, text in failure_backtest.files(results).items() if (DATA / "backtests" / n).read_text() != text]
    assert stale == [], "run `uv run tiles-sample-plant backtest die-casting` and commit data/sample-plants/die-casting"


def test_the_process_model_meets_its_error_on_held_out_shots_and_its_files_are_current() -> None:
    # T11.01: fitted on October to March, judged on April to September, as `tiles-sample-plant fit
    # die-casting` writes it to process-model/ (models/process.py carries fit.json's numbers).
    fitted = process_fit.fit(process_fit.shots())
    assert fitted.passed, process_fit.report(fitted)
    assert all(e.meets(process_fit.TARGET) for e in fitted.by_cell.values())  # on every cell too
    assert fitted.held_out.shots > 300_000
    stale = [n for n, text in process_fit.files(fitted).items() if (DATA / "process-model" / n).read_text() != text]
    assert stale == [], "run `uv run tiles-sample-plant fit die-casting` and commit data/sample-plants/die-casting"


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
    # No shot is cast while its cell is stopped, and a cell's stops don't overlap.
    for c in simulate.CELLS:
        r = year.cells[c.asset]
        stops = sorted((s.start, s.end) for s in r.stops)
        assert all(b[0] >= a[1] - 1e-6 for a, b in itertools.pairwise(stops)), c.asset
        starts = [a for a, _ in stops]
        inside = 0
        for t in r.shot_times:
            k = bisect.bisect_right(starts, t) - 1
            inside += k >= 0 and t < stops[k][1] - 1e-6
        assert inside == 0, (c.asset, inside)
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
    stats = common.Stats(ZONE)
    month = datetime(2026, 5, 1, tzinfo=ZONE).timestamp()
    hist = common.Historian(tmp_path / "generated", stats, common.Capture(month, month + 86400))
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


def test_times_are_written_rounded_once() -> None:
    assert common.iso(1767225599.9999996) == "2026-01-01T00:00:00.000Z"
    assert common.iso(1767225599.1234) == "2025-12-31T23:59:59.123Z"


def test_the_historian_refuses_to_reopen_a_month(tmp_path: Path) -> None:
    hist = common.Historian(tmp_path, common.Stats(ZONE), common.Capture(0, 0))
    hist.write("s", "x", datetime(2026, 4, 30, 12, tzinfo=ZONE).timestamp(), 1.0)
    hist.write("s", "x", datetime(2026, 5, 2, tzinfo=ZONE).timestamp(), 2.0)
    with pytest.raises(ValueError, match="after a later month"):
        hist.write("s", "x", datetime(2026, 4, 30, 13, tzinfo=ZONE).timestamp(), 3.0)


def test_generate_all_writes_each_plant_in_out(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import types

    from tiles_api import sample_plant

    wrote: list[Path] = []

    def fake(out: Path, big: bool = False) -> dict[str, Any]:
        wrote.append(out)
        return {"committed": {}, "generated": {}}

    monkeypatch.setattr(sample_plant, "plant", lambda name: types.SimpleNamespace(generate=fake))
    with pytest.raises(SystemExit):
        sample_plant.main(["generate", "all", "--out", str(tmp_path)])
    assert wrote == [tmp_path / name for name in sample_plant.PLANTS]


def test_every_question_is_answered_from_the_loaded_plant(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    built: tuple[Path, generate.Year],
) -> None:
    out, year = built
    month = datetime.fromtimestamp(year.capture.start, ZONE)
    tables = {c.asset: questions.dataset_name(c.asset, month) for c in PILOT}
    summary = answer_all(api, site, ENG, database_url, out, year.capture, tables)
    failed = [
        (r.case, r.missing, r.wrong, r.problems, r.error) for r in summary.results if not r.correct or not r.grounded
    ]
    assert failed == [], json.dumps(failed, indent=1)
    assert math.isclose(summary.accuracy, 1.0) and summary.unsupported == 0
