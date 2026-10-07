import threading
from pathlib import Path
from typing import Any

from conftest import write_config

from tiles_edge import __version__
from tiles_edge.agent import Agent
from tiles_edge.client import RejectedError, TransientError
from tiles_edge.config import Config, load


class ScriptedClient:
    """Answers each post from a script: a dict, or an exception to raise."""

    def __init__(self, *script: dict[str, Any] | Exception) -> None:
        self.script = list(script)
        self.posts: list[tuple[str, dict[str, Any]]] = []

    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        self.posts.append((path, body))
        step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        return step


class CountingStop(threading.Event):
    """Records each wait instead of sleeping, and stops after `limit` waits."""

    def __init__(self, limit: int) -> None:
        super().__init__()
        self.limit = limit
        self.waits: list[float] = []

    def wait(self, timeout: float | None = None) -> bool:
        assert timeout is not None
        self.waits.append(timeout)
        if len(self.waits) >= self.limit:
            self.set()
        return self.is_set()


def config(tmp_path: Path) -> Config:
    return load(write_config(tmp_path, "https://tiles.example.com"), env={})


def test_heartbeats_describe_the_agent(tmp_path: Path) -> None:
    client = ScriptedClient({"agent_id": "a"})
    agent = Agent(config(tmp_path), client, hostname="edge-01")
    agent.heartbeat()
    [(path, body)] = client.posts
    assert path == "/agent/heartbeat"
    assert body == {
        "version": __version__,
        "hostname": "edge-01",
        "started_at": agent.started_at.isoformat(),
        "heartbeat_seconds": 5,
        "connectors": [],
    }


def test_it_beats_every_interval_and_backs_off_while_tiles_is_away(tmp_path: Path) -> None:
    away = TransientError("can't reach")
    client = ScriptedClient({}, away, away, away, {}, {})
    stop = CountingStop(limit=6)
    agent = Agent(config(tmp_path), client, stop=stop, jitter=lambda: 1.0)
    assert agent.run() == 0
    # ok → 5 s; failures → 1, 2, 4 s (doubling); back again → 5 s each.
    assert stop.waits == [5, 1, 2, 4, 5, 5]
    assert len(client.posts) == 6


def test_backoff_is_capped_by_the_heartbeat_and_jittered(tmp_path: Path) -> None:
    agent = Agent(config(tmp_path), ScriptedClient(), jitter=lambda: 1.0)
    assert [agent.backoff(n) for n in (1, 2, 3, 4, 10)] == [1, 2, 4, 5, 5]
    agent.jitter = lambda: 0.0
    assert agent.backoff(3) == 2  # half the ceiling at the low end


def test_it_stops_when_tiles_rejects_the_agent(tmp_path: Path) -> None:
    client = ScriptedClient({}, RejectedError("Tiles answered 401: Unknown or revoked agent token"))
    agent = Agent(config(tmp_path), client, stop=CountingStop(limit=10))
    assert agent.run() == 3
    assert len(client.posts) == 2
