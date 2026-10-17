"""Root cause from the machine timeline (T10.03): for a machine's stop, what happened on the machine
before it, as leads for the copilot's `root_cause` tool to explain.

The stop is a downtime event of the machine's asset (api_timeline): the one nearest the time asked
(within STOP_SLACK), or else its latest unplanned stop in the 30 days up to now. The look-back is the
`hours` before it. The leads, strongest first:

- the machine's warnings that started in the look-back or were still out at its start, each with
  how long before the stop it started;
- its signals that moved before the stop: the reading furthest from the look-back's median in its
  last quarter (at least an hour), in robust units (the median absolute deviation of the readings
  before that, scaled to a standard deviation); a move of MOVED or more, and more than 1% of the
  median, is a lead;
- the changes to it in the look-back (plant model commits, signal and detector edits).

It also says whether the stop was planned, and how often a stop with its code came in the 30 days
before. These are what Tiles recorded before the stop, not a proof of its cause; the tool says so.
"""

import statistics
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import status

from tiles_api import api_timeline, coverage, ontology_store
from tiles_api.api_ontology import SiteContext
from tiles_api.errors import Problem

STOP_SLACK = timedelta(hours=2)  # a stop this near the time asked is the one meant
HISTORY = timedelta(days=30)
MOVED = 3.0  # robust standard deviations
MAX_LEADS = 12
MAD_SCALE = 1.4826  # a normal distribution's standard deviation per median absolute deviation


def find_machine(ctx: SiteContext, name: str) -> str:
    """The Machine node named by its id, its label or its asset (any case), else by a word of its
    label when only one has it; 404 names the machines."""
    graph = ontology_store.load_head(ctx.conn, ctx.site_id)
    machines = {n: node for n, node in graph["nodes"].items() if node["type"] == "Machine"}
    if name in machines:
        return name
    wanted = name.strip().lower()
    hits = sorted(
        n for n, node in machines.items() if wanted in (node["label"].lower(), coverage.asset_of(graph, n).lower())
    )
    if not hits:  # a word of its label: "DC-01" for "DC-01 die-casting cell"
        hits = sorted(n for n, node in machines.items() if wanted in node["label"].lower().split())
    if len(hits) == 1:
        return hits[0]
    known = ", ".join(sorted(f"{node['label']} ({coverage.asset_of(graph, n)})" for n, node in machines.items())[:30])
    raise Problem(
        status.HTTP_404_NOT_FOUND,
        "timeline.no_machine",
        f"No single machine {name!r} in the plant model; machines: {known or 'none'}",
        machine=name,
    )


def _stop(ctx: SiteContext, asset: str, at: datetime | None) -> dict[str, Any] | None:
    """The downtime event meant: the nearest to `at`, or the latest unplanned one."""
    near = "ORDER BY abs(extract(epoch FROM s.at - %(at)s)), s.at" if at else "ORDER BY s.at DESC"
    window = "s.at BETWEEN %(at)s - %(slack)s AND %(at)s + %(slack)s" if at else "s.at > %(now)s - %(history)s"
    unplanned = "" if at else "AND NOT tiles_planned(g.site_id, g.asset, s.at, c.code)"
    row: dict[str, Any] | None = ctx.conn.execute(
        f"""
        SELECT s.at, g.tag, c.code, tiles_planned(g.site_id, g.asset, s.at, c.code) AS planned
        FROM site_samples s JOIN signals g ON g.id = s.signal_id,
             LATERAL (SELECT coalesce(s.value_text, s.value::text, s.value_bool::text) AS code) c
        WHERE g.site_id = %(site)s AND g.event_kind = 'downtime' AND g.asset = %(asset)s
          AND coalesce(s.value <> 0, s.value_bool, s.value_text <> '') AND {window} {unplanned}
        {near} LIMIT 1
        """,  # noqa: S608 - the pieces are fixed text, the values parameters
        {
            "site": ctx.site_id,
            "asset": asset,
            "at": at,
            "slack": STOP_SLACK,
            "now": datetime.now(UTC),
            "history": HISTORY,
        },
    ).fetchone()
    return row


