"""Parameter sweeps as background jobs (T4.12): a design model version over a grid of one or two
parameters (`x`, and `y` if given), the other parameters held, as the Design Studio's heatmap.

A sweep is a `sweeps` row (migration 0023). `run` claims a queued sweep (or one whose worker went
quiet), with a token of its own: only the run holding it writes the sweep's progress and result,
so a sweep taken up again can't be finished twice. It evaluates the grid in chunks of `CHUNK`
points; after each it saves its progress, renews its heartbeat and stops if the sweep was
cancelled (also after the last chunk: a cancelled sweep keeps no result). The API drains the queue
in the background after taking a sweep, at most `API_WORKERS` at a time so sweeps don't take the
threads that answer requests, and `tiles-run-sweeps` (from cron) picks up any left waiting.

Each point runs through the registry's checks (`evaluate`); a point the model refuses or can't run
is null in the grid. An identical sweep (model version, the parameters held, both axes) is not run
again: the API answers with the result kept.
"""

import hashlib
import json
import sys
import threading
import uuid
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from tiles_api.models.registry import Model, ModelError, evaluate, registry
from tiles_api.settings import get_settings
from tiles_api.store import Conn

MAX_STEPS = 200  # on one axis
MAX_POINTS = 40_000  # in one sweep
CHUNK = 500  # points between progress reports
STALE_SECONDS = 120  # a running sweep without a heartbeat for this long is taken up again
API_WORKERS = 2  # sweeps run at once in the API's own threads

Connect = Callable[[], AbstractContextManager[Conn]]


def values(axis: dict[str, Any]) -> list[float]:
    """An axis's points, `steps` of them evenly from `from` to `to`."""
    lo, hi, n = float(axis["from"]), float(axis["to"]), int(axis["steps"])
    return [lo + (hi - lo) * i / (n - 1) for i in range(n)] if n > 1 else [lo]


def cache_key(model: Model, params: dict[str, float], x: dict[str, Any], y: dict[str, Any] | None) -> str:
    """What makes two sweeps the same: the model version, the parameters held (not the swept ones,
    which the grid sets) and the axes, numbers compared as numbers (0 and 0.0 alike)."""
    swept = {x["param"]} | ({y["param"]} if y else set())
    held = {k: float(v) for k, v in params.items() if k not in swept}

    def axis(a: dict[str, Any] | None) -> list[Any] | None:
        return [a["param"], float(a["from"]), float(a["to"]), int(a["steps"])] if a else None

    body = {"model": model.spec.key, "version": model.spec.version, "held": held, "x": axis(x), "y": axis(y)}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _points(x: dict[str, Any], y: dict[str, Any] | None) -> Iterator[tuple[int, int, dict[str, float]]]:
    xs, ys = values(x), values(y) if y else [0.0]
    for j, yv in enumerate(ys):
        for i, xv in enumerate(xs):
            yield j, i, ({x["param"]: xv} | ({y["param"]: yv} if y else {}))


def _value(model: Model, params: dict[str, float]) -> float | None:
    """One point, as a run computes it; None where the model refuses the point or can't run it."""
    try:
        out = evaluate(model, {}, params)
    except (ModelError, ArithmeticError):
        return None
    first = next(iter(out.values()), [])
    return first[0] if first else None


# Cancelled sweeps whose worker went quiet are ended, not run again.
END_ABANDONED = """
UPDATE sweeps SET status = 'cancelled', finished_at = now(), worker = NULL
WHERE status = 'running' AND cancel_requested AND heartbeat_at < now() - %(stale)s * interval '1 second'
"""

CLAIM = """
UPDATE sweeps SET status = 'running', started_at = coalesce(started_at, now()), heartbeat_at = now(),
                  done = 0, worker = %(worker)s
WHERE id = (
    SELECT id FROM sweeps
    WHERE (%(id)s::uuid IS NULL OR id = %(id)s) AND NOT cancel_requested
      AND (status = 'queued' OR (status = 'running' AND heartbeat_at < now() - %(stale)s * interval '1 second'))
    ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
)
RETURNING id, model_key, version, params, x, y, total
"""


