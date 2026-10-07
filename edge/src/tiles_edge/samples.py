"""Readings from connectors, and where they wait to be sent to Tiles.

Until the store-and-forward buffer (T2.04) and the ingest endpoint (T2.06)
exist, samples wait in a bounded memory buffer that drops the oldest when
full and counts what it dropped. Connectors only see the `SampleSink`
protocol, so the disk buffer can replace it without touching them.
"""

import threading
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Protocol

Quality = Literal["good", "uncertain", "bad"]
Value = float | int | bool | str


@dataclass(frozen=True)
class Sample:
    signal: str  # the Tiles signal ID
    at: datetime  # when the source measured it (UTC)
    value: Value
    quality: Quality


class SampleSink(Protocol):
    def put(self, sample: Sample) -> None: ...


class MemoryBuffer:
    """Thread-safe, bounded: when full, the oldest sample makes room and is counted as dropped."""

    def __init__(self, capacity: int = 100_000) -> None:
        self._samples: deque[Sample] = deque(maxlen=capacity)
        self._lock = threading.Lock()
        self.dropped = 0

    def put(self, sample: Sample) -> None:
        with self._lock:
            if len(self._samples) == self._samples.maxlen:
                self.dropped += 1
            self._samples.append(sample)

    def take(self, limit: int | None = None) -> list[Sample]:
        """Removes and returns up to `limit` samples, oldest first."""
        with self._lock:
            n = len(self._samples) if limit is None else min(limit, len(self._samples))
            return [self._samples.popleft() for _ in range(n)]

    def __len__(self) -> int:
        with self._lock:
            return len(self._samples)
