"""Readings from connectors, and where they wait to be sent to Tiles.

Connectors only see the `SampleSink` protocol. `tiles-edge run` gives them the
disk buffer (buffer.py); `tiles-edge check` gives them a `MemoryBuffer`, which
holds samples in memory, bounded, counting what it dropped. Connectors that
poll (SQL) also save their position with the samples (`StateSink`).
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


class StateSink(SampleSink, Protocol):
    def put_many(self, samples: list[Sample], *, state: tuple[str, str] | None = None) -> None:
        """Stores the samples and the (key, value) position together. Raises if it can't."""
        ...

    def state(self, key: str) -> str | None: ...


class MemoryBuffer:
    """Thread-safe, bounded: when full, the oldest sample makes room and is counted as dropped."""

    def __init__(self, capacity: int = 100_000) -> None:
        self._samples: deque[Sample] = deque(maxlen=capacity)
        self._lock = threading.Lock()
        self.dropped = 0
        self._state: dict[str, str] = {}

    def put(self, sample: Sample) -> None:
        with self._lock:
            if len(self._samples) == self._samples.maxlen:
                self.dropped += 1
            self._samples.append(sample)

    def put_many(self, samples: list[Sample], *, state: tuple[str, str] | None = None) -> None:
        for sample in samples:
            self.put(sample)
        if state is not None:
            with self._lock:
                self._state[state[0]] = state[1]

    def state(self, key: str) -> str | None:
        with self._lock:
            return self._state.get(key)

    def take(self, limit: int | None = None) -> list[Sample]:
        """Removes and returns up to `limit` samples, oldest first."""
        with self._lock:
            n = len(self._samples) if limit is None else min(limit, len(self._samples))
            return [self._samples.popleft() for _ in range(n)]

    def __len__(self) -> int:
        with self._lock:
            return len(self._samples)
