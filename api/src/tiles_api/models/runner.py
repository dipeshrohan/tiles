"""The model runner (T3.03): runs bound models on new data windows and writes what they
compute back to the samples hypertable, as derived signals.

A binding (table `model_bindings`) feeds each model input from one of the site's
signals, or `@time` (seconds since the window began). The readings of the input
signals are joined on their timestamps and cut into windows: where the readings
pause for longer than `window_s` (a shot, a batch), or every `window_s` seconds.
Only complete windows run, those followed by more data or older than `window_s`,
so a shot still being recorded waits for the next run. Per-sample outputs are
written at each sample's time, per-window outputs at the window's last reading.
Writes skip readings already stored, so running again is harmless; `done_until`
moves past each window run, so each run takes only new data.
"""

import argparse
import math
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

import psycopg
from psycopg import sql
from psycopg.rows import dict_row, tuple_row

from tiles_api.models.registry import Model, ModelError, evaluate, registry
from tiles_api.settings import get_settings
from tiles_api.store import Conn

TIME = "@time"  # an input fed with seconds since the window began
MAX_ROWS = 100_000  # joined readings read per batch; a run reads batches until caught up
MAX_BATCHES = 50  # per run, so one binding can't hold the runner forever

WindowKind = Literal["gap", "fixed"]


@dataclass
class RunResult:
    windows: int = 0
    written: int = 0
    done_until: datetime | None = None
    error: str | None = None


def cut(times: list[datetime], kind: WindowKind, size_s: float) -> list[tuple[int, int]]:
    """Index ranges [start, end) of the windows in `times` (sorted)."""
    if not times:
        return []
    out: list[tuple[int, int]] = []
    start = 0
    for i in range(1, len(times)):
        if kind == "gap":
            new = (times[i] - times[i - 1]).total_seconds() > size_s
        else:
            new = _bucket(times[i], size_s) != _bucket(times[start], size_s)
        if new:
            out.append((start, i))
            start = i
    out.append((start, len(times)))
    return out


def _bucket(t: datetime, size_s: float) -> int:
    return math.floor(t.timestamp() / size_s)


def complete(window_last: datetime, is_last: bool, kind: WindowKind, size_s: float, now: datetime) -> bool:
    """A window is complete once later data follows it, or once no reading can still join it."""
    if not is_last:
        return True
    if kind == "gap":
        return (now - window_last).total_seconds() > size_s
    return now >= datetime.fromtimestamp((_bucket(window_last, size_s) + 1) * size_s, tz=window_last.tzinfo)


def _read(conn: Conn, inputs: dict[str, str], after: datetime | None, limit: int) -> list[tuple[Any, ...]]:
    """Readings of the input signals joined on their timestamps: (at, value per signal input)."""
    signals = [(name, sig) for name, sig in inputs.items() if sig != TIME]
    first = signals[0][1]
    joins = sql.SQL(" ").join(
        sql.SQL("JOIN samples {a} ON {a}.signal_id = {sig} AND {a}.at = s0.at AND {a}.value IS NOT NULL").format(
            a=sql.Identifier(f"s{i}"), sig=sql.Literal(sig)
        )
        for i, (_, sig) in enumerate(signals[1:], 1)
    )
    columns = sql.SQL(", ").join(sql.SQL("{}.value").format(sql.Identifier(f"s{i}")) for i in range(len(signals)))
    query = sql.SQL(
        "SELECT s0.at, {columns} FROM samples s0 {joins} "
        "WHERE s0.signal_id = %s AND s0.value IS NOT NULL AND (%s::timestamptz IS NULL OR s0.at > %s) "
        "ORDER BY s0.at LIMIT %s"
    ).format(columns=columns, joins=joins)
    cur = conn.cursor(row_factory=tuple_row)  # plain tuples, whatever the connection's rows
    return list(cur.execute(query, [first, after, after, limit]))


