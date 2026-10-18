"""The biologics sample plant (data/sample-plants/biologics): its files are what the generator makes,
its year runs like a monoclonal-antibody site's (batches, yields, every failure mode, nothing run
during a machine's own stops, a deviation and CAPA for every lost batch), its genealogy carries causes
downstream (an aged resin to a lower yield, a compressed CEX bed to aggregates, a leaking
lyophiliser to collapsed cakes, a worn dosing pump to one needle's under-filled vials), each
breakdown shows in its signal beforehand, and its copilot questions are answered by the tools once
it is loaded into a site."""

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
from tiles_api.sample_plant.biologics import generate, questions
from tiles_api.sample_plant.biologics import simulate as sim
from tiles_api.sample_plant.biologics.plant import ZONE

DATA = Path(__file__).resolve().parents[2] / "data" / "sample-plants" / "biologics"
Built = tuple[Path, sim.Year, common.Stats, common.Capture]
DAY = 86400.0


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> Built:
    out = tmp_path_factory.mktemp("biologics")
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
    assert made == kept, "run `uv run tiles-sample-plant generate biologics` and commit data/sample-plants/biologics"
    stale = [str(p) for p in made if (out / p).read_bytes() != (DATA / p).read_bytes()]
    assert stale == [], "run `uv run tiles-sample-plant generate biologics` and commit data/sample-plants/biologics"
    new, old = json.loads((out / "manifest.json").read_text()), json.loads((DATA / "manifest.json").read_text())
    assert {k: v for k, v in new.items() if k != "generated"} == {k: v for k, v in old.items() if k != "generated"}


def _inside(spans: list[tuple[float, float]], stops: list[common.Stop]) -> int:
    """How many of the spans begin inside one of the stops."""
    ordered = sorted((s.start, s.end) for s in stops)
    starts = [a for a, _ in ordered]
    return sum(1 for a, _ in spans if (k := bisect.bisect_right(starts, a) - 1) >= 0 and a < ordered[k][1] - 1e-6)


def test_the_year_runs_like_a_biologics_site(built: Built) -> None:
    _, year, _, _ = built
    batches = [b for b in year.batches if b.inoculated]
    assert 75 <= len(batches) <= 95  # four 2,000 L reactors on 14-day cultures, less a fortnight's shutdown
    harvested = [b for b in batches if b.harvest[0]]
    assert 4.0 < statistics.mean(b.harvest_titre for b in harvested) < 5.0  # g/L
    assert 80 < statistics.mean(b.harvest_viability for b in harvested) < 92
    assert 1 <= sum(1 for b in batches if b.lost) <= 3
    tested = [b for b in batches if b.bulk_status]
    assert sum(b.bulk_status == "released" for b in tested) / len(tested) > 0.9
    assert 4.5 < statistics.mean(b.bulk_g for b in tested) / 1000 < 6.5  # kg of drug substance a batch
    vials = sum(lot.vials for lot in year.lots)
    rejected = sum(len(lot.rejects) for lot in year.lots)
    assert 350_000 < vials < 480_000 and 0.004 < rejected / vials < 0.03
    failed = {e.mode for st in year.stations.values() for e in st.episodes if e.failed_at}
    assert failed >= {"seal", "wfi", "filter", "bearing", "bed", "membrane", "leak", "pump"}
    for st in year.stations.values():
        stops = sorted((s.start, s.end) for s in st.stops)
        assert all(b[0] >= a[1] - 1e-6 for a, b in itertools.pairwise(stops)), st.asset  # no overlap
    # No culture is inoculated, no cycle started and no vial filled while its machine is stopped.
    for asset in ("BR-01", "BR-02", "BR-03", "BR-04"):
        spans = [(b.inoculated, b.ended) for b in batches if b.reactor == asset]
        assert _inside(spans, year.stations[asset].stops) == 0, asset
        assert all(x[1] <= y[0] + 1e-6 for x, y in itertools.pairwise(sorted(spans))), asset  # one at a time
    assert _inside([lot.lyo for lot in year.lots], year.stations["LY-01"].stops) == 0
    assert _inside([lot.fill for lot in year.lots], year.stations["FL-01"].stops) == 0
    # No culture runs over the annual shutdown.
    shut = (datetime(2026, 7, 27, 7, tzinfo=ZONE).timestamp(), datetime(2026, 8, 10, 7, tzinfo=ZONE).timestamp())
    assert not [b.id for b in batches if b.inoculated < shut[1] and b.ended > shut[0]]


