"""Data-quality checks (T2.09): gaps, stuck values, out-of-range values, unit mismatches.

A check looks at a signal's readings over a window (24 hours by default) that
ends at its latest reading, so backfilled history is judged as well as live
data. It finds:

- gaps: steps between readings longer than three expected periods. The period
  is 1 / sample_rate_hz when the catalogue gives one, otherwise the median step
  of a numeric signal (a text or true/false signal without a rate is reported on
  change, so its gaps are not checked);
- stuck values: a numeric value repeated for at least 10 readings and for
  longer than the signal's `stuck_after_s` (one hour by default);
- out-of-range values: numbers outside the signal's expected range, when set;
- readings the source itself marked bad or uncertain (e.g. an OPC UA status);
- a unit that differs from the `unit` of the linked ontology node;
- silence: an edge agent's signal with no reading for three periods (at least
  five minutes) before the check.

Each finding is a warning or a problem, and the signal's badge is the worst of
them: good, warn or bad (unknown when it has no readings). The latest check of
each signal is stored in `signal_quality`; the catalogue shows its badge. Run
checks from the Signals page (`POST /sites/{id}/signals/quality`) or on a
schedule with `tiles-check-quality`.
"""

import argparse
import math
import sys
import uuid
from datetime import UTC, datetime
from typing import Any, Literal, LiteralString

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import BaseModel

from tiles_api.settings import get_settings

Badge = Literal["good", "warn", "bad", "unknown"]
Check = Literal["gaps", "stuck", "range", "source", "unit", "silent"]

DEFAULT_HOURS = 24.0
STUCK_AFTER_S = 3600.0  # when the signal doesn't set its own
STUCK_MIN_READINGS = 10
GAP_PERIODS = 3  # a step longer than this many periods is a gap
SILENT_MIN_S = 300.0
BAD_COVERAGE = 0.9  # below this share of the time covered, gaps are a problem
BAD_SHARE = 0.05  # above this share of readings out of range or marked bad, a problem


class Issue(BaseModel):
    check: Check
    severity: Literal["warn", "bad"]
    message: str


class Report(BaseModel):
    badge: Badge
    checked_at: datetime
    window_hours: float
    first_at: datetime | None  # the readings checked
    last_at: datetime | None
    readings: int
    period_s: float | None  # the expected step between readings
    coverage: float | None  # share of the time between first_at and last_at without gaps
    gaps: int
    longest_gap_s: float | None
    stuck_runs: int
    longest_stuck_s: float | None
    out_of_range: int
    source_flagged: int  # readings the source marked bad or uncertain
    issues: list[Issue]


# One statement per signal: readings in the window, steps between them, runs of one value.
STATS: LiteralString = """
WITH last AS (SELECT max(at) AS at FROM samples WHERE signal_id = %(id)s),
s AS (
    SELECT x.at, x.value, x.quality,
           extract(epoch FROM x.at - lag(x.at) OVER w)::float8 AS step,
           (x.value, x.value_text, x.value_bool)
             IS DISTINCT FROM (lag(x.value) OVER w, lag(x.value_text) OVER w, lag(x.value_bool) OVER w) AS changed
    FROM samples x, last
    WHERE x.signal_id = %(id)s AND x.at > last.at - %(window_s)s::float8 * interval '1 second' AND x.at <= last.at
    WINDOW w AS (ORDER BY x.at)
),
p AS (
    SELECT coalesce(
        %(period)s::float8,
        CASE WHEN count(value) * 2 > count(*) THEN percentile_cont(0.5) WITHIN GROUP (ORDER BY step) END
    ) AS period
    FROM s
),
runs AS (
    SELECT min(at) AS from_at, extract(epoch FROM max(at) - min(at))::float8 AS seconds, count(*) AS n,
           min(value) AS value
    FROM (SELECT at, value, sum(changed::int) OVER (ORDER BY at) AS run FROM s) r
    GROUP BY run
    HAVING count(value) = count(*)
),
stuck AS (
    SELECT * FROM runs WHERE n >= %(stuck_n)s AND seconds >= %(stuck_s)s::float8
),
gaps AS (
    SELECT s.step, p.period FROM s, p WHERE p.period > 0 AND s.step > %(gap_periods)s * p.period
)
SELECT
    (SELECT count(*) FROM s) AS readings,
    (SELECT min(at) FROM s) AS first_at,
    (SELECT max(at) FROM s) AS last_at,
    (SELECT period FROM p) AS period,
    (SELECT count(*) FROM gaps) AS gaps,
    (SELECT max(step) FROM gaps) AS longest_gap,
    (SELECT coalesce(sum(step - period), 0) FROM gaps) AS missing,
    (SELECT count(value) FROM s) AS numeric,
    (SELECT count(*) FROM s WHERE value < %(range_min)s::float8 OR value > %(range_max)s::float8) AS out_of_range,
    (SELECT count(*) FROM s WHERE quality <> 'good') AS flagged,
    (SELECT count(*) FROM stuck) AS stuck_runs,
    (SELECT row_to_json(t) FROM (SELECT * FROM stuck ORDER BY seconds DESC LIMIT 1) t) AS longest_stuck
"""

