"""The agent's main loop: a heartbeat every `heartbeat_seconds`, backing off while Tiles is unreachable."""

import logging
import random
import socket
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from tiles_edge import __version__
from tiles_edge.client import RejectedError, TransientError
from tiles_edge.config import Config

log = logging.getLogger("tiles_edge")

MAX_BACKOFF_SECONDS = 300


class Poster(Protocol):
    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]: ...


@dataclass
class Agent:
    config: Config
    client: Poster
    stop: threading.Event = field(default_factory=threading.Event)
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    hostname: str = field(default_factory=socket.gethostname)
    jitter: Callable[[], float] = random.random

    def heartbeat(self) -> dict[str, Any]:
        """Sends one heartbeat. Raises TransientError or RejectedError."""
        return self.client.post(
            "/agent/heartbeat",
            {
                "version": __version__,
                "hostname": self.hostname,
                "started_at": self.started_at.isoformat(),
                "heartbeat_seconds": self.config.heartbeat_seconds,
                # Connectors (OPC UA, MQTT, SQL) report here from T2.02 on.
                "connectors": [],
            },
        )

    def backoff(self, failures: int) -> float:
        """Seconds to wait after `failures` failed heartbeats in a row: doubling from 1 s, at most
        MAX_BACKOFF_SECONDS, never longer than the heartbeat itself, with jitter so a plant full of
        agents doesn't retry in step."""
        ceiling = min(2.0 ** (failures - 1), MAX_BACKOFF_SECONDS, self.config.heartbeat_seconds)
        return ceiling * (0.5 + self.jitter() / 2)

    def run(self) -> int:
        """Runs until stopped (exit code 0) or Tiles rejects the agent (exit code 3)."""
        log.info("agent started", extra={"tiles_url": self.config.url, "version": __version__})
        failures = 0
        while not self.stop.is_set():
            try:
                answer = self.heartbeat()
            except RejectedError as e:
                log.error("Tiles rejected this agent; check its token or register it again", extra={"error": str(e)})
                return 3
            except TransientError as e:
                failures += 1
                wait = self.backoff(failures)
                log.warning("heartbeat failed", extra={"error": str(e), "failures": failures, "retry_in_s": wait})
                self.stop.wait(wait)
                continue
            if failures:
                log.info("connected to Tiles again", extra={"after_failures": failures})
            failures = 0
            log.debug("heartbeat", extra={"agent_id": answer.get("agent_id"), "server_time": answer.get("server_time")})
            self.stop.wait(self.config.heartbeat_seconds)
        log.info("agent stopped")
        return 0
