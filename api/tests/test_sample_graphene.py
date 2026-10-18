"""The graphene sample plant (data/sample-plants/graphene): its files are what the generator makes,
its year runs like a roll-to-roll CVD film plant's (runs, yield, every failure mode, no run started
that can't finish in the week, none during a reactor's own stops), its genealogy carries causes
downstream (a leaking tube to defects and sheet resistance, a tired etch bath to transmittance, a
rough foil to smaller grains), and its copilot questions are answered by the tools once it is
loaded into a site."""

import bisect
import csv
import io
import itertools
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
from tiles_api.sample_plant.graphene import generate, questions
from tiles_api.sample_plant.graphene import simulate as sim
from tiles_api.sample_plant.graphene.plant import BATH_CHANGE, REACTORS, RUN_H, TRANSFERS, ZONE

DATA = Path(__file__).resolve().parents[2] / "data" / "sample-plants" / "graphene"
Built = tuple[Path, sim.Year, common.Stats, common.Capture]


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> Built:
    out = tmp_path_factory.mktemp("graphene")
    year, stats, capture, _ = generate.build(out, big=False)
    return out, year, stats, capture


def test_the_committed_files_are_what_the_generator_makes(built: Built) -> None:
    out = built[0]
    made = sorted(p.relative_to(out) for p in out.rglob("*") if p.is_file() and p.name != "manifest.json")
    kept = sorted(
        p.relative_to(DATA)
        for p in DATA.rglob("*")
        if p.is_file() and p.parts[len(DATA.parts)] != "generated" and p.name not in ("manifest.json", "README.md")
    )
    assert made == kept, "run `uv run tiles-sample-plant generate graphene` and commit data/sample-plants/graphene"
    stale = [str(p) for p in made if (out / p).read_bytes() != (DATA / p).read_bytes()]
    assert stale == [], "run `uv run tiles-sample-plant generate graphene` and commit data/sample-plants/graphene"
    new, old = json.loads((out / "manifest.json").read_text()), json.loads((DATA / "manifest.json").read_text())
    assert {k: v for k, v in new.items() if k != "generated"} == {k: v for k, v in old.items() if k != "generated"}


def test_the_year_runs_like_a_cvd_film_plant(built: Built) -> None:
    _, year, _, _ = built
    weeks = year.working.cum[-1] / (120 * 3600)
    assert 46 < weeks < 49  # five days a week, less bank holidays and the two shutdowns
    assert 6.5 < len(year.runs) / weeks / len(REACTORS) < 8.6  # a reactor's runs a week, at 14 hours each
    grades = Counter(x.grade for x in year.rolls)
    assert grades["A"] / len(year.rolls) > 0.85 and grades["NG"] / len(year.rolls) < 0.06
    failed = {e.mode for st in year.stations.values() for e in st.episodes if e.failed_at}
    assert failed >= {"leak", "heater", "pump", "rectifier", "laminator", "etch-pump", "packing"}
    # A drifting methane controller is mostly found by the transmittance check (SOP-CVD-03).
    # Its monthly calibration finds it however small (SOP-CVD-02).
    mfc = Counter(e.outcome for st in year.stations.values() for e in st.episodes if e.mode == "mfc")
    assert (
        set(mfc)
        <= {
            "Found by the transmittance check: MFC recalibrated",
            "Found and fixed at planned maintenance",
            "Still building up at the end of the year",
        }
        and mfc["Found by the transmittance check: MFC recalibrated"] >= 1
    ), mfc
    # The scrubber's monthly check stops the hall: no run is in progress during it.
    checks = [(s.start, s.end) for s in year.stations["SC-01"].stops if s.planned]
    assert checks and not [r.id for r in year.runs for a, b in checks if r.job[0] < b and r.job[1] > a]
    # A run starts only below the SOP's 0.010 mbar, and lab samples are taken in working time.
    assert max(r.base_pressure for r in year.runs) <= 0.0101
    assert all(year.working.working(r.lab_at) for r in year.runs if r.lab_at)
    for asset in (*REACTORS, *TRANSFERS, "EP-01"):
        stops = sorted((s.start, s.end) for s in year.stations[asset].stops)
        assert all(b[0] >= a[1] - 1e-6 for a, b in itertools.pairwise(stops)), asset  # no overlap
    # Every run fits in its working stretch, and none starts during its reactor's stops.
    ends = [b for _, b in year.working.intervals]
    for run in year.runs:
        i = year.working.index(run.job[0])
        assert run.job[1] <= ends[i] + 1, run.id
        if run.scrap != "CVD-ABT":  # an aborted run gives its reactor back once the scrubber is back
            assert abs(run.job[1] - run.job[0] - RUN_H * 3600) < 1
    for asset in REACTORS:
        stops = sorted((s.start, s.end) for s in year.stations[asset].stops)
        starts = [a for a, _ in stops]
        jobs = [r.job[0] for r in year.runs if r.reactor == asset]
        inside = sum(1 for t in jobs if (k := bisect.bisect_right(starts, t) - 1) >= 0 and t < stops[k][1] - 1e-6)
        assert inside == 0, (asset, inside)
    # A scrubber trip aborts the runs in progress, and only those.
    trips = [(s.start, s.end) for s in year.stations["SC-01"].stops if not s.planned]
    for run in year.runs:
        cut = any(run.job[0] < a < run.job[1] and year.working.working(a) for a, _ in trips)
        assert (run.scrap == "CVD-ABT") == cut, run.id
    # Each roll comes after its run is transferred, and the bath is changed near its limit.
    assert all(x.run.inspected[0] >= x.run.transfer[1] >= x.run.job[1] for x in year.rolls)
    assert sum(1 for *_, c in year.bath_changes if c > BATH_CHANGE + 4) < 0.1 * len(year.bath_changes)