def moved(points: list[dict[str, Any]], lead_from: datetime) -> dict[str, Any] | None:
    """How far a signal's readings moved in its lead-up (from `lead_from`) from its look-back
    before it; None without readings on both sides."""
    before = [p["value"] for p in points if p["value"] is not None and p["at"] < lead_from]
    lead = [p for p in points if p["value"] is not None and p["at"] >= lead_from]
    if len(before) < 3 or not lead:
        return None
    median = statistics.median(before)
    spread = MAD_SCALE * statistics.median(abs(v - median) for v in before)
    far = max(lead, key=lambda p: abs(p["value"] - median))
    change = far["value"] - median
    if spread > 0:
        z: float | None = change / spread
    else:
        z = None if change == 0 else (MOVED * 10 if change > 0 else -MOVED * 10)  # off a flat line
    return {
        "median_before": round(median, 6),
        "furthest": round(far["value"], 6),
        "furthest_at": far["at"],
        "change": round(change, 6),
        "change_pct": round(100 * change / median, 1) if median else None,
        "robust_z": round(z, 1) if z is not None else 0.0,
    }


def analyse(ctx: SiteContext, machine_name: str, at: datetime | None, hours: int) -> dict[str, Any]:
    """The stop and its leads (see the module's docstring)."""
    machine = find_machine(ctx, machine_name)
    graph = ontology_store.load_head(ctx.conn, ctx.site_id)
    asset = coverage.asset_of(graph, machine)
    stop = _stop(ctx, asset, at)
    if stop is None and at is None:
        raise Problem(
            status.HTTP_404_NOT_FOUND,
            "root_cause.no_stop",
            f"No unplanned stop of {asset} in the last {HISTORY.days} days; give `at`, the time to look before",
            asset=asset,
        )
    when: datetime = stop["at"] if stop else at  # type: ignore[assignment]  # one of them is set
    start = when - timedelta(hours=hours)
    tl = api_timeline.read(ctx, machine, start, when, points=200)
    lead_from = when - max(timedelta(hours=1), timedelta(hours=hours) / 4)

    leads: list[dict[str, Any]] = []
    for w in tl["warnings"]:
        before = (when - w["started_at"]).total_seconds() / 3600
        leads.append(
            {
                "kind": "warning",
                "what": f"Warning from {w['detector']} on {w['tag']}",
                "started_at": w["started_at"],
                "hours_before_stop": round(before, 1),
                "status": w["status"],
                "outcome": w["outcome"],
                "strength": 1000 - before,  # the latest first
            }
        )
    signals = []
    for s in tl["signals"]:
        m = moved([p.model_dump() for p in s.points], lead_from)
        signals.append({"tag": s.tag, "unit": s.unit, **(m or {"readings": "too few to compare"})})
        if m and abs(m["robust_z"]) >= MOVED and (m["change_pct"] is None or abs(m["change_pct"]) > 1):
            leads.append(
                {
                    "kind": "signal",
                    "what": f"{s.tag} moved from about {m['median_before']:g} to {m['furthest']:g}"
                    + (f" {s.unit}" if s.unit else ""),
                    "at": m["furthest_at"],
                    "robust_z": m["robust_z"],
                    "change_pct": m["change_pct"],
                    "strength": 100 + min(abs(m["robust_z"]), 99),
                }
            )
    for c in tl["changes"]:
        leads.append(
            {
                "kind": "change",
                "what": c["action"] if c["kind"] == "ontology" else f"{c['action']} {c['subject']}",
                "at": c["at"],
                "by": c["author"],
                "hours_before_stop": round((when - c["at"]).total_seconds() / 3600, 1),
                "strength": 10 - (when - c["at"]).total_seconds() / 86400,
            }
        )
    leads.sort(key=lambda lead: -lead["strength"])
    for lead in leads:
        del lead["strength"]

    earlier = []
    if stop:
        earlier = ctx.conn.execute(
            """
            SELECT s.at FROM site_samples s JOIN signals g ON g.id = s.signal_id
            WHERE g.site_id = %s AND g.event_kind = 'downtime' AND g.asset = %s
              AND coalesce(s.value_text, s.value::text, s.value_bool::text) = %s
              AND s.at >= %s AND s.at < %s ORDER BY s.at DESC LIMIT 20
            """,
            [ctx.site_id, asset, stop["code"], when - HISTORY, when],
        ).fetchall()
    return {
        "machine": machine,
        "label": tl["label"],
        "asset": asset,
        "stop": {**stop, "planned": bool(stop["planned"])} if stop else None,
        "looked_from": start,
        "looked_to": when,
        "leads": leads[:MAX_LEADS],
        "more_leads": len(leads) > MAX_LEADS,
        "signals": signals,
        "planned_stops": tl["planned"],
        "same_code_before": {"count": len(earlier), "latest": [r["at"] for r in earlier[:5]]} if stop else None,
        "note": "Leads are what Tiles recorded on the machine before the stop, strongest first; they are not "
        "proof of its cause.",
    }
