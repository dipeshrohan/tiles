"""The detection job (T3.04): feeds each detector the new readings of its signal and records the
warnings it raises (`tiles-detect`, e.g. every minute from cron, or a detector's "run now").

A detector reads past its `done_until`, up to `lateness_s` before now (readings
that may still arrive late are left for the next run), in batches; its state is
saved with it, so runs pick up where the last one stopped. A warning is written
when it opens and updated while it lasts: its last reading, peak, how many
readings were out, and when the signal came back. A new one that is recent
queues its notifications (notify.py).
"""

import argparse
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from psycopg import sql
from psycopg.types.json import Jsonb

from tiles_api import jobs, notify, telemetry
from tiles_api.detection import Alert, Config, State, step
from tiles_api.store import Conn, one

WORK = 5_000_000  # readings x window per batch: each reading costs about its window's size
MAX_BATCHES = 40  # per run, so one detector can't hold the job forever


def batch_size(window: int) -> int:
    """Readings per batch: fewer for a larger window, so a batch takes about the same time."""
    return max(1_000, min(50_000, WORK // window))


@dataclass
class RunResult:
    readings: int = 0
    opened: int = 0
    notified: int = 0  # messages queued about warnings raised
    closed: int = 0
    done_until: datetime | None = None
    caught_up: bool = True


def _save(conn: Conn, detector: dict[str, Any], warnings: list[Alert]) -> dict[int, uuid.UUID]:
    """Writes the warnings; their ids, by id() of the Alert."""
    ids: dict[int, uuid.UUID] = {}
    for w in warnings:
        row = conn.execute(
            """
            INSERT INTO warnings (site_id, detector_id, signal_id, started_at, last_at, ended_at, side, peak,
                                  baseline, threshold, readings)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (detector_id, started_at) DO UPDATE
            SET last_at = EXCLUDED.last_at, ended_at = EXCLUDED.ended_at, peak = EXCLUDED.peak,
                readings = EXCLUDED.readings
            RETURNING id
            """,
            [
                detector["site_id"],
                detector["id"],
                detector["signal_id"],
                w.started_at,
                w.last_at,
                w.ended_at,
                w.side,
                w.peak,
                w.baseline,
                w.threshold,
                w.readings,
            ],
        ).fetchone()
        ids[id(w)] = one(row)["id"]
    return ids


def run(conn: Conn, detector_id: uuid.UUID, batches: int = MAX_BATCHES) -> RunResult:
    """Runs a detector on its new readings (at most `batches` batches) and saves its state."""
    detector = conn.execute("SELECT * FROM detectors WHERE id = %s FOR UPDATE", [detector_id]).fetchone()
    if detector is None:
        raise LookupError("No such detector")
    now: datetime = conn.execute("SELECT now() AS now").fetchone()["now"]  # type: ignore[index]
    until = now - timedelta(seconds=detector["lateness_s"])
    config = Config(**detector["config"])
    state = State.from_json(detector["state"])
    result = RunResult(done_until=detector["done_until"])
    size = batch_size(config.window)
    for batch in range(batches):
        # No placeholder for a missing bound, so the planner can skip older chunks.
        since = sql.SQL("AND at > %s") if result.done_until is not None else sql.SQL("")
        query = sql.SQL(
            "SELECT at, value FROM site_samples WHERE signal_id = %s AND value IS NOT NULL AND at <= %s {since}"
            " ORDER BY at LIMIT %s"
        ).format(since=since)
        bound = [result.done_until] if result.done_until is not None else []
        rows = conn.execute(query, [detector["signal_id"], until, *bound, size]).fetchall()
        if not rows:
            break
        closed, opened = step(config, state, [(r["at"], r["value"]) for r in rows])
        touched = {id(w): w for w in [*opened, *closed, *([state.open] if state.open else [])]}
        ids = _save(conn, detector, list(touched.values()))
        for w in opened:
            lateness = timedelta(seconds=detector["lateness_s"])
            result.notified += notify.queue_raised(conn, ids[id(w)], w.started_at, now, lateness)
        result.readings += len(rows)
        result.opened += len(opened)
        result.closed += len(closed)
        result.done_until = rows[-1]["at"]
        if len(rows) < size:
            break
        if batch == batches - 1:  # stopped at the limit: is anything left?
            more = conn.execute(
                "SELECT 1 FROM site_samples WHERE signal_id = %s AND value IS NOT NULL AND at > %s AND at <= %s"
                " LIMIT 1",
                [detector["signal_id"], result.done_until, until],
            ).fetchone()
            result.caught_up = more is None
    conn.execute(
        """
        UPDATE detectors SET state = %s, done_until = %s, last_run_at = %s, last_readings = %s WHERE id = %s
        """,
        [Jsonb(state.as_json()), result.done_until, now, result.readings, detector_id],
    )
    return result


def due(conn: Conn, site_id: uuid.UUID | None = None) -> list[uuid.UUID]:
    """The enabled detectors (of one site, if given), oldest first."""
    return jobs.enabled(conn, "detectors", site_id)


@telemetry.job_main("tiles-detect")
def main(argv: list[str] | None = None) -> None:
    """`tiles-detect`: runs every enabled detector on its new readings, e.g. every minute from cron."""
    parser = argparse.ArgumentParser(prog="tiles-detect", description=main.__doc__)
    parser.add_argument("--site", type=uuid.UUID, help="only this site's detectors (its id)")
    args = parser.parse_args(argv)

    def run_one(conn: Conn, detector: uuid.UUID) -> tuple[str, bool]:
        r = run(conn, detector)
        return f"{r.readings} reading(s), {r.opened} warning(s) raised, {r.closed} ended", True

    jobs.run_each(lambda conn: due(conn, args.site), run_one)
