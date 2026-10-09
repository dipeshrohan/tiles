"""How the warnings did (T3.10): each detector's real warnings scored against its asset's events,
the same way the backtest scores a replay (backtest.score), and what people said of them.

An event is a reading on an event signal (signals.event_kind) with an asset, in the period. A
reading of 0 or false is not an event (a scrap count of nothing). The code is its text, or its
number. A detector's warnings count for its asset's events; an asset with several detectors
counts an event caught when any of them warned, for the totals. Events of assets no detector
watches are counted apart (`unwatched`): no detector could have caught them.

Each detector is scored over the part of the period it judged: from its signal's first reading
to where its runs got to (`done_until`); events outside that couldn't have been warned of, so
they aren't counted. Warnings started in the period are counted; one started up to a horizon
before it may still warn of an event in it. A warning whose horizon runs past where the
detector got to is pending, as in the backtest. The site-wide false warnings per day are over
the whole period.
"""

import uuid
from dataclasses import asdict
from datetime import datetime, timedelta
from typing import Any

from tiles_api.backtest import Event, Outcome, score, spread_of
from tiles_api.detection import Alert, Config
from tiles_api.store import Conn

MAX_EVENTS = 20_000  # per period; more and the period is too long to read at once
OUTCOMES = ("true_alarm", "false_alarm", "unknown")


def _alert(w: dict[str, Any]) -> Alert:
    return Alert(
        started_at=w["started_at"],
        last_at=w["last_at"],
        peak=w["peak"],
        baseline=w["baseline"],
        threshold=w["threshold"],
        side=w["side"],
        readings=w["readings"],
    )


def _metrics(o: Outcome) -> dict[str, Any]:
    return {
        "warnings": len(o.alerts),
        "true_warnings": o.true_warnings,
        "false_warnings": o.false_warnings,
        "pending_warnings": o.pending_warnings,
        "events": len(o.events),
        "caught": o.caught,
        "recall": o.recall,
        "precision": o.precision,
        "false_per_day": o.false_per_day,
        "warning_seconds": asdict(o.warning_times) if o.warning_times else None,
    }


def _confirmed(warnings: list[dict[str, Any]]) -> dict[str, int]:
    """What people said the warnings were (T3.07), and how many nobody has resolved yet."""
    counts = {k: 0 for k in (*OUTCOMES, "unresolved")}
    for w in warnings:
        counts[w["outcome"] or "unresolved"] += 1
    return counts