def run(connect: Connect, sweep_id: uuid.UUID | None = None) -> tuple[uuid.UUID, str] | None:
    """Claims and runs a sweep (this one, or the oldest waiting); its id and how it ended ("done",
    "cancelled", "failed", or "taken" when another run took it over), or None if there was
    nothing to run. Each chunk is its own short transaction."""
    worker = uuid.uuid4()
    with connect() as conn:
        conn.execute(END_ABANDONED, {"stale": STALE_SECONDS})
        row = conn.execute(CLAIM, {"id": sweep_id, "stale": STALE_SECONDS, "worker": worker}).fetchone()
    if row is None:
        return None
    sid = row["id"]

    def mine(conn: Conn, sql: str, args: list[Any]) -> dict[str, Any] | None:
        """Runs an update of this sweep while this run still holds it."""
        result: dict[str, Any] | None = conn.execute(
            sql + " AND worker = %s RETURNING cancel_requested", [*args, sid, worker]
        ).fetchone()
        return result

    try:
        model = registry.get(row["model_key"], row["version"])
        x, y = row["x"], row["y"]
        xs, ys = values(x), values(y) if y else [0.0]
        grid: list[list[float | None]] = [[None] * len(xs) for _ in ys]
        for done, (j, i, at) in enumerate(_points(x, y), 1):
            grid[j][i] = _value(model, row["params"] | at)
            if done % CHUNK == 0 or done == row["total"]:
                with connect() as conn:
                    status = mine(conn, "UPDATE sweeps SET done = %s, heartbeat_at = now() WHERE id = %s", [done])
                if status is None:
                    return sid, "taken"
                if status["cancel_requested"]:
                    with connect() as conn:
                        mine(conn, "UPDATE sweeps SET status = 'cancelled', finished_at = now() WHERE id = %s", [])
                    return sid, "cancelled"
        found = [v for r in grid for v in r if v is not None]
        output = model.spec.outputs[0]
        result = {
            "output": output.name,
            "unit": output.unit,
            "x": {"param": x["param"], "values": xs},
            "y": {"param": y["param"], "values": ys} if y else None,
            "grid": grid,
            "min": min(found) if found else None,
            "max": max(found) if found else None,
        }
        with connect() as conn:
            saved = mine(
                conn,
                "UPDATE sweeps SET status = 'done', done = total, result = %s, finished_at = now()"
                " WHERE NOT cancel_requested AND id = %s",
                [Jsonb(result)],
            )
            if saved is not None:
                return sid, "done"
            ended = mine(  # cancelled at the very end, or else taken over
                conn,
                "UPDATE sweeps SET status = 'cancelled', finished_at = now() WHERE cancel_requested AND id = %s",
                [],
            )
        return sid, "cancelled" if ended else "taken"
    except Exception as e:  # the sweep fails, saying why; the worker goes on
        with connect() as conn:
            mine(
                conn,
                "UPDATE sweeps SET status = 'failed', error = %s, finished_at = now() WHERE id = %s",
                [str(e)[:500] or type(e).__name__],
            )
        return sid, "failed"


_api_workers = threading.BoundedSemaphore(API_WORKERS)


def drain(connect: Connect) -> None:
    """Runs waiting sweeps until there are none, unless `API_WORKERS` runs are already at it (they
    will take this one too): what the API does in the background after taking a sweep."""
    if not _api_workers.acquire(blocking=False):
        return
    try:
        while run(connect) is not None:
            pass
    finally:
        _api_workers.release()


def main() -> None:
    """tiles-run-sweeps: runs every waiting sweep (queued, or left running by a worker that went
    quiet), oldest first; the exit code is 1 if one failed."""
    url = get_settings().database_url

    def connect() -> AbstractContextManager[Conn]:
        return psycopg.connect(url, row_factory=dict_row, autocommit=False)

    failed = False
    while (ran := run(connect)) is not None:
        sid, how = ran
        print(f"{sid}: {how}")
        failed = failed or how == "failed"
    if failed:
        sys.exit(1)