SIGNAL: LiteralString = """
SELECT g.id, g.site_id, g.tag, g.unit, g.sample_rate_hz, g.source, g.range_min, g.range_max, g.stuck_after_s,
       g.node_id, n.label AS node_label, n.props ->> 'unit' AS node_unit
FROM signals g LEFT JOIN ontology_nodes n ON n.site_id = g.site_id AND n.id = g.node_id AND n.type = 'Signal'
"""


def duration(seconds: float) -> str:
    """A length of time as people say it: 45 s, 12 min, 3.5 h, 2.0 d."""
    if seconds < 90:
        return f"{seconds:.3g} s"
    if seconds < 90 * 60:
        return f"{seconds / 60:.0f} min"
    if seconds < 48 * 3600:
        return f"{seconds / 3600:.1f} h"
    return f"{seconds / 86400:.1f} d"


def number(x: float) -> str:
    return f"{x:.6g}"


def percent(share: float) -> str:
    """A share as a percentage, rounded down so that one just below a limit doesn't read as on it."""
    return f"{math.floor(share * 1000) / 10:.1f}%"


def same_unit(a: str, b: str) -> bool:
    return a.strip().casefold() == b.strip().casefold()


def assess(signal: dict[str, Any], stats: dict[str, Any], now: datetime, hours: float) -> Report:
    """The report for a signal (a row of SIGNAL) from its window's statistics (a row of STATS)."""
    issues: list[Issue] = []
    unit = signal["unit"]
    suffix = f" {unit}" if unit else ""
    readings: int = stats["readings"]
    period: float | None = stats["period"]

    node_unit = signal["node_unit"]
    if signal["node_id"] and isinstance(node_unit, str) and node_unit.strip():
        node = signal["node_label"] or signal["node_id"]
        if not unit:
            issues.append(
                Issue(check="unit", severity="warn", message=f"No unit set; the ontology node {node} says {node_unit}")
            )
        elif not same_unit(unit, node_unit):
            issues.append(
                Issue(
                    check="unit",
                    severity="bad",
                    message=f"The unit is {unit} but the ontology node {node} says {node_unit}",
                )
            )

    coverage: float | None = None
    longest_stuck: dict[str, Any] | None = stats["longest_stuck"]
    if readings:
        first_at: datetime = stats["first_at"]
        last_at: datetime = stats["last_at"]
        span = (last_at - first_at).total_seconds()
        if span > 0 and period:
            coverage = max(0.0, 1 - stats["missing"] / span)
        if stats["gaps"]:
            issues.append(
                Issue(
                    check="gaps",
                    severity="bad" if coverage is not None and coverage < BAD_COVERAGE else "warn",
                    message=f"{stats['gaps']} gap(s) longer than {duration(GAP_PERIODS * (period or 0))}; "
                    f"the longest {duration(stats['longest_gap'])}"
                    + (f"; {percent(coverage)} of the time covered" if coverage is not None else ""),
                )
            )
        if longest_stuck:
            since = datetime.fromisoformat(longest_stuck["from_at"]).astimezone(UTC)
            issues.append(
                Issue(
                    check="stuck",
                    severity="warn",
                    message=f"Stuck at {number(longest_stuck['value'])}{suffix} for "
                    f"{duration(longest_stuck['seconds'])} ({longest_stuck['n']} readings) from "
                    f"{since.isoformat(timespec='seconds')}"
                    + (f"; {stats['stuck_runs']} stuck runs in all" if stats["stuck_runs"] > 1 else ""),
                )
            )
        if stats["out_of_range"]:
            low, high = signal["range_min"], signal["range_max"]
            bounds = (
                f"{number(low)} to {number(high)}{suffix}"
                if low is not None and high is not None
                else f"at least {number(low)}{suffix}"
                if low is not None
                else f"at most {number(high)}{suffix}"
            )
            issues.append(
                Issue(
                    check="range",
                    severity="bad" if stats["out_of_range"] > BAD_SHARE * stats["numeric"] else "warn",
                    message=f"{stats['out_of_range']} of {stats['numeric']} readings outside the expected range "
                    f"({bounds})",
                )
            )
        if stats["flagged"]:
            issues.append(
                Issue(
                    check="source",
                    severity="bad" if stats["flagged"] > BAD_SHARE * readings else "warn",
                    message=f"{stats['flagged']} of {readings} readings marked bad or uncertain by the source",
                )
            )
        quiet = (now - last_at).total_seconds()
        # Without a period (a text or true/false tag sent on change) quiet is normal: not checked.
        if signal["source"].startswith("edge:") and period and quiet > max(SILENT_MIN_S, GAP_PERIODS * period):
            issues.append(
                Issue(
                    check="silent",
                    severity="bad",
                    message=f"No reading for {duration(quiet)}; the edge agent's connection to this tag may be down",
                )
            )

    if any(i.severity == "bad" for i in issues):
        badge: Badge = "bad"
    elif issues:
        badge = "warn"
    else:
        badge = "good" if readings else "unknown"
    return Report(
        badge=badge,
        checked_at=now,
        window_hours=hours,
        first_at=stats["first_at"],
        last_at=stats["last_at"],
        readings=readings,
        period_s=period,
        coverage=coverage,
        gaps=stats["gaps"],
        longest_gap_s=stats["longest_gap"],
        stuck_runs=stats["stuck_runs"],
        longest_stuck_s=longest_stuck["seconds"] if longest_stuck else None,
        out_of_range=stats["out_of_range"],
        source_flagged=stats["flagged"],
        issues=issues,
    )


