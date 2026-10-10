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
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from psycopg import sql
from psycopg.rows import tuple_row

from tiles_api import jobs, telemetry
from tiles_api.models import store
from tiles_api.models.registry import Model, evaluate
from tiles_api.models.remote import HttpModel, RemoteError
from tiles_api.settings import Settings, get_settings
from tiles_api.store import Conn

TIME = "@time"  # an input fed with seconds since the window began
MAX_ROWS = 100_000  # joined readings read per batch; a run reads batches until caught up
MAX_BATCHES = 50  # per run, so one binding can't hold the runner forever
# Windows a model served over HTTP (T4.15) runs per run, one call each: the job's, and "run now"'s,
# which a person waits for. The rest wait for the next run.
REMOTE_WINDOWS = 500
REMOTE_WINDOWS_NOW = 20

WindowKind = Literal["gap", "fixed"]


@dataclass
class RunResult:
    windows: int = 0  # windows run (including those the model refused)
    failed: int = 0  # windows the model refused: skipped, the first reason in `error`
    written: int = 0
    done_until: datetime | None = None
    error: str | None = None
    caught_up: bool = True  # False: stopped at the batch limit with more to run

    def note(self, problem: str) -> None:
        self.error = self.error or problem


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


def complete(
    window_last: datetime, is_last: bool, kind: WindowKind, size_s: float, now: datetime, lateness_s: float = 0
) -> bool:
    """A window is complete once later data follows it, or once no reading can still join it,
    allowing `lateness_s` for readings that arrive late (an edge agent's backlog)."""
    if not is_last:
        return True
    if kind == "gap":
        return (now - window_last).total_seconds() > size_s + lateness_s
    end = (_bucket(window_last, size_s) + 1) * size_s
    return now.timestamp() >= end + lateness_s


def _read(
    conn: Conn, inputs: dict[str, str], after: datetime | None, limit: int, align_s: float = 0
) -> list[tuple[Any, ...]]:
    """Readings of the input signals joined on time: (at, value per signal input), on the first
    signal's clock. With `align_s` 0, the other signals need a reading at the same instant; above
    0, each takes its latest reading at most `align_s` seconds before."""
    signals = [sig for sig in inputs.values() if sig != TIME]
    joins = []
    for i, sig in enumerate(signals[1:], 1):
        a = sql.Identifier(f"s{i}")
        if align_s > 0:
            joins.append(
                sql.SQL(
                    "JOIN LATERAL (SELECT value FROM site_samples x WHERE x.signal_id = {sig} AND x.value IS NOT NULL"
                    " AND x.at <= s0.at AND x.at >= s0.at - make_interval(secs => {align})"
                    " ORDER BY x.at DESC LIMIT 1) {a} ON true"
                ).format(sig=sql.Literal(sig), align=sql.Literal(align_s), a=a)
            )
        else:
            joins.append(
                sql.SQL(
                    "JOIN site_samples {a} ON {a}.signal_id = {sig} AND {a}.at = s0.at AND {a}.value IS NOT NULL"
                ).format(a=a, sig=sql.Literal(sig))
            )
    columns = sql.SQL(", ").join(sql.SQL("{}.value").format(sql.Identifier(f"s{i}")) for i in range(len(signals)))
    # Without a placeholder for a missing bound, so the planner can skip older chunks.
    since = sql.SQL("AND s0.at > %s") if after is not None else sql.SQL("")
    query = sql.SQL(
        "SELECT s0.at, {columns} FROM site_samples s0 {joins} WHERE s0.signal_id = %s AND s0.value IS NOT NULL {since} "
        "ORDER BY s0.at LIMIT %s"
    ).format(columns=columns, joins=sql.SQL(" ").join(joins), since=since)
    params: list[Any] = [signals[0], *([after] if after is not None else []), limit]
    cur = conn.cursor(row_factory=tuple_row)  # plain tuples, whatever the connection's rows
    return list(cur.execute(query, params))


def _first_reading_after(conn: Conn, signal: str, after: datetime | None) -> bool:
    since = sql.SQL("AND at > %s") if after is not None else sql.SQL("")
    query = sql.SQL("SELECT 1 FROM site_samples WHERE signal_id = %s AND value IS NOT NULL {since} LIMIT 1").format(
        since=since
    )
    return conn.execute(query, [signal, *([after] if after is not None else [])]).fetchone() is not None


