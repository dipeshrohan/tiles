"""The load test tool (T5.15): its arithmetic and report, and a short run against a real server."""

import socket
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
import uvicorn

from tiles_api import loadtest
from tiles_api.loadtest import Http, Results, Step, Targets, batches, judge, percentile, readings, report
from tiles_api.main import create_app
from tiles_api.seed import seed
from tiles_api.settings import Settings


def test_percentiles_by_nearest_rank() -> None:
    values = [float(v) for v in range(1, 101)]
    assert [percentile(values, p) for p in (50, 95, 99, 100)] == [50, 95, 99, 100]
    assert percentile([7.0], 95) == 7
    assert percentile([], 95) == 0


def test_an_agents_readings_cover_its_signals_each_second_and_split_at_the_api_limit() -> None:
    rows = readings(agent=3, signals=4, start=1_700_000_000, seconds=5, rate=2)
    assert len(rows) == 4 * 5 * 2
    assert {r["signal"] for r in rows} == {f"load.a3.s{i}" for i in range(4)}
    assert len({r["at"] for r in rows}) == 10  # every half second
    assert [len(b) for b in batches(list(range(25_000)), 10_000)] == [10_000, 10_000, 5_000]  # type: ignore[arg-type]


def test_judging_a_run() -> None:
    targets = Targets(readings_per_s=100, p95_ms=500, interval_s=5)
    good = Results(
        steps={"warnings": Step(ms=[100.0] * 20), "ingest": Step(ms=[2000.0])},
        stored=6000,
        sent=6000,
        covered_s=60,
        late_ms=[0.0, 4000.0],
    )
    assert judge(good, targets, 60) == []  # ingest's own latency isn't judged, its pace is
    slow = Results(steps={"warnings": Step(ms=[100.0] * 18 + [900.0] * 2)}, stored=5000, covered_s=60, late_ms=[6000.0])
    slow.steps["warnings"].fail("503")
    problems = judge(slow, targets, 60)
    assert problems == [
        "stored 83 readings/s, under 99% of 100",
        "batches went out 6,000 ms late (95th percentile): the API isn't keeping pace",
        "warnings: 1 failed (503 x1)",
        "warnings: 95th percentile 900 ms, over 500 ms",
    ]
    text = report(slow, targets, 60, {"users": 1})
    assert "**Failed**" in text
    assert "| warnings | 21 | 0.3 | 100 | 900 | 900 | 900 | 503 x1 |" in text


@pytest.fixture
def server(database_url: str) -> Iterator[str]:
    """The API on a free port, as `tiles-api` runs it."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    settings = Settings(_env_file=None, env="development", database_url=database_url)
    app = create_app(settings)
    srv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None, log_level="warning"))
    thread = threading.Thread(target=srv.run, daemon=True)
    thread.start()
    deadline = time.time() + 20
    while not srv.started:
        assert time.time() < deadline, "the API didn't start"
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    srv.should_exit = True
    thread.join(10)


def test_a_short_run_against_the_api(
    server: str, database_url: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    seed(Settings(_env_file=None, database_url=database_url))
    monkeypatch.setenv("TILES_DATABASE_URL", database_url)
    monkeypatch.setattr(loadtest, "get_settings", lambda: Settings(_env_file=None, database_url=database_url))
    tokens = tmp_path / "tokens.txt"
    with pytest.raises(SystemExit) as prepared:
        loadtest.main(["prepare", "--agents", "2", "--out", str(tokens)])
    assert prepared.value.code == 0
    assert tokens.stat().st_mode & 0o777 == 0o600
    report_file = tmp_path / "report.md"
    args = ["run", "--api", server, "--tokens", str(tokens), "--signals", "20", "--users", "3"]
    args += ["--interval", "1", "--warmup", "1", "--duration", "3", "--report", str(report_file)]
    with pytest.raises(SystemExit) as ran:
        loadtest.main(args)
    text = report_file.read_text()
    assert ran.value.code == 0, text
    assert "**Passed**" in text
    assert "Readings stored: 20/s (target 20/s)" in text
    assert "| ingest |" in text
    # Preparing again revokes the earlier agents: their tokens stop working.
    with pytest.raises(SystemExit):
        loadtest.main(["prepare", "--agents", "1", "--out", str(tmp_path / "again.txt")])
    old = tokens.read_text().split()[0]
    with Http(server, {"authorization": f"Bearer {old}"}) as agent:
        status, _, _ = agent.call("POST", "/agent/samples", {"samples": []})
    assert status == 401
    capsys.readouterr()
