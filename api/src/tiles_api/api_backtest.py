"""The backtest over HTTP and as a report (T3.05): replay a signal's stored history through detectors
with each combination of the given settings, and score their warnings against the events given
(backtest.py). It changes nothing but takes seconds of work, so engineers run it, two at a time.

`tiles-backtest` writes the same backtest as a Markdown report, for a machine's events in a CSV
file (columns `at`, an ISO 8601 time with its offset, and optionally `code`).
"""

import argparse
import csv
import sys
import threading
import uuid
from dataclasses import asdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Annotated, Any, Literal

import psycopg
from fastapi import APIRouter, HTTPException, status
from psycopg import sql
from psycopg.rows import dict_row
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError

from tiles_api import backtest
from tiles_api.api_ontology import Editor
from tiles_api.backtest import Event, Outcome
from tiles_api.settings import get_settings
from tiles_api.store import UNSCOPED, Conn

router = APIRouter(tags=["detection"])

MAX_EVENTS = 1_000
RUNNING = threading.BoundedSemaphore(2)  # backtests at once, so they can't take every worker
Values = Field(min_length=1, max_length=8)  # values to try for one setting


class EventIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    at: AwareDatetime
    code: Annotated[str, Field(max_length=100)] = ""


class BacktestIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    signal_id: uuid.UUID
    start: AwareDatetime | None = None  # the history to replay (default: all of it)
    end: AwareDatetime | None = None
    events: Annotated[list[EventIn], Field(max_length=MAX_EVENTS)]
    horizon_seconds: Annotated[float, Field(gt=0, le=90 * 86400)]  # how long before an event a warning counts
    # The values to try for each detection setting (detection.Config); every combination is tried.
    window: Annotated[list[Annotated[int, Field(ge=10, le=2_000)]], Values] = [200]
    k: Annotated[list[Annotated[float, Field(gt=0, le=50)]], Values] = [4.0]
    persist: Annotated[list[Annotated[int, Field(ge=1, le=10_000)]], Values] = [3]
    direction: Annotated[list[Literal["above", "below", "both"]], Values] = ["above"]
    cooldown: Annotated[list[Annotated[int, Field(ge=0, le=1_000_000)]], Values] = [0]
    flat_spread: Annotated[list[Annotated[float, Field(gt=0, le=1e12)]], Values] = [1.0]


class SpreadOut(BaseModel):
    count: int
    min: float
    p10: float
    median: float
    p90: float
    max: float


class EventOut(BaseModel):
    at: datetime
    code: str
    warned_at: datetime | None
    warning_seconds: float | None


class SettingOut(BaseModel):
    config: dict[str, Any]
    warnings: int
    true_warnings: int
    false_warnings: int
    pending_warnings: int
    caught: int
    recall: float | None
    precision: float | None
    false_per_day: float | None
    warning_seconds: SpreadOut | None
    events: list[EventOut]


class BacktestOut(BaseModel):
    signal_tag: str
    readings: int
    first_at: datetime | None
    last_at: datetime | None
    settings: list[SettingOut]  # best first
    report: str  # Markdown


def run_backtest(conn: Conn, site_id: uuid.UUID, body: BacktestIn) -> dict[str, Any]:
    """Runs the backtest; ValueError if the signal isn't the site's or it would be too big."""
    signal = conn.execute(
        "SELECT tag FROM signals WHERE site_id = %s AND id = %s", [site_id, body.signal_id]
    ).fetchone()
    if signal is None:
        raise ValueError("Not a signal of this site")
    if body.start and body.end and body.start >= body.end:
        raise ValueError("The start must be before the end")
    configs = backtest.settings(body.window, body.k, body.persist, body.direction, body.cooldown, body.flat_spread)
    backtest.check_size(0, configs)
    most = backtest.max_readings(configs)
    # No placeholder for a missing bound, so the planner can skip the chunks outside the period.
    bounds = [(sql.SQL("AND at >= %s"), body.start), (sql.SQL("AND at < %s"), body.end)]
    given = [(clause, value) for clause, value in bounds if value is not None]
    query = sql.SQL(
        "SELECT at, value FROM site_samples WHERE signal_id = %s AND value IS NOT NULL {} ORDER BY at LIMIT %s"
    ).format(sql.SQL(" ").join(clause for clause, _ in given))
    rows = conn.execute(query, [body.signal_id, *(value for _, value in given), most + 1]).fetchall()
    if len(rows) > most:
        raise ValueError(
            f"More than {most} readings with {len(configs)} setting(s): choose a shorter period or fewer settings"
        )
    times = [r["at"] for r in rows]
    events = [Event(e.at, e.code) for e in body.events]
    horizon = timedelta(seconds=body.horizon_seconds)
    outcomes = backtest.ranked(backtest.replay(times, [r["value"] for r in rows], events, configs, horizon))
    about = {
        "Signal": signal["tag"],
        "History": f"{times[0].isoformat()} to {times[-1].isoformat()}, {len(rows)} readings" if rows else "none",
        "Events": len(events),
    }
    return {
        "signal_tag": signal["tag"],
        "readings": len(rows),
        "first_at": times[0] if rows else None,
        "last_at": times[-1] if rows else None,
        "settings": [_setting(o) for o in outcomes],
        "report": backtest.report(f"Backtest: {signal['tag']}", about, outcomes, horizon),
    }