def run_binding(conn: Conn, binding: dict[str, Any], model: Model, now: datetime) -> RunResult:
    """Runs one binding on its new complete windows (the caller holds its row lock)."""
    inputs: dict[str, str] = binding["inputs"]
    outputs: dict[str, str] = binding["outputs"]
    kind: WindowKind = binding["window_kind"]
    size: float = binding["window_s"]
    names = [name for name, sig in inputs.items() if sig != TIME]
    result = RunResult(done_until=binding["done_until"])
    per = {p.name: p.per for p in model.spec.outputs}
    for _ in range(MAX_BATCHES):
        rows = _read(conn, inputs, result.done_until, MAX_ROWS)
        if not rows:
            break
        times: list[datetime] = [r[0] for r in rows]
        windows = cut(times, kind, size)
        full = len(rows) == MAX_ROWS
        if full and len(windows) > 1:
            windows = windows[:-1]  # it may go on past this batch: the next batch reads it whole
        written: list[tuple[str, datetime, float]] = []
        ran = 0
        for n, (start, end) in enumerate(windows):
            last = n == len(windows) - 1
            if not complete(times[end - 1], last and not full, kind, size, now):
                break
            series: dict[str, list[float]] = {name: [r[i + 1] for r in rows[start:end]] for i, name in enumerate(names)}
            for name, sig in inputs.items():
                if sig == TIME:
                    series[name] = [(t - times[start]).total_seconds() for t in times[start:end]]
            try:
                out = evaluate(model, series, binding["params"])
            except ModelError as e:
                result.error = f"window ending {times[end - 1].isoformat()}: {e}"
            else:
                for port, values in out.items():
                    signal = outputs[port]
                    if per[port] == "window":
                        if values[0] is not None:
                            written.append((signal, times[end - 1], values[0]))
                    else:
                        written.extend(
                            (signal, t, v) for t, v in zip(times[start:end], values, strict=True) if v is not None
                        )
            ran += 1
            result.done_until = times[end - 1]
        result.windows += ran
        result.written += _write(conn, written)
        if not ran or not full:
            break
    return result


def _write(conn: Conn, readings: list[tuple[str, datetime, float]]) -> int:
    if not readings:
        return 0
    stored = 0
    for i in range(0, len(readings), 10_000):
        chunk = readings[i : i + 10_000]
        cur = conn.execute(
            """
            INSERT INTO samples (signal_id, at, value)
            SELECT * FROM unnest(%s::uuid[], %s::timestamptz[], %s::float8[])
            ON CONFLICT (signal_id, at) DO NOTHING
            """,
            [[uuid.UUID(s) for s, _, _ in chunk], [t for _, t, _ in chunk], [v for _, _, v in chunk]],
        )
        stored += cur.rowcount
    return stored


def run(conn: Conn, binding_id: uuid.UUID) -> RunResult:
    """Runs a binding now: locks it, runs its new windows and records the outcome."""
    binding = conn.execute(
        """
        SELECT b.*, m.key AS model_key, m.version AS model_version FROM model_bindings b
        JOIN models m ON m.id = b.model_id WHERE b.id = %s FOR UPDATE OF b
        """,
        [binding_id],
    ).fetchone()
    if binding is None:
        raise LookupError("No such binding")
    now: datetime = conn.execute("SELECT now() AS now").fetchone()["now"]  # type: ignore[index]
    try:
        model = registry.get(binding["model_key"], binding["model_version"])
    except KeyError:
        result = RunResult(done_until=binding["done_until"], error="the model version is no longer registered")
    else:
        result = run_binding(conn, binding, model, now)
    conn.execute(
        """
        UPDATE model_bindings SET done_until = %s, last_run_at = %s, last_windows = %s, last_error = %s
        WHERE id = %s
        """,
        [result.done_until, now, result.windows, result.error, binding_id],
    )
    return result


def due(conn: Conn, site_id: uuid.UUID | None = None) -> list[uuid.UUID]:
    """The enabled bindings (of one site, if given), oldest first."""
    rows = conn.execute(
        "SELECT id FROM model_bindings WHERE enabled AND (%s::uuid IS NULL OR site_id = %s) ORDER BY created_at",
        [site_id, site_id],
    ).fetchall()
    return [r["id"] for r in rows]


def main(argv: list[str] | None = None) -> None:
    """`tiles-run-models`: runs every enabled model binding on its new data, e.g. from cron."""
    parser = argparse.ArgumentParser(prog="tiles-run-models", description=main.__doc__)
    parser.add_argument("--site", type=uuid.UUID, help="only this site's bindings (its id)")
    args = parser.parse_args(argv)
    failed = False
    # Autocommit, so each binding's run is its own transaction: one failing keeps the others'.
    with psycopg.connect(get_settings().database_url, row_factory=dict_row, autocommit=True) as conn:
        for binding in due(conn, args.site):
            try:
                with conn.transaction():
                    result = run(conn, binding)
            except psycopg.Error as e:
                failed = True
                print(f"{binding}: not run ({e})", file=sys.stderr)
                continue
            line = f"{binding}: {result.windows} window(s), {result.written} reading(s) written"
            print(line + (f"; {result.error}" if result.error else ""))
            failed = failed or result.error is not None
    if failed:
        raise SystemExit(1)
