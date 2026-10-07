"""Sends buffered samples to Tiles (T2.04): oldest first, in batches, acknowledged before they're forgotten."""

import logging
import random
import threading
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Protocol

from tiles_edge.buffer import DiskBuffer
from tiles_edge.client import RejectedError, TransientError

log = logging.getLogger("tiles_edge.forwarder")

PATH = "/agent/samples"


class Poster(Protocol):
    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]: ...


class Forwarder:
    """One thread. While Tiles is away, samples keep piling up in the buffer; once it answers again,
    the backlog goes out oldest first, as fast as Tiles accepts batches."""

    def __init__(
        self,
        buffer: DiskBuffer,
        client: Poster,
        *,
        batch_size: int = 5000,
        max_retry_seconds: float = 60,
        idle_seconds: float = 1,
        jitter: Callable[[], float] = random.random,
    ) -> None:
        self.buffer = buffer
        self.client = client
        self.batch_size = batch_size
        self.max_retry_seconds = max_retry_seconds
        self.idle_seconds = idle_seconds
        self.jitter = jitter
        self.stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._failures = 0
        self._problem = ""  # why the last batch didn't go, if it didn't
        self._lock = threading.Lock()

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="forwarder", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 10) -> None:
        self.stop_event.set()
        if self._thread:
            self._thread.join(timeout)

    def status(self) -> dict[str, Any]:
        """For the heartbeat."""
        oldest = self.buffer.oldest_time()
        with self._lock:
            problem = self._problem
        return {
            "queued": len(self.buffer),
            "oldest_at": oldest.isoformat() if oldest else None,
            "sent": self.buffer.counter("sent"),
            "dropped": self.buffer.counter("dropped"),
            "rejected": self.buffer.counter("rejected"),
            "problem": problem[:300],
        }

    def _wait(self) -> None:
        delay = min(2.0 ** min(self._failures - 1, 10), self.max_retry_seconds)
        self.stop_event.wait(delay * (0.5 + self.jitter() / 2))

    def _set_problem(self, problem: str) -> None:
        with self._lock:
            changed = self._problem != problem
            self._problem = problem
        if changed and problem:
            log.warning("samples are waiting", extra={"problem": problem, "queued": len(self.buffer)})

    def send_once(self) -> int:
        """Sends one batch. Returns how many samples went (0 when there was nothing, or it failed)."""
        batch = self.buffer.oldest(self.batch_size)
        if not batch:
            return 0
        body = {
            "samples": [
                {
                    "signal": q.sample.signal,
                    "at": q.sample.at.isoformat(),
                    "value": q.sample.value,
                    "quality": q.sample.quality,
                }
                for q in batch
            ]
        }
        try:
            self.client.post(PATH, body)
        except TransientError as e:
            self._failures += 1
            self._set_problem(str(e))
            return 0
        except RejectedError as e:
            self._failures += 1
            if e.status in (400, 413, 422):
                # Tiles can't take this batch as it is, and never will: set it aside rather than
                # block everything behind it. It is counted (and logged) as rejected.
                self.buffer.reject(batch[-1].seq)
                log.error("Tiles rejected a batch of samples", extra={"error": str(e), "samples": len(batch)})
                self._set_problem(f"a batch of {len(batch)} samples was rejected: {e}")
                return 0
            if e.status == 404:
                self._set_problem("Tiles doesn't accept samples yet (no ingest endpoint); keeping them")
            else:  # 401/403: the heartbeat reports the token problem; keep the samples meanwhile
                self._set_problem(str(e))
            return 0
        self.buffer.ack(batch[-1].seq)
        self._failures = 0
        self._set_problem("")
        return len(batch)

    def _run(self) -> None:
        while not self.stop_event.is_set():
            try:
                sent = self.send_once()
            except Exception as e:  # e.g. the disk: never let the thread die
                self._failures += 1
                self._set_problem(f"{type(e).__name__}: {e}")
                sent = 0
            if sent:
                continue  # more backlog? go again straight away
            if self._failures:
                self._wait()
            else:
                self.stop_event.wait(self.idle_seconds)
        log.info("forwarder stopped", extra={"queued": len(self.buffer), "at": datetime.now(UTC).isoformat()})