def report(
    conn: Conn, site_id: uuid.UUID, start: datetime, end: datetime, horizon: timedelta, codes: list[str]
) -> dict[str, Any]:
    """The site's warnings and events from `start` to `end`, scored per detector and in total."""
    events = conn.execute(
        """
        SELECT s.at, g.asset, g.event_kind AS kind, g.tag AS signal_tag,
               coalesce(s.value_text, s.value::text, s.value_bool::text) AS code
        FROM site_samples s JOIN signals g ON g.id = s.signal_id
        WHERE g.site_id = %(site)s AND g.event_kind IS NOT NULL AND g.asset IS NOT NULL
          AND s.at >= %(start)s AND s.at <= %(end)s
          AND coalesce(s.value <> 0, s.value_bool, s.value_text <> '')
          AND (cardinality(%(codes)s::text[]) = 0
               OR coalesce(s.value_text, s.value::text, s.value_bool::text) = ANY(%(codes)s::text[]))
        ORDER BY s.at LIMIT %(limit)s
        """,
        {"site": site_id, "start": start, "end": end, "codes": codes, "limit": MAX_EVENTS + 1},
    ).fetchall()
    if len(events) > MAX_EVENTS:
        raise ValueError(f"More than {MAX_EVENTS} events in this period: choose a shorter one, or some codes")
    detectors = conn.execute(
        """
        SELECT d.id, d.name, d.asset, d.config, d.done_until, g.tag AS signal_tag,
               (SELECT min(at) FROM site_samples s WHERE s.signal_id = d.signal_id) AS first_at
        FROM detectors d JOIN signals g ON g.id = d.signal_id WHERE d.site_id = %s ORDER BY d.name
        """,
        [site_id],
    ).fetchall()
    # From a horizon before the period: such a warning may warn of an event in it (it isn't counted).
    warnings = conn.execute(
        """
        SELECT detector_id, started_at, last_at, peak, baseline, threshold, side, readings, outcome
        FROM warnings WHERE site_id = %s AND started_at >= %s AND started_at <= %s ORDER BY started_at
        """,
        [site_id, start - horizon, end],
    ).fetchall()
    by_detector: dict[uuid.UUID, list[dict[str, Any]]] = {d["id"]: [] for d in detectors}
    for w in warnings:
        if w["detector_id"] in by_detector:  # not one created since the detectors were read
            by_detector[w["detector_id"]].append(w)
    kinds: dict[int, dict[str, Any]] = {}  # each Event's row, by id(), for its kind and signal
    by_asset: dict[str, list[Event]] = {}
    for row in events:
        event = Event(row["at"], row["code"])
        kinds[id(event)] = row
        by_asset.setdefault(row["asset"], []).append(event)

    def judged(d: dict[str, Any]) -> tuple[datetime, datetime]:
        """The part of the period the detector has judged: from its signal's first reading to where
        its runs got to. Events outside it couldn't have been warned of, so they aren't counted."""
        since = max(start, d["first_at"] or end)
        until = min(end, d["done_until"] or since)
        return since, max(since, until)

    def counted(ws: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [w for w in ws if w["started_at"] >= start]

    rows = []
    for d in detectors:
        mine = by_detector[d["id"]]
        since, until = judged(d)
        row = {
            "id": d["id"],
            "name": d["name"],
            "signal_tag": d["signal_tag"],
            "asset": d["asset"],
            "judged_from": since,
            "judged_until": until,
            "confirmed": _confirmed(counted(mine)),
        }
        if d["asset"] is None:  # nothing to match its warnings to
            row |= {"warnings": len(counted(mine)), "events": 0, "matched": False}
        else:
            events_of = by_asset.get(d["asset"], [])
            outcome = score(Config(**d["config"]), [_alert(w) for w in mine], events_of, horizon, since, until)
            row |= _metrics(outcome) | {"matched": True}
        rows.append(row)

    # The totals: per watched asset, every detector's warnings together, so an event counts once,
    # over the part of the period any of them judged.
    watched = sorted({d["asset"] for d in detectors if d["asset"] is not None})
    names = {d["id"]: d["name"] for d in detectors}
    totals = {k: 0 for k in ("warnings", "true_warnings", "false_warnings", "pending_warnings", "events", "caught")}
    seconds: list[float] = []
    shown: list[dict[str, Any]] = []
    people: list[dict[str, Any]] = []
    for asset in watched:
        theirs = [d for d in detectors if d["asset"] == asset]
        spans = [judged(d) for d in theirs]
        mine = sorted((w for d in theirs for w in by_detector[d["id"]]), key=lambda w: w["started_at"])
        people += counted(mine)
        who = {w["started_at"]: names[w["detector_id"]] for w in reversed(mine)}  # the earliest's detector
        outcome = score(
            Config(),
            [_alert(w) for w in mine],
            by_asset.get(asset, []),
            horizon,
            min(s for s, _ in spans),
            max(u for _, u in spans),
        )
        m = _metrics(outcome)
        for k in totals:
            totals[k] += m[k]
        seconds += [o.warning_time.total_seconds() for o in outcome.events if o.warning_time is not None]
        for o in outcome.events:
            source = kinds[id(o.event)]
            shown.append(
                {
                    "at": o.event.at,
                    "asset": asset,
                    "kind": source["kind"],
                    "signal_tag": source["signal_tag"],
                    "code": o.event.code,
                    "warned_at": o.warned_at,
                    "warning_seconds": o.warning_time.total_seconds() if o.warning_time else None,
                    "detector": who.get(o.warned_at) if o.warned_at else None,
                }
            )
    days = (end - start).total_seconds() / 86400
    rated = totals["true_warnings"] + totals["false_warnings"]
    spread = spread_of(seconds)
    unwatched: dict[str, int] = {}
    for row in events:
        if row["asset"] not in watched:
            unwatched[row["asset"]] = unwatched.get(row["asset"], 0) + 1
    shown.sort(key=lambda e: e["at"], reverse=True)
    return {
        "start": start,
        "end": end,
        "horizon_seconds": horizon.total_seconds(),
        "totals": totals
        | {
            "recall": totals["caught"] / totals["events"] if totals["events"] else None,
            "precision": totals["true_warnings"] / rated if rated else None,
            "false_per_day": totals["false_warnings"] / days if days > 0 else None,
            "warning_seconds": asdict(spread) if spread else None,
            "confirmed": _confirmed(people),
        },
        "detectors": rows,
        "unwatched": [{"asset": a, "events": n} for a, n in sorted(unwatched.items())],
        "events": shown[:200],
    }
