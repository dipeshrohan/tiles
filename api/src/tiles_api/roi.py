"""The ROI report (T6.01): the pilot period against the baseline period, from the events and
warnings Tiles holds, every number recomputable from the data it names.

Events are the readings Warning performance counts (performance.py): readings of 0 or false aren't
events, and a stop is one reading stamped at its start. Rates are per day, or per 1,000 parts when
both periods' production volumes are given. "Avoided" is the baseline's rate applied to the pilot
period, less what the pilot period had. Tiles keeps no end times, so downtime hours come from the
mean stop length the plant's own export gives (`hours_per_stop`, with its source); costs are the
plant's figures. Warning time and false alarms come from Warning performance over each period; a
baseline before any detector judged it has none ("not measured").

The digest is a SHA-256 of the report's inputs and every event it counted, so a second run on the
same data gives the same digest, and a changed reading changes it.
"""

import hashlib
import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from tiles_api import performance
from tiles_api.store import Conn

KINDS = ("downtime", "scrap")


class TooMany(ValueError):
    """More events in a period than a report reads at once."""


def _events(conn: Conn, site_id: uuid.UUID, start: datetime, end: datetime, codes: list[str]) -> list[dict[str, Any]]:
    """The downtime and scrap events from `start` to `end`, as Warning performance reads them (only
    `codes` of downtime when given; scrap is never filtered by them)."""
    rows = conn.execute(
        """
        SELECT s.at, g.asset, g.event_kind AS kind,
               coalesce(s.value_text, s.value::text, s.value_bool::text) AS code
        FROM site_samples s JOIN signals g ON g.id = s.signal_id
        WHERE g.site_id = %(site)s AND g.event_kind = ANY(%(kinds)s::text[]) AND g.asset IS NOT NULL
          AND s.at >= %(start)s AND s.at < %(end)s
          AND coalesce(s.value <> 0, s.value_bool, s.value_text <> '')
          AND (g.event_kind <> 'downtime' OR cardinality(%(codes)s::text[]) = 0
               OR coalesce(s.value_text, s.value::text, s.value_bool::text) = ANY(%(codes)s::text[]))
          AND NOT (g.event_kind = 'downtime'
                   AND tiles_planned(g.site_id, g.asset, s.at,
                                     coalesce(s.value_text, s.value::text, s.value_bool::text)))
        ORDER BY s.at, g.asset, g.event_kind, code LIMIT %(limit)s
        """,
        {
            "site": site_id,
            "kinds": list(KINDS),
            "start": start,
            "end": end,
            "codes": codes,
            "limit": performance.MAX_EVENTS + 1,
        },
    ).fetchall()
    if len(rows) > performance.MAX_EVENTS:
        raise TooMany(f"More than {performance.MAX_EVENTS} events in a period: choose a shorter one")
    return [dict(r) for r in rows]


def _scored(
    conn: Conn, site_id: uuid.UUID, start: datetime, end: datetime, horizon: timedelta, codes: list[str]
) -> dict[str, Any]:
    """Warning performance's totals for the period's stops. Its end is inclusive; a microsecond (the
    database's resolution) earlier makes it exclusive, as here, so a stop at the boundary counts once."""
    try:
        report = performance.report(
            conn, site_id, start, end - timedelta(microseconds=1), horizon, codes, event_kinds=["downtime"]
        )
    except ValueError as e:
        raise TooMany(str(e)) from e
    return dict(report["totals"])


def _rate(count: int, days: float, parts: float | None) -> float | None:
    if parts is not None:
        return count / parts * 1000 if parts > 0 else None
    return count / days if days > 0 else None


def _warnings(totals: dict[str, Any]) -> dict[str, Any]:
    spread = totals["warning_seconds"]
    return {
        "warnings": totals["warnings"],
        "events": totals["events"],
        "caught": totals["caught"],
        "recall": totals["recall"],
        "precision": totals["precision"],
        "false_per_day": totals["false_per_day"],
        "median_warning_seconds": spread["median"] if spread else None,
    }


def _utc(period: tuple[datetime, datetime]) -> tuple[datetime, datetime]:
    return period[0].astimezone(UTC), period[1].astimezone(UTC)


