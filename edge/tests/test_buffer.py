"""Store and forward (T2.04): the disk buffer and the forwarder, including a long outage."""

import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from tiles_edge.buffer import BufferError, DiskBuffer
from tiles_edge.client import RejectedError, TransientError
from tiles_edge.forwarder import Forwarder
from tiles_edge.samples import Sample

T0 = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)


def sample(i: int, signal: str = "press1.temperature") -> Sample:
    return Sample(signal, T0 + timedelta(seconds=i), 20.0 + i / 10, "good")


class FlakyTiles:
    """Accepts batches, except while `down` is set (or a given error is queued)."""

    def __init__(self) -> None:
        self.down = threading.Event()
        self.errors: list[Exception] = []
        self.received: list[dict[str, Any]] = []
        self.batches = 0

    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        assert path == "/agent/samples"
        if self.errors:
            raise self.errors.pop(0)
        if self.down.is_set():
            raise TransientError("can't reach tiles.example.com: Connection refused")
        self.received.extend(body["samples"])
        self.batches += 1
        return {"accepted": len(body["samples"])}


def test_samples_survive_a_restart(tmp_path: Path) -> None:
    buffer = DiskBuffer(tmp_path / "buffer.sqlite")
    buffer.put_many([sample(i) for i in range(3)])
    buffer.close()
    reopened = DiskBuffer(tmp_path / "buffer.sqlite")
    try:
        assert len(reopened) == 3
        assert [q.sample for q in reopened.oldest(10)] == [sample(0), sample(1), sample(2)]
        assert reopened.oldest_time() == T0
    finally:
        reopened.close()


def test_values_keep_their_types(tmp_path: Path) -> None:
    buffer = DiskBuffer(tmp_path / "b.sqlite")
    try:
        for value in (1, 2.5, True, "running"):
            buffer.put(Sample("s", T0, value, "uncertain"))
        assert [(q.sample.value, q.sample.quality) for q in buffer.oldest(10)] == [
            (1, "uncertain"),
            (2.5, "uncertain"),
            (True, "uncertain"),
            ("running", "uncertain"),
        ]
    finally:
        buffer.close()


def test_a_full_buffer_drops_the_oldest_and_counts_them(tmp_path: Path) -> None:
    buffer = DiskBuffer(tmp_path / "b.sqlite", max_samples=1000)
    try:
        buffer.put_many([sample(i) for i in range(1200)])
        assert len(buffer) == 1000
        assert buffer.counter("dropped") == 200
        assert buffer.oldest(1)[0].sample == sample(200)
    finally:
        buffer.close()


def test_ack_forgets_only_what_was_sent(tmp_path: Path) -> None:
    buffer = DiskBuffer(tmp_path / "b.sqlite")
    try:
        buffer.put_many([sample(i) for i in range(5)])
        batch = buffer.oldest(2)
        buffer.put(sample(5))  # arrives while the batch is in flight
        buffer.ack(batch[-1].seq)
        assert [q.sample for q in buffer.oldest(10)] == [sample(i) for i in range(2, 6)]
        assert (len(buffer), buffer.counter("sent")) == (4, 2)
    finally:
        buffer.close()


def test_an_unwritable_buffer_is_explained(tmp_path: Path) -> None:
    (tmp_path / "a-file").write_text("")
    with pytest.raises(BufferError, match="can't open the buffer"):
        DiskBuffer(tmp_path / "a-file" / "buffer.sqlite")


def test_a_long_outage_loses_nothing_and_backfills_in_order(tmp_path: Path) -> None:
    """The done-when of T2.04: an hour of samples (one a second) collected while Tiles is
    unreachable, with an agent restart in the middle, all arrive in order once it's back."""
    path = tmp_path / "buffer.sqlite"
    tiles = FlakyTiles()
    tiles.down.set()
    hour = 3600

    buffer = DiskBuffer(path)
    forwarder = Forwarder(buffer, tiles, batch_size=500, max_retry_seconds=0.05, idle_seconds=0.01)
    forwarder.start()
    buffer.put_many([sample(i) for i in range(hour // 2)])
    deadline = datetime.now(UTC) + timedelta(seconds=10)
    while not forwarder.status()["problem"]:
        assert datetime.now(UTC) < deadline, "the forwarder never tried to send"
        threading.Event().wait(0.01)
    forwarder.stop()
    assert "Connection refused" in forwarder.status()["problem"]
    buffer.close()  # the agent restarts, still cut off

    buffer = DiskBuffer(path)
    forwarder = Forwarder(buffer, tiles, batch_size=500, max_retry_seconds=0.05, idle_seconds=0.01)
    forwarder.start()
    try:
        buffer.put_many([sample(i) for i in range(hour // 2, hour)])
        assert forwarder.status()["queued"] == hour
        assert tiles.received == []
        tiles.down.clear()  # the network is back
        deadline = datetime.now(UTC) + timedelta(seconds=20)
        while len(tiles.received) < hour:
            assert datetime.now(UTC) < deadline, "the backlog didn't go out"
            threading.Event().wait(0.05)
    finally:
        forwarder.stop()
    assert [s["at"] for s in tiles.received] == [sample(i).at.isoformat() for i in range(hour)]
    assert tiles.batches == hour // 500 + (1 if hour % 500 else 0)
    status = forwarder.status()
    assert (status["queued"], status["sent"], status["dropped"], status["problem"]) == (0, hour, 0, "")
    buffer.close()


def test_tiles_without_an_ingest_endpoint_keeps_samples(tmp_path: Path) -> None:
    buffer = DiskBuffer(tmp_path / "b.sqlite")
    tiles = FlakyTiles()
    tiles.errors = [RejectedError("Tiles answered 404: Not Found", 404)]
    forwarder = Forwarder(buffer, tiles, max_retry_seconds=0.01)
    try:
        buffer.put(sample(0))
        assert forwarder.send_once() == 0
        assert len(buffer) == 1
        assert "doesn't accept samples yet" in forwarder.status()["problem"]
        assert forwarder.send_once() == 1  # and once it does, they go
        assert forwarder.status()["problem"] == ""
    finally:
        buffer.close()


def test_a_batch_tiles_can_never_take_is_set_aside_not_retried_forever(tmp_path: Path) -> None:
    buffer = DiskBuffer(tmp_path / "b.sqlite")
    tiles = FlakyTiles()
    tiles.errors = [RejectedError("Tiles answered 422: value must be finite", 422)]
    forwarder = Forwarder(buffer, tiles, batch_size=2)
    try:
        buffer.put_many([sample(i) for i in range(3)])
        assert forwarder.send_once() == 0
        assert (len(buffer), buffer.counter("rejected")) == (1, 2)
        assert "was rejected" in forwarder.status()["problem"]
        assert forwarder.send_once() == 1  # the rest still goes
        assert [s["at"] for s in tiles.received] == [sample(2).at.isoformat()]
    finally:
        buffer.close()


def test_a_revoked_token_keeps_samples(tmp_path: Path) -> None:
    buffer = DiskBuffer(tmp_path / "b.sqlite")
    tiles = FlakyTiles()
    tiles.errors = [RejectedError("Tiles answered 401: Unknown or revoked agent token", 401)]
    forwarder = Forwarder(buffer, tiles)
    try:
        buffer.put(sample(0))
        assert forwarder.send_once() == 0
        assert len(buffer) == 1  # kept: a new token will send them
        assert "revoked" in forwarder.status()["problem"]
    finally:
        buffer.close()
