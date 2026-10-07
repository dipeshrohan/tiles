import json
import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import FakeTiles, write_config

from tiles_edge.cli import main


def test_check_sends_one_heartbeat(tmp_path: Path, tiles: FakeTiles, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["check", "-c", str(write_config(tmp_path, tiles.url))]) == 0
    assert json.loads(capsys.readouterr().out) == {"ok": True, "agent_id": "a-1", "site_id": "s-1"}
    assert len(tiles.requests) == 1


def test_check_exit_codes(tmp_path: Path, tiles: FakeTiles, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["check", "-c", str(tmp_path / "missing.toml")]) == 2
    assert main(["check", "-c", str(write_config(tmp_path, "http://127.0.0.1:9"))]) == 1
    tiles.answers = [(401, {"detail": "Unknown or revoked agent token"})]
    assert main(["check", "-c", str(write_config(tmp_path, tiles.url))]) == 3
    assert "Unknown or revoked agent token" in capsys.readouterr().err


def test_run_beats_until_sigterm(tmp_path: Path, tiles: FakeTiles) -> None:
    config = write_config(tmp_path, tiles.url)
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).parents[1] / "src")}
    with subprocess.Popen(  # noqa: S603 - this interpreter, fixed arguments
        [sys.executable, "-m", "tiles_edge", "run", "-c", str(config)],
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    ) as agent:
        try:
            assert tiles.heartbeat_seen.wait(15), "no heartbeat arrived"
            agent.send_signal(signal.SIGTERM)
            _, stderr = agent.communicate(timeout=10)
        finally:
            agent.kill()
    assert agent.returncode == 0
    lines = [json.loads(line) for line in stderr.splitlines()]
    assert [line["message"] for line in lines] == ["agent started", "agent stopped"]
    assert lines[0]["tiles_url"] == tiles.url


def test_the_single_file_build_keeps_exit_codes(tmp_path: Path) -> None:
    pyz = tmp_path / "tiles-edge.pyz"
    src = Path(__file__).parents[1] / "src"
    subprocess.run(  # noqa: S603 - this interpreter, fixed arguments
        [sys.executable, "-m", "zipapp", str(src), "-m", "tiles_edge.cli:entry", "-o", str(pyz)], check=True
    )
    version = subprocess.run([sys.executable, str(pyz), "--version"], capture_output=True, text=True, check=True)  # noqa: S603
    assert version.stdout.strip() == "tiles-edge 0.1.0"
    missing = subprocess.run([sys.executable, str(pyz), "check", "-c", str(tmp_path / "nope.toml")], check=False)  # noqa: S603
    assert missing.returncode == 2
