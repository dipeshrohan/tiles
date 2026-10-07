"""Store and forward (T2.04): samples wait on disk until Tiles has them, so a network cut loses nothing.

Connectors put samples into a SQLite file (WAL mode, one row per sample, in
arrival order). The forwarder sends the oldest ones in batches and deletes a
batch only once Tiles has accepted it, so a crash or a cut between sending
and deleting means the batch goes again (at least once; Tiles keeps one copy
per signal and time). The file survives restarts. It is bounded: when it holds
`max_samples`, the oldest make room and are counted as dropped, so a very long
outage loses its oldest data rather than filling the disk.

The file holds plant data, so it is created readable by the agent's user only
(SQLite gives its -wal and -shm files the same mode).
"""

import json
import logging
import os
import sqlite3
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from tiles_edge.samples import Sample

log = logging.getLogger("tiles_edge.buffer")

SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
    seq     INTEGER PRIMARY KEY AUTOINCREMENT,
    signal  TEXT NOT NULL,
    at_us   INTEGER NOT NULL,  -- microseconds since the epoch, UTC
    value   TEXT NOT NULL,     -- JSON: a number, true/false or text
    quality TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
-- Where connectors that poll (SQL) got to, saved with the samples they read.
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


class BufferError(Exception):
    """The buffer file can't be opened or written. The message says where and why."""


@dataclass(frozen=True)
class Queued:
    seq: int
    sample: Sample


def _us(at: datetime) -> int:
    return round(at.timestamp() * 1_000_000)


