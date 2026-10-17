"""Machine timeline (T10.01): a machine's warnings, events, planned stops, changes and readings over
one range, on one time axis.

The machine is a Machine node of the committed ontology. Its signals are its linked catalogue tags
(coverage.signal_nodes); the readings are those that aren't event signals, the first MAX_SIGNALS by
tag, downsampled as the Data explorer's series. Its warnings are those of the detectors on its tags
or with its asset (coverage.asset_of), that are out at some time in the range. Its events are the
readings of the event signals with its asset, each marked when it is planned downtime (T7.03,
`tiles_planned`). Its planned stops are those for its asset or the whole site. Its changes are the
ontology commits whose ops touch the machine, its PLCs or its Signal nodes, and the edits of its
signals and detectors in the audit log (what was done and by whom, not the values). Everyone reads it.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, status
from pydantic import AwareDatetime, BaseModel

from tiles_api import coverage, ontology_store
from tiles_api.api_ontology import Ctx
from tiles_api.api_series import Series, read_series
from tiles_api.errors import Problem

router = APIRouter(tags=["ontology"])

DEFAULT_SPAN = timedelta(days=7)
MAX_SPAN = timedelta(days=31)
MAX_SIGNALS = 6  # charts on one page
POINTS = 400  # per chart
MAX_ITEMS = 500  # of each kind


class TimelineWarning(BaseModel):
    id: uuid.UUID
    detector: str
    tag: str
    started_at: datetime
    ended_at: datetime | None  # None: still out
    status: Literal["open", "acknowledged", "resolved"]
    outcome: Literal["true_alarm", "false_alarm", "unknown"] | None


class TimelineEvent(BaseModel):
    at: datetime
    kind: Literal["downtime", "scrap", "other"]
    code: str
    tag: str
    planned: bool  # planned downtime (T7.03): left out of Warning performance and the ROI report


class TimelineStop(BaseModel):
    id: uuid.UUID
    asset: str | None  # None: the whole site
    starts_at: datetime
    ends_at: datetime
    reason: str


class TimelineChange(BaseModel):
    at: datetime
    kind: Literal["ontology", "signal", "detector"]
    action: str  # the commit's message, or the audit log's action (signal.update…)
    subject: str  # the commit's number, the signal's tag or the detector's name
    author: str


class Timeline(BaseModel):
    machine: str
    label: str
    asset: str
    start: datetime
    end: datetime
    signals: list[Series]
    more_signals: bool  # more linked tags than MAX_SIGNALS
    warnings: list[TimelineWarning]
    events: list[TimelineEvent]
    planned: list[TimelineStop]
    changes: list[TimelineChange]
    more: bool  # a kind had more than MAX_ITEMS in the range: choose a shorter one


@router.get("/sites/{site_id}/timeline", response_model=Timeline)
def timeline(
    ctx: Ctx,
    machine: Annotated[str, Query(min_length=1, max_length=200)],
    start: Annotated[AwareDatetime | None, Query(alias="from")] = None,
    end: Annotated[AwareDatetime | None, Query(alias="to")] = None,
) -> dict[str, Any]:
    """A machine's warnings, events, planned stops, changes and readings from `from` to `to` (the
    seven days to now without them; at most 31 days)."""
    end = end or datetime.now(UTC)
    start = start or end - DEFAULT_SPAN
    if end <= start:
        raise Problem(status.HTTP_422_UNPROCESSABLE_CONTENT, "series.range_inverted", "`to` must be after `from`")
    if end - start > MAX_SPAN:
        raise Problem(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "timeline.range_too_long",
            f"A timeline can be at most {MAX_SPAN.days} days",
            days=MAX_SPAN.days,
        )
    graph = ontology_store.load_head(ctx.conn, ctx.site_id)
    node = graph["nodes"].get(machine)
    if node is None or node["type"] != "Machine":
        raise Problem(
            status.HTTP_404_NOT_FOUND,
            "timeline.no_machine",
            f"No machine {machine} in the plant model",
            machine=machine,
        )
    index = coverage.Index(graph)
    asset = coverage.asset_of(graph, machine)
    nodes = coverage.signal_nodes(index, machine)
    tags = ctx.conn.execute(
        "SELECT id, tag, unit, event_kind FROM signals WHERE site_id = %s AND node_id = ANY(%s) ORDER BY tag",
        [ctx.site_id, nodes],
    ).fetchall()
    readings = [t for t in tags if t["event_kind"] is None]
    tag_ids = [t["id"] for t in tags]
    more = False

    def capped(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        nonlocal more
        more = more or len(rows) > MAX_ITEMS
        return rows[:MAX_ITEMS]

    span = {"site": ctx.site_id, "start": start, "end": end, "limit": MAX_ITEMS + 1}
    warnings = capped(
        ctx.conn.execute(
            """
            SELECT w.id, d.name AS detector, g.tag, w.started_at, w.ended_at, w.outcome,
                   CASE WHEN w.resolved_at IS NOT NULL THEN 'resolved'
                        WHEN w.acknowledged_at IS NOT NULL THEN 'acknowledged' ELSE 'open' END AS status
            FROM warnings w JOIN detectors d ON d.id = w.detector_id JOIN signals g ON g.id = w.signal_id
            WHERE w.site_id = %(site)s AND (w.signal_id = ANY(%(tags)s) OR d.asset = %(asset)s)
              AND w.started_at < %(end)s AND (w.ended_at IS NULL OR w.ended_at >= %(start)s)
            ORDER BY w.started_at, w.id LIMIT %(limit)s
            """,
            {**span, "tags": tag_ids, "asset": asset},
        ).fetchall()
    )
    events = capped(
        ctx.conn.execute(
            """
            SELECT s.at, g.event_kind AS kind, g.tag, c.code,
                   g.event_kind = 'downtime' AND tiles_planned(g.site_id, g.asset, s.at, c.code) AS planned
            FROM site_samples s JOIN signals g ON g.id = s.signal_id,
                 LATERAL (SELECT coalesce(s.value_text, s.value::text, s.value_bool::text) AS code) c
            WHERE g.site_id = %(site)s AND g.event_kind IS NOT NULL AND g.asset = %(asset)s
              AND s.at >= %(start)s AND s.at < %(end)s
              AND coalesce(s.value <> 0, s.value_bool, s.value_text <> '')
            ORDER BY s.at, g.tag LIMIT %(limit)s
            """,
            {**span, "asset": asset},
        ).fetchall()
    )
    planned = capped(
        ctx.conn.execute(
            "SELECT id, asset, starts_at, ends_at, reason FROM planned_stops"
            " WHERE site_id = %(site)s AND (asset IS NULL OR asset = %(asset)s)"
            " AND starts_at < %(end)s AND ends_at > %(start)s ORDER BY starts_at, id LIMIT %(limit)s",
            {**span, "asset": asset},
        ).fetchall()
    )
    changes = _changes(ctx, index, machine, nodes, tags, asset, span)
    more = more or len(changes) > MAX_ITEMS
    return {
        "machine": machine,
        "label": node["label"],
        "asset": asset,
        "start": start,
        "end": end,
        "signals": [read_series(ctx, t["id"], start, end, POINTS, signal=t) for t in readings[:MAX_SIGNALS]],
        "more_signals": len(readings) > MAX_SIGNALS,
        "warnings": warnings,
        "events": events,
        "planned": planned,
        "changes": changes[:MAX_ITEMS],
        "more": more,
    }


def _changes(
    ctx: Ctx,
    index: coverage.Index,
    machine: str,
    nodes: list[str],
    tags: list[dict[str, Any]],
    asset: str,
    span: dict[str, Any],
) -> list[dict[str, Any]]:
    """The commits that touch the machine, its PLCs or its Signal nodes, and the audited edits of
    its signals and detectors, in time order (one more than MAX_ITEMS when there are more)."""
    mine = {machine, *index.out(machine, "controlledBy"), *nodes}
    out: list[dict[str, Any]] = []
    # A commit's ops name nodes by id, or relationships by id (removeEdge), whose ends are in the
    # inverse; ops and inverses together name every node a commit touched.
    for c in ctx.conn.execute(
        "SELECT seq, message, author_name, created_at, ops, inverses FROM commits"
        " WHERE site_id = %(site)s AND created_at >= %(start)s AND created_at < %(end)s"
        " ORDER BY created_at, seq LIMIT 5000",
        span,
    ):
        if mine & {n for op in [*c["ops"], *c["inverses"]] for n in _touched(op)}:
            out.append(
                {
                    "at": c["created_at"],
                    "kind": "ontology",
                    "action": c["message"],
                    "subject": f"#{c['seq']}",
                    "author": c["author_name"],
                }
            )
    detectors = ctx.conn.execute(
        "SELECT id, name FROM detectors WHERE site_id = %s AND (signal_id = ANY(%s) OR asset = %s)",
        [ctx.site_id, [t["id"] for t in tags], asset],
    ).fetchall()
    subjects = {("signal", str(t["id"])): t["tag"] for t in tags} | {
        ("detector", str(d["id"])): d["name"] for d in detectors
    }
    for a in ctx.conn.execute(
        "SELECT at, actor_name, action, entity_type, entity_id FROM audit_log"
        " WHERE site_id = %(site)s AND at >= %(start)s AND at < %(end)s"
        " AND ((entity_type = 'signal' AND entity_id = ANY(%(signals)s))"
        "      OR (entity_type = 'detector' AND entity_id = ANY(%(detectors)s)))"
        " ORDER BY at, id LIMIT %(limit)s",
        {
            **span,
            "signals": [str(t["id"]) for t in tags],
            "detectors": [str(d["id"]) for d in detectors],
        },
    ):
        out.append(
            {
                "at": a["at"],
                "kind": a["entity_type"],
                "action": a["action"],
                "subject": subjects[(a["entity_type"], a["entity_id"])],
                "author": a["actor_name"],
            }
        )
    out.sort(key=lambda c: c["at"])
    return out


def _touched(op: dict[str, Any]) -> set[str]:
    """The node ids an op names."""
    found = {op["id"]} if op.get("kind") in ("removeNode", "setProp") else set()
    if "node" in op:
        found.add(op["node"]["id"])
    if "edge" in op:
        found |= {op["edge"]["from"], op["edge"]["to"]}
    return found