def report(
    conn: Conn,
    site_id: uuid.UUID,
    baseline: tuple[datetime, datetime],
    pilot: tuple[datetime, datetime],
    horizon: timedelta,
    codes: list[str],
    inputs: dict[str, Any],
) -> dict[str, Any]:
    """The pilot against the baseline. `inputs`: `hours_per_stop` and `hours_source`,
    `cost_per_hour`, `cost_per_scrap` and `currency`, `baseline_parts` and `pilot_parts` (each may
    be None)."""
    # In UTC, so the Markdown says the times it shows and one moment gives one digest.
    periods = {"baseline": _utc(baseline), "pilot": _utc(pilot)}
    baseline, pilot = periods["baseline"], periods["pilot"]
    if baseline[1] > pilot[0] or any(end <= start for start, end in periods.values()):
        raise ValueError("Each period must end after it starts, and the baseline before the pilot")
    by_unit = inputs.get("baseline_parts") is not None and inputs.get("pilot_parts") is not None
    out: dict[str, Any] = {
        "periods": {},
        "inputs": inputs | {"codes": codes, "horizon_seconds": horizon.total_seconds()},
    }
    counted: dict[str, list[dict[str, Any]]] = {}
    for name, (start, end) in periods.items():
        events = _events(conn, site_id, start, end, codes)
        counted[name] = events
        days = (end - start).total_seconds() / 86400
        parts = inputs.get(f"{name}_parts") if by_unit else None
        counts = {k: sum(1 for e in events if e["kind"] == k) for k in KINDS}
        assets = sorted({e["asset"] for e in events})
        out["periods"][name] = {
            "start": start,
            "end": end,
            "days": days,
            "parts": parts,
            "counts": counts,
            "rates": {k: _rate(n, days, parts) for k, n in counts.items()},
            "by_asset": [
                {"asset": a} | {k: sum(1 for e in events if e["asset"] == a and e["kind"] == k) for k in KINDS}
                for a in assets
            ],
            "warnings": _warnings(_scored(conn, site_id, start, end, horizon, codes)),
        }
    b, p = out["periods"]["baseline"], out["periods"]["pilot"]
    scale = (p["parts"] / 1000) if by_unit else p["days"]  # the pilot period in the rates' unit
    avoided: dict[str, float | None] = {}
    for k in KINDS:
        rate = b["rates"][k]
        avoided[k] = None if rate is None else rate * scale - p["counts"][k]
    hours = inputs.get("hours_per_stop")
    stops = avoided["downtime"]
    out["avoided"] = {
        "stops": stops,
        "downtime_hours": None if stops is None or hours is None else stops * hours,
        "scrap": avoided["scrap"],
    }
    money = []
    if out["avoided"]["downtime_hours"] is not None and inputs.get("cost_per_hour") is not None:
        money.append(out["avoided"]["downtime_hours"] * inputs["cost_per_hour"])
    if avoided["scrap"] is not None and inputs.get("cost_per_scrap") is not None:
        money.append(avoided["scrap"] * inputs["cost_per_scrap"])
    out["avoided"]["cost"] = sum(money) if money else None
    out["digest"] = digest(out["inputs"], periods, counted)
    out["markdown"] = markdown(out)
    return out


def digest(inputs: dict[str, Any], periods: dict[str, tuple[datetime, datetime]], counted: dict[str, Any]) -> str:
    """SHA-256 of the inputs, the periods and every counted event, in a fixed order."""
    body = {
        "inputs": inputs,
        "periods": {k: [s.isoformat(), e.isoformat()] for k, (s, e) in periods.items()},
        "events": {k: [[e["at"].isoformat(), e["asset"], e["kind"], e["code"]] for e in v] for k, v in counted.items()},
    }
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _n(v: float | None, digits: int = 1) -> str:
    if v is None:
        return "not measured"
    return f"{v:,.{digits}f}" if v != int(v) or digits == 0 else f"{int(v):,}"


def _pct(v: float | None) -> str:
    return "not measured" if v is None else f"{v * 100:.0f}%"


def _minutes(seconds: float | None) -> str:
    return "not measured" if seconds is None else f"{seconds / 60:.0f} min"


def _cell(text: str) -> str:
    """Text in a Markdown table's cell: its pipes escaped, on one line."""
    return " ".join(text.split()).replace("|", "\\|")


