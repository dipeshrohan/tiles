"""The battery sample plant (data/sample-plants/battery): its files are what the generator makes,
its year runs like a cell plant's (output, yield, every failure mode, no work during a machine's own
stops), its genealogy carries causes downstream (burrs to self-discharge, a humid dry room to
moisture), and its copilot questions are answered by the tools once it is loaded into a site."""

import bisect
import csv
import io
import json
import statistics
from collections import Counter
from datetime import datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sample_plants import answer_all
from test_agents import ENG, api, site  # noqa: F401 - api and site are fixtures

from tiles_api import evaluation, ontology, ontology_io
from tiles_api.sample_plant import common
from tiles_api.sample_plant.battery import generate, questions
from tiles_api.sample_plant.battery import simulate as sim
from tiles_api.sample_plant.battery.plant import ZONE

DATA = Path(__file__).resolve().parents[2] / "data" / "sample-plants" / "battery"
Built = tuple[Path, sim.Year, common.Stats, common.Capture]


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> Built:
    out = tmp_path_factory.mktemp("battery")
    year, stats, capture, _ = generate.build(out, big=False)
    return out, year, stats, capture


def test_the_committed_files_are_what_the_generator_makes(built: Built) -> None:
    out = built[0]
    made = sorted(p.relative_to(out) for p in out.rglob("*") if p.is_file() and p.name != "manifest.json")
    kept = sorted(p.relative_to(DATA) for p in DATA.rglob("*") if p.is_file() and p.parts[len(DATA.parts)] != "generated" and p.name not in ("manifest.json", "README.md"))
    assert made == kept, "run `uv run tiles-sample-plant generate battery` and commit data/sample-plants/battery"
    stale = [str(p) for p in made if (out / p).read_bytes() != (DATA / p).read_bytes()]
    assert stale == [], "run `uv run tiles-sample-plant generate battery` and commit data/sample-plants/battery"
    new, old = json.loads((out / "manifest.json").read_text()), json.loads((DATA / "manifest.json").read_text())
    assert {k: v for k, v in new.items() if k != "generated"} == {k: v for k, v in old.items() if k != "generated"}


def test_the_year_runs_like_a_cell_plant(built: Built) -> None:
    _, year, _, _ = built
    days = year.working.cum[-1] / 86400
    assert 340 < days < 360  # around the clock, less Christmas, New Year and a summer week
    assert 1700 < len(year.cells) / days < 2200  # cells a day
    tested = [c for c in year.cells if c.tested]
    grades = Counter(c.grade for c in tested)
    assert grades["A"] / len(tested) > 0.85 and grades["NG"] / len(tested) < 0.03
    failed = {e.mode for st in year.stations.values() for e in st.episodes if e.failed_at}
    assert failed >= {"die-lip", "dryer", "bearing", "desiccant", "tension", "horn", "pump", "contacts"}
    for asset in ("CT-C1", "CT-A1", "ST-01", "ST-02", "UW-01", "EF-01"):
        st = year.stations[asset]
        stops = sorted((s.start, s.end) for s in st.stops)
        assert all(b[0] >= a[1] - 1e-6 for a, b in zip(stops, stops[1:], strict=False)), asset  # no overlap
    # No coil is coated, and no cell stacked, while its machine is stopped.
    for asset, times in (
        ("CT-C1", [c.coated[0] for c in year.coils if c.side == "C"]),
        ("ST-01", [c.stacked - c.cycle for c in year.cells if c.stacker == "ST-01"]),
    ):
        stops = sorted((s.start, s.end) for s in year.stations[asset].stops)
        starts = [a for a, _ in stops]
        inside = sum(1 for t in times if (k := bisect.bisect_right(starts, t) - 1) >= 0 and t < stops[k][1] - 1e-6)
        assert inside == 0, (asset, inside)


def test_causes_upstream_show_at_the_end_of_the_line(built: Built) -> None:
    _, year, _, _ = built
    tested = [c for c in year.cells if c.tested]

    def k_fails(cells: list[sim.CellRecord]) -> float:
        return sum(1 for c in cells if c.scrap == "EOL-K") / max(1, len(cells))

    burred = [c for c in tested if max(c.cathode.burr, c.anode.burr) >= 11.0]
    clean = [c for c in tested if max(c.cathode.burr, c.anode.burr) < 8.0]
    assert len(burred) > 200 and k_fails(burred) > 5 * k_fails(clean)
    humid = [c.cathode.moisture for c in year.cells if c.dew_point > -35]
    dry = [c.cathode.moisture for c in year.cells if c.dew_point < -42]
    assert humid and statistics.mean(humid) > statistics.mean(dry) + 50


def _day(stats: common.Stats, tag: str, t: float) -> list[float] | None:
    return stats.days.get((tag, datetime.fromtimestamp(t, ZONE).date().isoformat()))


def test_each_breakdown_shows_in_its_signal_beforehand(built: Built) -> None:
    _, year, stats, _ = built
    shown = total = 0
    for st in year.stations.values():
        for e in st.episodes:
            if not e.failed_at or e.mode not in questions.PRECURSOR:
                continue
            tag = questions.tag_of(e)
            direction = questions.PRECURSOR[e.mode][1]
            week = [d for k in range(1, 8) if (d := _day(stats, tag, e.onset - k * 86400)) is not None]
            last = _day(stats, tag, e.failed_at)
            if len(week) < 3 or last is None:
                continue
            # 8 % from the week's level, or beyond all it saw by 3 % (a signal that varies little).
            baseline = statistics.median(d[2] / d[3] for d in week)
            margin = 0.03 * abs(baseline)
            total += 1
            if direction == "up":
                shown += last[1] >= baseline * 1.08 or last[1] > max(d[1] for d in week) + margin
            else:
                shown += last[0] <= baseline * 0.92 or last[0] < min(d[0] for d in week) - margin
    assert total >= 15 and shown == total, (shown, total)


def test_the_plant_model_imports_with_its_known_gap() -> None:
    graph = ontology_io.from_json((DATA / "plant" / "ontology.json").read_text())
    assert sorted({i["ref"] for i in ontology.health_check(graph)["issues"]}) == ["vd-c2"]
    tags = {r["tag"] for r in csv.DictReader(io.StringIO((DATA / "plant" / "tags.csv").read_text()))}
    assert {n["props"].get("tag") for n in graph["nodes"].values() if n["type"] == "Signal"} <= tags


def test_the_questions_are_a_set_tiles_evaluate_can_score() -> None:
    cases = evaluation.read_csv((DATA / "copilot" / "questions.csv").read_text())
    assert len(cases) >= 100 and sum(c.decline for c in cases) >= 8
    assert {t for c in cases for t in c.tools} >= {"graph_query", "find_signals", "time_series", "events", "wear_check", "root_cause", "search_documents", "correlate", "ontology_health"}


def test_every_question_is_answered_from_the_loaded_plant(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    built: Built,
) -> None:
    out, _, _, capture = built
    month = datetime.fromtimestamp(capture.start, ZONE)
    summary = answer_all(api, site, ENG, database_url, out, capture, {"cells": f"Cells {month:%Y-%m}"})
    failed = [(r.case, r.missing, r.wrong, r.problems, r.error) for r in summary.results if not r.correct or not r.grounded]
    assert failed == [], json.dumps(failed, indent=1)