class DiskBuffer:
    """Thread-safe: connectors put from their own threads while the forwarder takes and acks."""

    def __init__(self, path: Path, max_samples: int = 20_000_000) -> None:
        self.path = path
        self.max_samples = max_samples
        try:
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.close(os.open(path, os.O_CREAT | os.O_WRONLY, 0o600))
            os.chmod(path, 0o600)  # also an older file made with a looser umask
            self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
            self._db.execute("PRAGMA journal_mode=WAL")
            # NORMAL: each commit is safe from an agent crash; a power cut may lose the last
            # moments, which is the usual trade for WAL and keeps writes fast.
            self._db.execute("PRAGMA synchronous=NORMAL")
            self._db.executescript(SCHEMA)
        except (sqlite3.Error, OSError) as e:
            raise BufferError(f"can't open the buffer {path}: {e}") from None
        self._lock = threading.Lock()
        # Rows the forwarder has taken but Tiles hasn't answered for yet (seq <= _in_flight). If a
        # full buffer evicts some of them meanwhile, they count as sent, rejected or dropped by
        # how that batch ends, not as dropped straight away.
        self._in_flight = 0
        self._evicted_in_flight = 0
        # Readings that couldn't be written (disk full, I/O error): counted, and the reason kept.
        self.lost = 0
        self.write_problem = ""
        self._count: int = int(self._db.execute("SELECT count(*) FROM samples").fetchone()[0])

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def _add_counter(self, name: str, by: int) -> None:
        self._db.execute(
            "INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = value + ?",
            (name, by, by),
        )

    def counter(self, name: str) -> int:
        with self._lock:
            row = self._db.execute("SELECT value FROM counters WHERE name = ?", (name,)).fetchone()
        return int(row[0]) if row else 0

    def put(self, sample: Sample) -> None:
        """The connectors' sink. Never raises into their protocol callbacks: a reading that can't
        be written is counted as lost and the reason shows in the heartbeat until a write works."""
        try:
            self.put_many([sample])
        except BufferError as e:
            with self._lock:
                self.lost += 1
                first = not self.write_problem
                self.write_problem = str(e)
            if first:
                log.error("readings are being lost", extra={"error": str(e)})
            return
        if self.write_problem:
            with self._lock:
                self.write_problem = ""
            log.info("the buffer is writable again", extra={"lost": self.lost})

    def _settle_in_flight(self, outcome: str) -> None:
        if self._evicted_in_flight:
            self._add_counter(outcome, self._evicted_in_flight)
        self._in_flight = self._evicted_in_flight = 0

    def state(self, key: str) -> str | None:
        with self._lock:
            row = self._db.execute("SELECT value FROM state WHERE key = ?", (key,)).fetchone()
        return str(row[0]) if row else None

    def put_many(self, samples: list[Sample], *, state: tuple[str, str] | None = None) -> None:
        """Stores the samples and, in the same transaction, `state` (key, value): a polling
        connector's position, so after a crash it neither skips nor rereads what it stored."""
        if not samples and state is None:
            return
        rows = [(s.signal, _us(s.at), json.dumps(s.value), s.quality) for s in samples]
        with self._lock:
            try:
                self._db.execute("BEGIN IMMEDIATE")
                if state is not None:
                    self._db.execute(
                        "INSERT INTO state (key, value) VALUES (?, ?)"
                        " ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                        state,
                    )
                self._db.executemany("INSERT INTO samples (signal, at_us, value, quality) VALUES (?, ?, ?, ?)", rows)
                self._count += len(rows)
                over = self._count - self.max_samples
                in_flight = 0
                if over > 0:  # full: the oldest make room
                    in_flight = self._db.execute(
                        "SELECT count(*) FROM (SELECT seq FROM samples ORDER BY seq LIMIT ?) WHERE seq <= ?",
                        (over, self._in_flight),
                    ).fetchone()[0]
                    self._db.execute(
                        "DELETE FROM samples WHERE seq IN (SELECT seq FROM samples ORDER BY seq LIMIT ?)", (over,)
                    )
                    self._add_counter("dropped", over - in_flight)
                    self._count -= over
                self._db.execute("COMMIT")
                self._evicted_in_flight += in_flight
            except sqlite3.Error as e:
                if self._db.in_transaction:
                    self._db.execute("ROLLBACK")
                self._count = int(self._db.execute("SELECT count(*) FROM samples").fetchone()[0])
                raise BufferError(f"can't write to the buffer {self.path}: {e}") from None

    def oldest(self, limit: int) -> list[Queued]:
        """Up to `limit` samples, oldest first; they stay until acked. A batch taken earlier and
        neither acked nor rejected went nowhere."""
        with self._lock:
            self._settle_in_flight("dropped")
            rows = self._db.execute(
                "SELECT seq, signal, at_us, value, quality FROM samples ORDER BY seq LIMIT ?", (limit,)
            ).fetchall()
            self._in_flight = rows[-1][0] if rows else 0
        return [
            Queued(seq, Sample(signal, datetime.fromtimestamp(at_us / 1_000_000, UTC), json.loads(value), quality))
            for seq, signal, at_us, value, quality in rows
        ]

    def ack(self, up_to_seq: int) -> None:
        """Tiles has everything up to and including `up_to_seq`: forget it."""
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            deleted = self._db.execute("DELETE FROM samples WHERE seq <= ?", (up_to_seq,)).rowcount
            self._add_counter("sent", deleted)
            self._settle_in_flight("sent")
            self._db.execute("COMMIT")
            self._count -= deleted

    def reject(self, up_to_seq: int) -> None:
        """Tiles refused these for good (a bad batch): set them aside so the rest can go. Counted."""
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            deleted = self._db.execute("DELETE FROM samples WHERE seq <= ?", (up_to_seq,)).rowcount
            self._add_counter("rejected", deleted)
            self._settle_in_flight("rejected")
            self._db.execute("COMMIT")
            self._count -= deleted

    def __len__(self) -> int:
        with self._lock:
            return self._count

    def oldest_time(self) -> datetime | None:
        with self._lock:
            row = self._db.execute("SELECT at_us FROM samples ORDER BY seq LIMIT 1").fetchone()
        return datetime.fromtimestamp(row[0] / 1_000_000, UTC) if row else None