def markdown(r: dict[str, Any]) -> str:
    """The report as Markdown, in English (a document for the partner, kept as it was made)."""
    b, p, i, a = r["periods"]["baseline"], r["periods"]["pilot"], r["inputs"], r["avoided"]
    unit = "per 1,000 parts" if b["parts"] is not None else "per day"
    cur = i.get("currency") or ""

    def period(x: dict[str, Any]) -> str:
        parts = f", {_n(x['parts'], 0)} parts" if x["parts"] is not None else ""
        return f"{x['start']:%Y-%m-%d %H:%M} to {x['end']:%Y-%m-%d %H:%M} UTC ({x['days']:.1f} days{parts})"

    def money(v: float | None) -> str:
        return "not measured" if v is None else f"{v:,.0f} {cur}".strip()

    method = []
    if i.get("hours_per_stop") is not None:
        source = f" ({' '.join(str(i['hours_source']).split())})" if i.get("hours_source") else ""
        method.append(f"- Downtime hours: avoided stops x {_n(i['hours_per_stop'], 2)} h per stop{source}.")
    costs = [
        f"downtime hours x {money(i['cost_per_hour'])} per hour" if i.get("cost_per_hour") is not None else "",
        f"scrap events x {money(i['cost_per_scrap'])} each" if i.get("cost_per_scrap") is not None else "",
    ]
    if any(costs):
        method.append(f"- Cost: {', plus '.join(c for c in costs if c)}.")

    lines = [
        "# ROI report",
        "",
        f"- Baseline: {period(b)}",
        f"- Pilot: {period(p)}",
        f"- Downtime codes counted: {', '.join(i['codes']) or 'all'}",
        f"- A warning counts when it starts up to {i['horizon_seconds'] / 3600:g} h before an event",
        "",
        "## Results",
        "",
        "| Measure | Baseline | Pilot | Change |",
        "| --- | --- | --- | --- |",
    ]
    for k, label in (("downtime", "Unplanned stops"), ("scrap", "Scrap events")):
        before, after = b["rates"][k], p["rates"][k]
        change = "not measured" if before in (None, 0) or after is None else f"{(after - before) / before * 100:+.0f}%"
        lines.append(f"| {label} {unit} | {_n(before, 2)} | {_n(after, 2)} | {change} |")
    for k, label, f in (
        ("recall", "Stops warned of", _pct),
        ("precision", "Warnings followed by a stop", _pct),
        ("false_per_day", "False warnings per day", lambda v: _n(v, 2)),
        ("median_warning_seconds", "Median warning time", _minutes),
    ):
        lines.append(f"| {label} | {f(b['warnings'][k])} | {f(p['warnings'][k])} | |")
    lines += [
        "",
        "## Avoided in the pilot period",
        "",
        "| | Avoided |",
        "| --- | --- |",
        f"| Unplanned stops | {_n(a['stops'])} |",
        f"| Downtime hours | {_n(a['downtime_hours'])} |",
        f"| Scrap events | {_n(a['scrap'])} |",
        f"| Cost | {money(a['cost'])} |",
        "",
        "## How each number is made",
        "",
        "- Events are the readings on event signals (Warning performance) with an asset, from the start "
        "of each period up to (not including) its end; a reading of 0 or false is not an event.",
        f"- Rates are events {unit}. Avoided is the baseline's rate over the pilot period, less the pilot's count.",
        *method,
        "- Warning figures are Warning performance's for the unplanned stops in each period; a period no "
        "detector judged has none.",
        "",
        "Counted events:",
        "",
        "| Asset | Baseline stops | Baseline scrap | Pilot stops | Pilot scrap |",
        "| --- | --- | --- | --- | --- |",
    ]
    assets = sorted({x["asset"] for x in b["by_asset"]} | {x["asset"] for x in p["by_asset"]})
    for asset in assets:
        cells = []
        for x in (b, p):
            row = next((y for y in x["by_asset"] if y["asset"] == asset), {"downtime": 0, "scrap": 0})
            cells += [str(row["downtime"]), str(row["scrap"])]
        lines.append(f"| {_cell(asset)} | {' | '.join(cells)} |")
    lines += ["", f"Digest (SHA-256 of the inputs and every counted event): `{r['digest']}`", ""]
    return "\n".join(lines)