def _setting(o: Outcome) -> dict[str, Any]:
    w = o.warning_times
    return {
        "config": o.config.as_json(),
        "warnings": len(o.alerts),
        "true_warnings": o.true_warnings,
        "false_warnings": o.false_warnings,
        "pending_warnings": o.pending_warnings,
        "caught": o.caught,
        "recall": o.recall,
        "precision": o.precision,
        "false_per_day": o.false_per_day,
        "warning_seconds": None if w is None else asdict(w),
        "events": [
            {
                "at": e.event.at,
                "code": e.event.code,
                "warned_at": e.warned_at,
                "warning_seconds": None if e.warning_time is None else e.warning_time.total_seconds(),
            }
            for e in o.events
        ],
    }


@router.post("/sites/{site_id}/backtest", response_model=BacktestOut)
def run(ctx: Editor, body: BacktestIn) -> dict[str, Any]:
    """Replay a signal's history with each combination of detection settings and score the warnings
    against the events given: recall, precision, false warnings per day and warning time, best first."""
    if not RUNNING.acquire(blocking=False):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Other backtests are running: try again shortly")
    try:
        out = run_backtest(ctx.conn, ctx.site_id, body)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    finally:
        RUNNING.release()
    after = {"readings": out["readings"], "settings": len(out["settings"]), "events": len(body.events)}
    ctx.audit("backtest.run", "signal", str(body.signal_id), after=after)
    return out


def read_events(path: Path) -> list[dict[str, str]]:
    """The events in a CSV file with an `at` column and optionally a `code` one."""
    with path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if "at" not in (reader.fieldnames or []):
            raise ValueError(f"{path}: needs an 'at' column")
        return [{"at": row["at"], "code": row.get("code") or ""} for row in reader if row["at"].strip()]


def _list(kind: type[float] | type[int]) -> Any:
    return lambda text: [kind(v) for v in text.split(",")]


def main(argv: list[str] | None = None) -> None:
    """`tiles-backtest`: backtest detection settings on a signal's history and write the report."""
    parser = argparse.ArgumentParser(prog="tiles-backtest", description=main.__doc__)
    parser.add_argument("--site", type=uuid.UUID, required=True, help="the site (its id)")
    parser.add_argument("--signal", required=True, help="the signal's tag")
    parser.add_argument("--events", type=Path, required=True, help="CSV of events: at (with offset), code")
    parser.add_argument("--horizon-hours", type=float, required=True, help="how long before an event a warning counts")
    parser.add_argument("--start", help="replay from (ISO 8601 with offset; default: all history)")
    parser.add_argument("--end", help="replay until")
    parser.add_argument("--window", type=_list(int), default=[200], help="baseline sizes to try, e.g. 100,200")
    parser.add_argument("--k", type=_list(float), default=[4.0], help="spreads to try, e.g. 3,4,5")
    parser.add_argument("--persist", type=_list(int), default=[3], help="readings in a row to try, e.g. 1,3")
    parser.add_argument("--direction", type=lambda t: t.split(","), default=["above"], help="above, below, both")
    parser.add_argument("--cooldown", type=_list(int), default=[0], help="readings after a warning, e.g. 0,50")
    parser.add_argument("--flat-spread", type=_list(float), default=[1.0], help="a flat baseline's spread, e.g. 0.5,1")
    parser.add_argument("--out", type=Path, help="write the report here (default: print it)")
    args = parser.parse_args(argv)
    try:
        events = read_events(args.events)
    except (OSError, ValueError) as e:
        parser.error(str(e))
    settings = get_settings()
    with psycopg.connect(settings.database_url, row_factory=dict_row, options=UNSCOPED) as conn:
        signal = conn.execute(
            "SELECT id FROM signals WHERE site_id = %s AND tag = %s", [args.site, args.signal]
        ).fetchone()
        if signal is None:
            parser.error(f"no signal {args.signal} at site {args.site}")
        try:
            body = BacktestIn.model_validate(
                {
                    "signal_id": signal["id"],
                    "start": args.start,
                    "end": args.end,
                    "events": events,
                    "horizon_seconds": args.horizon_hours * 3600,
                    "window": args.window,
                    "k": args.k,
                    "persist": args.persist,
                    "direction": args.direction,
                    "cooldown": args.cooldown,
                    "flat_spread": args.flat_spread,
                }
            )
            result = run_backtest(conn, args.site, body)
        except ValidationError as e:
            parser.error("; ".join(f"{'.'.join(map(str, err['loc']))}: {err['msg']}" for err in e.errors()))
        except ValueError as e:
            parser.error(str(e))
    if args.out:
        args.out.write_text(result["report"], encoding="utf-8")
        best = result["settings"][0]
        print(f"{args.out}: {len(result['settings'])} setting(s); best warned of {best['caught']} event(s)")
    else:
        sys.stdout.write(result["report"])