def test_causes_upstream_show_in_the_film(built: Built) -> None:
    _, year, stats, _ = built

    def rejected(rolls: list[sim.FilmRoll], code: str) -> float:
        return sum(1 for x in rolls if x.scrap == code) / max(1, len(rolls))

    leaky = [x for x in year.rolls if x.run.oxygen > 8]
    tight = [x for x in year.rolls if x.run.oxygen < 2]
    assert len(leaky) > 100 and rejected(leaky, "QC-RS") > 5 * rejected(tight, "QC-RS")
    assert statistics.mean(x.run.d_g for x in leaky) > statistics.mean(x.run.d_g for x in tight) + 0.05
    dirty = [x.transmittance for x in year.rolls if x.run.residual > 0.02]
    clean = [x.transmittance for x in year.rolls if x.run.residual == 0]
    assert dirty and statistics.mean(dirty) < statistics.mean(clean) - 0.5
    rough = [x.rs for x in year.rolls if x.run.foil.ra > 95 and x.run.oxygen < 2]
    smooth = [x.rs for x in year.rolls if x.run.foil.ra < 70 and x.run.oxygen < 2]
    assert rough and statistics.mean(rough) > statistics.mean(smooth) * 1.03
    # CVD-02's thermocouple read high: the historian shows the set point while its runs grew cooler,
    # with smaller grains, than its others.
    a, b = sim.TC_DRIFT[2].timestamp(), sim.TC_DRIFT[3].timestamp()
    drift = [r for r in year.runs if r.reactor == "CVD-02" and a <= r.growth[0] < b]
    other = [r for r in year.runs if r.reactor == "CVD-02" and not a <= r.growth[0] < b]
    assert drift and statistics.mean(r.zone2 for r in drift) < statistics.mean(r.zone2 for r in other) - 6
    assert statistics.median(r.domain for r in drift) < 0.85 * statistics.median(r.domain for r in other)
    logged = [
        d[1]
        for (tag, day), d in stats.days.items()
        if tag == "cvd02.zone2_temp"
        and a + 86400 < datetime.fromisoformat(day).replace(tzinfo=ZONE).timestamp() < b - 86400
    ]
    assert logged and abs(statistics.median(logged) - 1035) < 3


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
                continue  # before the tag was renamed, or in a historian outage
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
    assert sorted({i["ref"] for i in ontology.health_check(graph)["issues"]}) == ["cvd-05"]
    tags = {r["tag"] for r in csv.DictReader(io.StringIO((DATA / "plant" / "tags.csv").read_text()))}
    assert {n["props"].get("tag") for n in graph["nodes"].values() if n["type"] == "Signal"} <= tags


def test_the_questions_are_a_set_tiles_evaluate_can_score() -> None:
    cases = evaluation.read_csv((DATA / "copilot" / "questions.csv").read_text())
    assert len(cases) >= 100 and sum(c.decline for c in cases) >= 8
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


def test_every_question_is_answered_from_the_loaded_plant(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    built: Built,
) -> None:
    out, _, _, capture = built
    month = datetime.fromtimestamp(capture.start, ZONE)
    summary = answer_all(api, site, ENG, database_url, out, capture, {"rolls": f"Film rolls {month:%Y-%m}"})
    failed = [
        (r.case, r.missing, r.wrong, r.problems, r.error) for r in summary.results if not r.correct or not r.grounded
    ]
    assert failed == [], json.dumps(failed, indent=1)
