"""Parameter sweeps as background jobs (T4.12): a design model version over a grid of one or two
parameters (`x`, and `y` if given), the other parameters held, as the Design Studio's heatmap.

A sweep is a `sweeps` row (migration 0023). `run` claims a queued sweep (or one whose worker went
quiet), evaluates the grid in chunks of `CHUNK` points, and after each chunk saves its progress,
checks whether it was cancelled, and renews its heartbeat; at the end the grid is kept as its
result. The API runs a sweep in the background after taking it, and `tiles-run-sweeps` (from cron)
picks up any left queued, for example by a restart.

A point the model can't run (an arithmetic error) is null in the grid. An identical sweep (model
version, every parameter, both axes) is not run again: the API answers with the result kept.
"""

import hashlib
import json
import math
import sys
import uuid
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from tiles_api.models.registry import Model, registry
from tiles_api.settings import get_settings
from tiles_api.store import Conn

MAX_STEPS = 200  # on one axis
MAX_POINTS = 40_000  # in one sweep
CHUNK = 500  # points between progress reports
STALE_SECONDS = 120  # a running sweep without a heartbeat for this long is taken up again

Connect = Callable[[], AbstractContextManager[Conn]]


def values(axis: dict[str, Any]) -> list[float]:
    """An axis's points, `steps` of them evenly from `from` to `to`."""
    lo, hi, n = float(axis["from"]), float(axis["to"]), int(axis["steps"])
    return [lo + (hi - lo) * i / (n - 1) for i in range(n)] if n > 1 else [lo]


def cache_key(model: Model, params: dict[str, float], x: dict[str, Any], y: dict[str, Any] | None) -> str:
    body = {"model": model.spec.key, "version": model.spec.version, "params": params, "x": x, "y": y}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _points(x: dict[str, Any], y: dict[str, Any] | None) -> Iterator[tuple[int, int, dict[str, float]]]:
    xs, ys = values(x), values(y) if y else [0.0]
    for j, yv in enumerate(ys):
        for i, xv in enumerate(xs):
            yield j, i, ({x["param"]: xv} | ({y["param"]: yv} if y else {}))


def _value(model: Model, params: dict[str, float]) -> float | None:
    try:
        out = model.run({}, params)
    except (ArithmeticError, ValueError):
        return None
    first = next(iter(out.values()), [None])
    v = first[0] if first else None
    return v if v is not None and math.isfinite(v) else None


CLAIM = """
UPDATE sweeps SET status = 'running', started_at = coalesce(started_at, now()), heartbeat_at = now()
WHERE id = (
    SELECT id FROM sweeps
    WHERE (%(id)s::uuid IS NULL OR id = %(id)s)
      AND (status = 'queued' OR (status = 'running' AND heartbeat_at < now() - %(stale)s * interval '1 second'))
    ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
)
RETURNING id, model_key, version, params, x, y, total, cancel_requested
"""


def run(connect: Connect, sweep_id: uuid.UUID | None = None) -> tuple[uuid.UUID, str] | None:
    """Claims and runs a sweep (this one, or the oldest waiting); its id and how it ended, or None
    if there was nothing to run. Each chunk is its own short transaction."""
    with connect() as conn:
        row = conn.execute(CLAIM, {"id": sweep_id, "stale": STALE_SECONDS}).fetchone()
    if row is None:
        return None
    sid = row["id"]
    try:
        model = registry.get(row["model_key"], row["version"])
        x, y = row["x"], row["y"]
        xs, ys = values(x), values(y) if y else [0.0]
        grid: list[list[float | None]] = [[None] * len(xs) for _ in ys]
        for done, (j, i, at) in enumerate(_points(x, y), 1):
            grid[j][i] = _value(model, row["params"] | at)
            if done % CHUNK == 0 or done == row["total"]:
                with connect() as conn:
                    status = conn.execute(
                        "UPDATE sweeps SET done = %s, heartbeat_at = now() WHERE id = %s RETURNING cancel_requested",
                        [done, sid],
                    ).fetchone()
                if status is None:
                    return sid, "gone"
                if status["cancel_requested"] and done < row["total"]:
                    with connect() as conn:
                        conn.execute("UPDATE sweeps SET status = 'cancelled', finished_at = now() WHERE id = %s", [sid])
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
            conn.execute(
                "UPDATE sweeps SET status = 'done', done = total, result = %s, finished_at = now() WHERE id = %s",
                [Jsonb(result), sid],
            )
        return sid, "done"
    except Exception as e:  # the sweep fails, saying why; the worker goes on
        with connect() as conn:
            conn.execute(
                "UPDATE sweeps SET status = 'failed', error = %s, finished_at = now() WHERE id = %s",
                [str(e)[:500] or type(e).__name__, sid],
            )
        return sid, "failed"


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