def check_signal(conn: Any, signal: dict[str, Any], now: datetime, hours: float = DEFAULT_HOURS) -> Report:
    """Checks one signal (a row of SIGNAL) and stores the report as its latest."""
    rate = signal["sample_rate_hz"]
    stats = conn.execute(
        STATS,
        {
            "id": signal["id"],
            "window_s": hours * 3600,
            "period": 1 / rate if rate else None,
            "stuck_n": STUCK_MIN_READINGS,
            "stuck_s": signal["stuck_after_s"] or STUCK_AFTER_S,
            "gap_periods": GAP_PERIODS,
            "range_min": signal["range_min"],
            "range_max": signal["range_max"],
        },
    ).fetchone()
    report = assess(signal, stats, now, hours)
    conn.execute(
        """
        INSERT INTO signal_quality (signal_id, site_id, badge, checked_at, report) VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (signal_id) DO UPDATE
        SET badge = EXCLUDED.badge, checked_at = EXCLUDED.checked_at, report = EXCLUDED.report
        """,
        [signal["id"], signal["site_id"], report.badge, now, Jsonb(report.model_dump(mode="json"))],
    )
    return report


def check_site(
    conn: Any, site_id: Any, signal_ids: list[uuid.UUID] | None = None, hours: float = DEFAULT_HOURS
) -> dict[str, int]:
    """Checks a site's signals (all, or those given) and returns how many got each badge."""
    now: datetime = conn.execute("SELECT clock_timestamp() AS now").fetchone()["now"]
    counts = {"good": 0, "warn": 0, "bad": 0, "unknown": 0}
    ids = conn.execute(
        "SELECT id FROM signals WHERE site_id = %s AND (%s::uuid[] IS NULL OR id = ANY(%s::uuid[])) ORDER BY tag",
        [site_id, signal_ids, signal_ids],
    ).fetchall()
    for row in ids:
        # Each signal is read locked, as an edit locks it: an edit made meanwhile waits, then checks again
        # with its new settings, rather than this report (from the old ones) landing after it.
        signal = conn.execute(SIGNAL + " WHERE g.id = %s FOR UPDATE OF g", [row["id"]]).fetchone()
        if signal is not None:
            counts[check_signal(conn, signal, now, hours).badge] += 1
    return counts


def main(argv: list[str] | None = None) -> None:
    """`tiles-check-quality`: checks every signal of every site (or one site), e.g. from cron."""
    parser = argparse.ArgumentParser(prog="tiles-check-quality", description=main.__doc__)
    parser.add_argument("--site", type=uuid.UUID, help="only this site (its id)")
    parser.add_argument("--hours", type=float, default=DEFAULT_HOURS, help="the window to check (default 24)")
    args = parser.parse_args(argv)
    if not (math.isfinite(args.hours) and 0 < args.hours <= 720):
        parser.error("--hours must be above 0 and at most 720")
    failed = False
    # Autocommit, so each site's checks are their own transaction: one site failing keeps the others'.
    with psycopg.connect(get_settings().database_url, row_factory=dict_row, autocommit=True) as conn:
        sites = [args.site] if args.site else [r["id"] for r in conn.execute("SELECT id FROM sites ORDER BY slug")]
        for site in sites:
            try:
                with conn.transaction():
                    counts = check_site(conn, site, hours=args.hours)
            except psycopg.Error as e:
                failed = True
                print(f"{site}: not checked ({e})", file=sys.stderr)
                continue
            print(f"{site}: " + ", ".join(f"{n} {badge}" for badge, n in counts.items()))
    if failed:
        raise SystemExit(1)