def run_binding(
    conn: Conn,
    binding: dict[str, Any],
    model: Model,
    now: datetime,
    batches: int = MAX_BATCHES,
    remote_windows: int = REMOTE_WINDOWS,
) -> RunResult:
    """Runs one binding on its new complete windows (the caller holds its row lock); at most
    `remote_windows` of them for a model served over HTTP."""
    inputs: dict[str, str] = binding["inputs"]
    outputs: dict[str, str] = binding["outputs"]
    kind: WindowKind = binding["window_kind"]
    size: float = binding["window_s"]
    lateness: float = binding.get("lateness_s", 0)
    align: float = binding.get("align_s", 0)
    names = [name for name, sig in inputs.items() if sig != TIME]
    result = RunResult(done_until=binding["done_until"])
    per = {p.name: p.per for p in model.spec.outputs}
    calls_left = remote_windows if isinstance(model, HttpModel) else None
    for batch in range(batches):
        rows = _read(conn, inputs, result.done_until, MAX_ROWS, align)
        if not rows:
            first = next(sig for sig in inputs.values() if sig != TIME)
            if len(names) > 1 and _first_reading_after(conn, first, result.done_until):
                result.note(
                    "the input signals have no readings at the same instants: "
                    + ("widen align_seconds" if align else "set align_seconds to join readings a little apart")
                )
            break
        times: list[datetime] = [r[0] for r in rows]
        windows = cut(times, kind, size)
        full = len(rows) == MAX_ROWS
        if full:
            if len(windows) == 1:
                # One window larger than a batch can't be run whole: stop here rather than run pieces.
                result.note(f"a window has more than {MAX_ROWS} readings: use shorter windows")
                break
            windows = windows[:-1]  # it may go on past this batch: the next batch reads it whole
        written: list[tuple[str, datetime, float]] = []
        ran = 0
        stopped = False
        for n, (start, end) in enumerate(windows):
            last = n == len(windows) - 1
            if not complete(times[end - 1], last and not full, kind, size, now, lateness):
                break
            if calls_left is not None:
                if calls_left == 0:
                    stopped = True
                    result.caught_up = False
                    break
                calls_left -= 1
            series: dict[str, list[float]] = {name: [r[i + 1] for r in rows[start:end]] for i, name in enumerate(names)}
            for name, sig in inputs.items():
                if sig == TIME:
                    series[name] = [(t - times[start]).total_seconds() for t in times[start:end]]
            try:
                out = evaluate(model, series, binding["params"])
            except RemoteError as e:
                if not e.retry:  # the endpoint refused this window: skipped, like a built-in model's refusal
                    result.failed += 1
                    result.note(f"window ending {times[end - 1].isoformat()}: {e}")
                else:  # the endpoint failed, not the window (T4.15): stop, and run it next time
                    result.error = f"stopped at the window ending {times[end - 1].isoformat()}: {e}"
                    result.caught_up = False
                    stopped = True
                    break
            except Exception as e:
                result.failed += 1
                result.note(f"window ending {times[end - 1].isoformat()}: {e}")
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
        if stopped or not ran or not full:
            break
        if batch == batches - 1:
            result.caught_up = False
    return result


def _write(conn: Conn, readings: list[tuple[str, datetime, float]]) -> int:
    if not readings:
        return 0
    stored = 0
    for i in range(0, len(readings), 10_000):
        chunk = readings[i : i + 10_000]
        n = len(chunk)
        row = conn.execute(  # through tiles_store_samples (row security, T5.04)
            "SELECT tiles_store_samples(%s::uuid[], %s::timestamptz[], %s::float8[], %s::text[], %s::bool[],"
            " %s::text[]) AS n",
            [
                [uuid.UUID(s) for s, _, _ in chunk],
                [t for _, t, _ in chunk],
                [v for _, _, v in chunk],
                [None] * n,
                [None] * n,
                ["good"] * n,
            ],
        ).fetchone()
        stored += int(row["n"]) if row else 0
    return stored


def run(
    conn: Conn,
    binding_id: uuid.UUID,
    batches: int = MAX_BATCHES,
    settings: Settings | None = None,
    remote_windows: int = REMOTE_WINDOWS,
) -> RunResult:
    """Runs a binding now: locks it, runs its new windows (at most `batches` batches, and
    `remote_windows` windows of a model served over HTTP) and records the outcome. `settings` (the
    environment's when not given) reach a model served over HTTP; an archived one keeps running."""
    binding = conn.execute(
        """
        SELECT b.*, m.key AS model_key, m.version AS model_version, m.org_id AS model_org FROM model_bindings b
        JOIN models m ON m.id = b.model_id WHERE b.id = %s FOR UPDATE OF b
        """,
        [binding_id],
    ).fetchone()
    if binding is None:
        raise LookupError("No such binding")
    now: datetime = conn.execute("SELECT now() AS now").fetchone()["now"]  # type: ignore[index]
    try:
        model = store.find(
            conn,
            binding["model_org"],
            settings or get_settings(),
            binding["model_key"],
            binding["model_version"],
            archived=True,
        )
    except KeyError:
        result = RunResult(done_until=binding["done_until"], error="the model version is no longer registered")
    else:
        result = run_binding(conn, binding, model, now, batches, remote_windows)
    conn.execute(
        """
        UPDATE model_bindings SET done_until = %s, last_run_at = %s, last_windows = %s, last_failed = %s,
               last_error = %s
        WHERE id = %s
        """,
        [result.done_until, now, result.windows, result.failed, result.error, binding_id],
    )
    return result


def due(conn: Conn, site_id: uuid.UUID | None = None) -> list[uuid.UUID]:
    """The enabled bindings (of one site, if given), oldest first."""
    return jobs.enabled(conn, "model_bindings", site_id)


@telemetry.job_main("tiles-run-models")
def main(argv: list[str] | None = None) -> None:
    """`tiles-run-models`: runs every enabled model binding on its new data, e.g. from cron."""
    parser = argparse.ArgumentParser(prog="tiles-run-models", description=main.__doc__)
    parser.add_argument("--site", type=uuid.UUID, help="only this site's bindings (its id)")
    args = parser.parse_args(argv)

    def run_one(conn: Conn, binding: uuid.UUID) -> tuple[str, bool]:
        r = run(conn, binding)
        line = f"{r.windows} window(s), {r.failed} refused, {r.written} reading(s) written"
        return line + (f"; {r.error}" if r.error else ""), r.error is None

    jobs.run_each(lambda conn: due(conn, args.site), run_one)
