"""The detection job (T3.04): feeds each detector the new readings of its signal and records the
warnings it raises (`tiles-detect`, e.g. every minute from cron, or a detector's "run now").

A detector reads past its `done_until`, up to `lateness_s` before now (readings
that may still arrive late are left for the next run), in batches; its state is
saved with it, so runs pick up where the last one stopped. A warning is written
when it opens and updated while it lasts: its last reading, peak, how many
readings were out, and when the signal came back.
"""

import argparse
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from tiles_api.detection import Alert, Config, State, step
from tiles_api.settings import get_settings
from tiles_api.store import Conn

BATCH = 50_000  # readings read at a time
MAX_BATCHES = 40  # per run, so one detector can't hold the job forever


@dataclass
class RunResult:
    readings: int = 0
    opened: int = 0
    closed: int = 0
    done_until: datetime | None = None
    caught_up: bool = True


def _save(conn: Conn, detector: dict[str, Any], warnings: list[Alert]) -> None:
    for w in warnings:
        conn.execute(
            """
            INSERT INTO warnings (site_id, detector_id, signal_id, started_at, last_at, ended_at, side, peak,
                                  baseline, threshold, readings)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (detector_id, started_at) DO UPDATE
            SET last_at = EXCLUDED.last_at, ended_at = EXCLUDED.ended_at, peak = EXCLUDED.peak,
                readings = EXCLUDED.readings
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
        )


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
    for batch in range(batches):
        # No placeholder for a missing bound, so the planner can skip older chunks.
        since = sql.SQL("AND at > %s") if result.done_until is not None else sql.SQL("")
        query = sql.SQL(
            "SELECT at, value FROM samples WHERE signal_id = %s AND value IS NOT NULL AND at <= %s {since}"
            " ORDER BY at LIMIT %s"
        ).format(since=since)
        bound = [result.done_until] if result.done_until is not None else []
        rows = conn.execute(query, [detector["signal_id"], until, *bound, BATCH]).fetchall()
        if not rows:
            break
        closed, opened = step(config, state, [(r["at"], r["value"]) for r in rows])
        touched = {id(w): w for w in [*opened, *closed, *([state.open] if state.open else [])]}
        _save(conn, detector, list(touched.values()))
        result.readings += len(rows)
        result.opened += len(opened)
        result.closed += len(closed)
        result.done_until = rows[-1]["at"]
        if len(rows) < BATCH:
            break
        if batch == batches - 1:
            result.caught_up = False
    conn.execute(
        """
        UPDATE detectors SET state = %s, done_until = %s, last_run_at = %s, last_readings = %s WHERE id = %s
        """,
        [Jsonb(state.as_json()), result.done_until, now, result.readings, detector_id],
    )
    return result


def due(conn: Conn, site_id: uuid.UUID | None = None) -> list[uuid.UUID]:
    rows = conn.execute(
        "SELECT id FROM detectors WHERE enabled AND (%s::uuid IS NULL OR site_id = %s) ORDER BY created_at",
        [site_id, site_id],
    ).fetchall()
    return [r["id"] for r in rows]


def main(argv: list[str] | None = None) -> None:
    """`tiles-detect`: runs every enabled detector on its new readings, e.g. every minute from cron."""
    parser = argparse.ArgumentParser(prog="tiles-detect", description=main.__doc__)
    parser.add_argument("--site", type=uuid.UUID, help="only this site's detectors (its id)")
    args = parser.parse_args(argv)
    failed = False
    # Autocommit, so each detector's run is its own transaction: one failing keeps the others'.
    with psycopg.connect(get_settings().database_url, row_factory=dict_row, autocommit=True) as conn:
        for detector in due(conn, args.site):
            try:
                with conn.transaction():
                    r = run(conn, detector)
            except Exception as e:
                failed = True
                print(f"{detector}: not run ({e})", file=sys.stderr)
                continue
            print(f"{detector}: {r.readings} reading(s), {r.opened} warning(s) raised, {r.closed} ended")
    if failed:
        raise SystemExit(1)