def test_every_lost_batch_has_a_critical_deviation_and_a_capa(built: Built) -> None:
    _, year, _, _ = built
    for b in year.batches:
        if b.lost:
            devs = [d for d in year.deviations if d.lot == b.id]
            assert devs and devs[0].classification == "critical" and devs[0].capa, b.id
    rows = list(csv.DictReader(io.StringIO((built[0] / "qms" / "capa.csv").read_text())))
    raised = {d.id for d in year.deviations if d.capa}
    assert {r["deviation"] for r in rows} == raised


def test_causes_upstream_show_downstream(built: Built) -> None:
    _, year, _, _ = built
    cycles = [c for b in year.batches for c in b.cycles]
    assert statistics.correlation([c.resin_cycle for c in cycles], [c.step_yield for c in cycles]) < -0.6
    bulk = [b for b in year.batches if b.bulk_id]
    worn = [b.bulk_hmw for b in bulk if b.cex_asymmetry > 1.35]
    good = [b.bulk_hmw for b in bulk if b.cex_asymmetry < 1.2]
    assert len(worn) >= 3 and statistics.mean(worn) > statistics.mean(good) + 0.3

    def cake(lots: list[sim.FillLot]) -> float:
        return sum(1 for lot in lots for c, _ in lot.rejects.values() if c == "VIS-CAKE") / sum(
            lot.vials for lot in lots
        )

    by_leak = sorted(year.lots, key=lambda lot: lot.leak_rate)
    leaking, tight = by_leak[-3:], [lot for lot in by_leak if lot.leak_rate < 6]
    assert leaking[0].leak_rate > 7 and cake(leaking) > 5 * cake(tight)
    # A worn pump under-fills its own needle's vials.
    for lot in year.lots:
        if lot.pump > 0.6:
            mine = [w for i, w in enumerate(lot.weights) if i % 8 == lot.worn_head]
            rest = [w for i, w in enumerate(lot.weights) if i % 8 != lot.worn_head]
            assert statistics.mean(mine) < statistics.mean(rest) - 0.08, lot.id
    low = [b.bulk_hcp for b in bulk if b.harvest_viability < 84]
    high = [b.bulk_hcp for b in bulk if b.harvest_viability > 88]
    assert low and statistics.mean(low) > statistics.mean(high) + 3


def _days(stats: common.Stats, tag: str, a: float, b: float) -> list[list[float]]:
    """The tag's daily min, max, sum and count over the plant days from a to b."""
    out = []
    d = datetime.fromtimestamp(a, ZONE).date()
    while datetime(d.year, d.month, d.day, tzinfo=ZONE).timestamp() <= b:
        s = stats.days.get((tag, d.isoformat()))
        if s is not None:
            out.append(s)
        d = datetime.fromordinal(d.toordinal() + 1).date()
    return out


def test_each_breakdown_shows_in_its_signal_beforehand(built: Built) -> None:
    _, year, stats, _ = built
    shown = total = 0
    for st in year.stations.values():
        for e in st.episodes:
            if not e.failed_at or e.mode not in questions.PRECURSOR:
                continue
            if e.mode == "pump":  # its needle's vials, not the day's: tested above
                continue
            tag = questions.tag_of(e)
            direction = questions.PRECURSOR[e.mode][1]
            before = _days(stats, tag, e.onset - 14 * DAY, e.onset - DAY)
            during = _days(stats, tag, e.onset, e.failed_at)
            if len(before) < 2 or not during:
                continue
            total += 1
            # The episode's furthest reading against the fortnight before it: 15 % past its usual
            # level, and past everything it read then.
            level = statistics.median(s[2] / s[3] for s in before)
            if direction == "up":
                shown += max(s[1] for s in during) >= max(1.15 * level, max(s[1] for s in before))
            else:
                shown += min(s[0] for s in during) <= min(0.85 * level, min(s[0] for s in before))
    assert total >= 10 and shown == total, (shown, total)


def test_the_plant_model_imports_with_its_known_gap() -> None:
    graph = ontology_io.from_json((DATA / "plant" / "ontology.json").read_text())
    assert sorted({i["ref"] for i in ontology.health_check(graph)["issues"]}) == ["br-05"]
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
    kinds = Counter(c.id.split("-")[0] for c in cases)
    assert kinds["why"] >= 3 and kinds["code"] >= 3 and kinds["doc"] >= 20


def test_every_question_is_answered_from_the_loaded_plant(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    built: Built,
) -> None:
    out, _, _, capture = built
    summary = answer_all(api, site, ENG, database_url, out, capture, {"vials": f"Vials {generate.TABLE_MONTH:%Y-%m}"})
    failed = [
        (r.case, r.missing, r.wrong, r.problems, r.error) for r in summary.results if not r.correct or not r.grounded
    ]
    assert failed == [], json.dumps(failed, indent=1)
