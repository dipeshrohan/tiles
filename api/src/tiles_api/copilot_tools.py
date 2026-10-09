"""The copilot's tools (T4.01, T4.02): read-only views of the site, run as the user who asked.
Each call opens its own short, read-only transaction, so no connection is held while the model
writes. The one tool that writes, `propose_ontology_change` (T4.09), is offered to engineers and
admins only: it opens a change request for review (api_reviews), which the person who asked can't
approve, so a person always approves what the copilot proposes before it is committed. A tool
that can't answer raises ToolError with a reason the model can act on (a near match, the names it
may use); the API's own checks (HTTPException, validation) become ToolErrors.

The tools are the browser copilot's skills on the site's real data: the ontology (graph query and
health check), signals (search, time series, wear check), virtual sensors, warnings and events,
and the correlation finder on uploaded batch tables.
"""

import math
import re
import uuid
from collections.abc import Callable
from contextlib import AbstractContextManager
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import HTTPException
from pydantic import TypeAdapter, ValidationError

from tiles_api import api_datasets, api_reviews, api_series, api_signals, api_wear, ontology, ontology_store
from tiles_api.api_ontology import OpIn, SiteContext, _op_dict
from tiles_api.assistant import Tool, ToolError
from tiles_api.store import one

OpenCtx = Callable[[], AbstractContextManager[SiteContext]]
LIST_LIMIT = 25


def _read_only(
    open_ctx: OpenCtx, fn: Callable[[SiteContext, dict[str, Any]], Any], writes: bool = False
) -> Callable[[dict[str, Any]], Any]:
    def run(args: dict[str, Any]) -> Any:
        with open_ctx() as ctx:
            if not writes:
                ctx.conn.execute("SET TRANSACTION READ ONLY")
            try:
                return fn(ctx, args)
            except HTTPException as e:
                raise ToolError(str(e.detail)) from None
            except ValidationError as e:
                raise ToolError("; ".join(f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in e.errors())) from None

    return run


# ---- reading a tool's input ------------------------------------------------------------


def _text(args: dict[str, Any], key: str, default: str = "", limit: int = 200) -> str:
    return str(args.get(key, default) or default).replace("\x00", "").strip()[:limit]


def _int(args: dict[str, Any], key: str, default: int, low: int, high: int) -> int:
    try:
        return min(max(int(args.get(key, default)), low), high)
    except (TypeError, ValueError):
        raise ToolError(f"{key} must be a whole number from {low} to {high}") from None


def _time(args: dict[str, Any], key: str) -> datetime | None:
    raw = args.get(key)
    if raw in (None, ""):
        return None
    try:
        t = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        raise ToolError(f"{key} must be an ISO 8601 time, e.g. 2026-09-05T06:00:00Z") from None
    return t if t.tzinfo else t.replace(tzinfo=UTC)


def _signal(ctx: SiteContext, tag: str) -> dict[str, Any]:
    """The signal with this tag (its case, or else any case if only one matches); otherwise the
    error names close ones."""
    if not tag:
        raise ToolError("Give the signal's tag (find_signals searches them)")
    rows = ctx.conn.execute(
        "SELECT id, tag, unit FROM signals WHERE site_id = %s AND lower(tag) = lower(%s) ORDER BY tag",
        [ctx.site_id, tag],
    ).fetchall()
    exact = [r for r in rows if r["tag"] == tag]
    if exact or len(rows) == 1:
        return (exact or rows)[0]
    if rows:
        raise ToolError(f"Several tags are {tag!r} but for case: {', '.join(r['tag'] for r in rows)}; give one exactly")
    stem = next((w for w in re.split(r"[^0-9A-Za-z]+", tag) if w), "")
    near = (
        [
            r["tag"]
            for r in ctx.conn.execute(
                "SELECT tag FROM signals WHERE site_id = %s AND tag ILIKE %s ORDER BY tag LIMIT 5",
                [ctx.site_id, api_signals._like(stem)],
            )
        ]
        if stem
        else []
    )
    raise ToolError(f"No signal tagged {tag!r}" + (f"; close: {', '.join(near)}" if near else ""))


def _names(items: list[str], limit: int = 30) -> str:
    """A list for an error message, cut short so the message stays small."""
    shown = ", ".join(items[:limit])
    return shown + (f" and {len(items) - limit} more" if len(items) > limit else "")


def _uuid(v: Any) -> uuid.UUID | None:
    """A signal id in a binding's inputs or outputs (others are `@time`)."""
    try:
        return uuid.UUID(str(v))
    except ValueError:
        return None


def _finite(x: Any) -> Any:
    return None if isinstance(x, float) and not math.isfinite(x) else x


# ---- the tools ---------------------------------------------------------------------------


def site_overview(ctx: SiteContext, _args: dict[str, Any]) -> dict[str, Any]:
    site = one(ctx.conn.execute("SELECT name FROM sites WHERE id = %s", [ctx.site_id]).fetchone())
    nodes = ctx.conn.execute(
        "SELECT type, count(*) AS n FROM ontology_nodes WHERE site_id = %s GROUP BY type ORDER BY type", [ctx.site_id]
    ).fetchall()
    counts = one(
        ctx.conn.execute(
            """
            SELECT (SELECT count(*) FROM signals WHERE site_id = %(s)s) AS signals,
                   (SELECT count(*) FROM warnings WHERE site_id = %(s)s AND resolved_at IS NULL) AS open_warnings,
                   (SELECT count(*) FROM warnings WHERE site_id = %(s)s AND resolved_at IS NULL
                                                   AND ended_at IS NULL) AS signals_still_out
            """,
            {"s": ctx.site_id},
        ).fetchone()
    )
    return {"site": site["name"], "ontology_nodes_by_type": {r["type"]: r["n"] for r in nodes}, **counts}


def find_signals(ctx: SiteContext, args: dict[str, Any]) -> dict[str, Any]:
    query = _text(args, "query")
    limit = _int(args, "limit", 10, 1, LIST_LIMIT)
    page = api_signals.list_signals(ctx, q=query, source="", linked="", quality="", limit=limit, offset=0)
    if not page.signals:
        raise ToolError(f"No signal matches {query!r}" if query else "This site has no signals yet")
    return {
        "total": page.total,
        "signals": [
            {
                "tag": s.tag,
                "unit": s.unit,
                "description": s.description,
                "node": s.node_label,
                "asset": s.asset,
                "event_kind": s.event_kind,
                "last_value": s.last_value,
                "last_at": s.last_at,
                "quality": s.quality.badge if s.quality else None,
            }
            for s in page.signals
        ],
    }


def _node_text(n: ontology.Node) -> dict[str, Any]:
    return {"id": n["id"], "type": n["type"], "label": n["label"], "props": n["props"]}


def graph_query(ctx: SiteContext, args: dict[str, Any]) -> dict[str, Any]:
    """Nodes by words and type; or one node with everything it is connected to."""
    graph = ontology_store.load_head(ctx.conn, ctx.site_id)
    nodes = graph["nodes"]
    wanted = _text(args, "node")
    if wanted:
        node = nodes.get(wanted) or next((n for n in nodes.values() if n["label"].lower() == wanted.lower()), None)
        if node is None:
            near = sorted(n["label"] for n in nodes.values() if wanted.lower() in n["label"].lower())[:5]
            raise ToolError(f"No node {wanted!r}" + (f"; close: {', '.join(near)}" if near else ""))
        links = []
        for e in graph["edges"].values():
            if e["from"] == node["id"] and e["to"] in nodes:
                links.append({"direction": "out", "rel": e["rel"], "node": _node_text(nodes[e["to"]])})
            elif e["to"] == node["id"] and e["from"] in nodes:
                links.append({"direction": "in", "rel": e["rel"], "node": _node_text(nodes[e["from"]])})
        signals = ctx.conn.execute(
            "SELECT tag, unit FROM signals WHERE site_id = %s AND node_id = %s ORDER BY tag", [ctx.site_id, node["id"]]
        ).fetchall()
        return {"node": _node_text(node), "links": links[:100], "links_total": len(links), "signal_tags": signals}
    words = _text(args, "query").lower().split()
    kind = _text(args, "type")
    if kind and kind not in ontology.NODE_TYPES:
        raise ToolError(f"type must be one of {', '.join(sorted(ontology.NODE_TYPES))}")
    found = [
        n
        for n in nodes.values()
        if (not kind or n["type"] == kind)
        and all(w in f"{n['label']} {n['id']} {' '.join(map(str, n['props'].values()))}".lower() for w in words)
    ]
    found.sort(key=lambda n: (n["type"], n["label"]))
    limit = _int(args, "limit", 15, 1, LIST_LIMIT)
    if not found:
        raise ToolError(
            "No node matches" + (f" {' '.join(words)!r}" if words else "") + (f" of type {kind}" if kind else "")
        )
    return {"total": len(found), "nodes": [_node_text(n) for n in found[:limit]]}


def ontology_health(ctx: SiteContext, _args: dict[str, Any]) -> dict[str, Any]:
    report = ontology.health_check(ontology_store.load_head(ctx.conn, ctx.site_id))
    return {
        "score": report["score"],
        "counts": report["counts"],
        "issues_total": len(report["issues"]),
        "issues": report["issues"][:40],
    }


def time_series(ctx: SiteContext, args: dict[str, Any]) -> dict[str, Any]:
    """A signal over a range (default: the day up to its latest reading), with its summary."""
    signal = _signal(ctx, _text(args, "tag"))
    start = _time(args, "from")
    end = _time(args, "to")
    if end is None:  # a day from `from`, or the day up to the latest reading
        end = start + timedelta(hours=24) if start else api_series.latest_end(ctx, signal["id"])
    start = start or end - timedelta(hours=24)
    points = _int(args, "points", 100, 10, 200)
    series = api_series.read_series(ctx, signal["id"], start, end, points, signal)
    values = [p.value for p in series.points if p.value is not None]
    readings = sum(p.n for p in series.points)
    mean = (
        sum(p.value * p.n for p in series.points if p.value is not None)
        / sum(p.n for p in series.points if p.value is not None)
        if values
        else None
    )
    return {
        "tag": series.tag,
        "unit": series.unit,
        "from": series.start,
        "to": series.end,
        "readings": readings,
        "summary": {
            "min": min((p.min for p in series.points if p.min is not None), default=None),
            "max": max((p.max for p in series.points if p.max is not None), default=None),
            "mean": mean,
            "first": series.points[0].value if series.points else None,
            "last": series.points[-1].value if series.points else None,
        },
        "bucket_s": series.bucket_s,
        "points": [[p.at, p.value, p.min, p.max] if series.bucket_s else [p.at, p.value] for p in series.points],
        "texts": [[p.at, p.text] for p in series.points if p.text is not None][-20:],
    }


def wear_check(ctx: SiteContext, args: dict[str, Any]) -> dict[str, Any]:
    signal = _signal(ctx, _text(args, "tag"))
    fields = ("recent_hours", "baseline_hours", "bucket_minutes", "direction", "threshold", "limit")
    body = api_wear.WearIn.model_validate(
        {k: args[k] for k in fields if args.get(k) is not None} | {"end": _time(args, "end")}
    )
    out = api_wear.run_check(ctx, signal["id"], body, signal)
    return {k: v for k, v in out.items() if k not in ("buckets", "signal_id")} | {"buckets": len(out["buckets"])}


def virtual_sensors(ctx: SiteContext, args: dict[str, Any]) -> dict[str, Any]:
    """Model bindings: which model runs on which signals, how its runs went, its outputs' latest."""
    name = _text(args, "name")
    rows = ctx.conn.execute(
        """
        SELECT b.name, m.name AS model, m.key AS model_key, m.version, b.inputs, b.params, b.outputs,
               b.enabled, b.done_until, b.last_run_at, b.last_windows, b.last_failed, b.last_error
        FROM model_bindings b JOIN models m ON m.id = b.model_id
        WHERE b.site_id = %s AND (%s = '' OR b.name ILIKE %s) ORDER BY b.name LIMIT 25
        """,
        [ctx.site_id, name, api_signals._like(name)],
    ).fetchall()
    if not rows:
        raise ToolError(f"No virtual sensor named like {name!r}" if name else "This site has no virtual sensors yet")
    ids = {i for r in rows for v in [*r["inputs"].values(), *r["outputs"].values()] if (i := _uuid(v))}
    tags = {
        r["id"]: r
        for r in ctx.conn.execute(
            """
            SELECT g.id, g.tag, g.unit, s.at AS last_at,
                   coalesce(s.value::text, s.value_text, s.value_bool::text) AS last_value
            FROM signals g LEFT JOIN LATERAL (
                SELECT at, value, value_text, value_bool FROM samples WHERE signal_id = g.id ORDER BY at DESC LIMIT 1
            ) s ON true
            WHERE g.site_id = %s AND g.id = ANY(%s)
            """,
            [ctx.site_id, list(ids)],
        )
    }

    def signal(v: Any) -> Any:
        i = _uuid(v)
        g = tags.get(i) if i else None
        return {"tag": g["tag"], "unit": g["unit"], "last_value": g["last_value"], "last_at": g["last_at"]} if g else v

    return {
        "virtual_sensors": [
            r
            | {
                "inputs": {k: (signal(v) if v != "@time" else v) for k, v in r["inputs"].items()},
                "outputs": {k: signal(v) for k, v in r["outputs"].items()},
            }
            for r in rows
        ]
    }


def events(ctx: SiteContext, args: dict[str, Any]) -> dict[str, Any]:
    """Warnings (from detectors) or events (downtime, scrap… readings), newest first."""
    kind = _text(args, "kind", "warnings")
    tag = _text(args, "tag")
    asset = _text(args, "asset", limit=100)
    until = _time(args, "until") or datetime.now(UTC) + timedelta(minutes=1)
    since_given = _time(args, "since")
    since = since_given or until - timedelta(days=30)
    if since >= until:
        raise ToolError("since must be before until")
    # Without `since`, warnings still open (unresolved) are listed however long ago they started.
    with_open = since_given is None
    limit = _int(args, "limit", 20, 1, 50)
    signal_id = _signal(ctx, tag)["id"] if tag else None
    if kind == "warnings":
        rows = ctx.conn.execute(
            """
            SELECT g.tag, d.name AS detector, d.asset, w.started_at, w.last_at, w.ended_at, w.side, w.peak,
                   w.baseline, w.threshold, w.readings, w.acknowledged_at, w.resolved_at, w.outcome,
                   w.resolution_note, u.name AS assignee
            FROM warnings w JOIN signals g ON g.id = w.signal_id JOIN detectors d ON d.id = w.detector_id
            LEFT JOIN users u ON u.id = w.assignee_id
            WHERE w.site_id = %(s)s AND w.started_at < %(until)s
              AND (w.started_at >= %(since)s OR (%(open)s AND w.resolved_at IS NULL))
              AND (%(sig)s::uuid IS NULL OR w.signal_id = %(sig)s) AND (%(asset)s = '' OR d.asset = %(asset)s)
            ORDER BY w.started_at DESC LIMIT %(n)s
            """,
            {
                "s": ctx.site_id,
                "since": since,
                "until": until,
                "open": with_open,
                "sig": signal_id,
                "asset": asset,
                "n": limit,
            },
        ).fetchall()
        return {"since": since, "until": until, "warnings": rows}
    if kind != "events":
        raise ToolError('kind must be "warnings" or "events"')
    rows = ctx.conn.execute(
        """
        SELECT g.tag, g.event_kind AS kind, g.asset, s.at,
               coalesce(s.value::text, s.value_text, s.value_bool::text) AS value
        FROM samples s JOIN signals g ON g.id = s.signal_id
        WHERE g.site_id = %(s)s AND g.event_kind IS NOT NULL AND s.at >= %(since)s AND s.at < %(until)s
          AND (%(sig)s::uuid IS NULL OR g.id = %(sig)s) AND (%(asset)s = '' OR g.asset = %(asset)s)
        ORDER BY s.at DESC LIMIT %(n)s
        """,
        {"s": ctx.site_id, "since": since, "until": until, "sig": signal_id, "asset": asset, "n": limit},
    ).fetchall()
    return {"since": since, "until": until, "events": rows}


def correlate(ctx: SiteContext, args: dict[str, Any]) -> dict[str, Any]:
    """The correlation finder on an uploaded batch table."""
    name = _text(args, "dataset")
    hit = ctx.conn.execute(
        "SELECT id FROM datasets WHERE site_id = %s AND lower(name) = lower(%s)", [ctx.site_id, name]
    ).fetchone()
    if hit is None:
        rows = ctx.conn.execute(
            "SELECT name, row_count FROM datasets WHERE site_id = %s ORDER BY name LIMIT 31", [ctx.site_id]
        ).fetchall()
        names = _names([f"{d['name']} ({d['row_count']} rows)" for d in rows]) or "none uploaded yet"
        raise ToolError(f"No dataset {name!r}; the site's datasets: {names}")
    found = api_datasets.find_dataset(ctx, hit["id"])
    if not args.get("outcome"):
        cols = _names([f"{c['name']} ({c['kind']})" for c in found["columns"]])
        raise ToolError(f"Say which column is the outcome; {found['name']} has: {cols}")
    body = api_datasets.CorrelateIn.model_validate(
        {k: args[k] for k in ("outcome", "ng_values", "variables", "split") if args.get(k) is not None}
    )
    result = api_datasets.run(ctx, found, body)
    findings = [{k: _finite(v) for k, v in f.items()} for f in result["findings"][:15]]
    return {
        "dataset": found["name"],
        "rows": result["rows"],
        "ng": result["ng"],
        "ok": result["ok"],
        "explanations": [e["text"] for e in result["explanations"]],
        "findings": findings,
        "findings_total": len(result["findings"]),
    }


# ---- the list the model sees ----------------------------------------------------------

OBJECT = "object"
MAX_PROPOSED_OPS = 200
OPS = TypeAdapter(list[OpIn])


def propose_ontology_change(ctx: SiteContext, args: dict[str, Any], conversation_id: uuid.UUID | None) -> Any:
    """Opens a change request of `ops` in the name of the user who asked (T4.09)."""
    if ctx.user.role not in ("engineer", "admin"):  # the role may have changed since the question
        raise ToolError("Only engineers and admins of the site can propose ontology changes")
    message = _text(args, "message", limit=2000)
    if not message:
        raise ToolError("Give the change request a message: what it changes and why")
    raw = args.get("ops")
    if not isinstance(raw, list) or not raw:
        raise ToolError("Give `ops`: a list of changes (addNode, addEdge, setProp, removeEdge, removeNode)")
    if len(raw) > MAX_PROPOSED_OPS:
        raise ToolError(f"At most {MAX_PROPOSED_OPS} changes in one proposal: split it")
    ops = [_op_dict(op) for op in OPS.validate_python(raw)]
    ontology_store.lock_site(ctx.conn, ctx.site_id)
    number = api_reviews.open_request(ctx, ops, message, source="copilot", conversation_id=conversation_id)
    stats = ontology.diff_stats(ops)
    ctx.audit(
        "ontology.review.request",
        "change_request",
        str(number),
        after={
            "message": message,
            "ops": ops,
            "reviewer_id": None,
            "reverts": None,
            "source": "copilot",
            "conversation_id": conversation_id and str(conversation_id),
        },
    )
    return {
        "change_request": number,
        "status": "open",
        "changes": stats,
        "committed": False,
        "next": "Another engineer of the site must approve it on the Change reviews page; until then nothing changes.",
    }


TIME = {"type": "string", "description": "ISO 8601, e.g. 2026-09-05T06:00:00Z (UTC unless it says otherwise)"}


def tools_for(open_ctx: OpenCtx, *, can_propose: bool = False, conversation_id: uuid.UUID | None = None) -> list[Tool]:
    """The tools for a question: the read-only ones, and for engineers and admins (`can_propose`)
    the one that proposes ontology changes."""

    def tool(
        name: str,
        description: str,
        properties: dict[str, Any],
        fn: Callable[..., Any],
        required: list[str] | None = None,
        writes: bool = False,
    ) -> Tool:
        schema: dict[str, Any] = {"type": OBJECT, "properties": properties}
        if required:
            schema["required"] = required
        return Tool(name, description, schema, _read_only(open_ctx, fn, writes))

    proposing = [
        tool(
            "propose_ontology_change",
            "Propose changes to the plant's ontology, only when the user asks for a change. They go to another "
            "engineer of the site for review as a numbered change request; nothing changes until it is approved. "
            "Read the nodes first (graph_query) so ids and labels match. Ops: "
            '{"kind": "addNode", "node": {"id", "type", "label", "props"?}}, '
            '{"kind": "addEdge", "edge": {"id", "from", "rel", "to"}}, '
            '{"kind": "setProp", "id", "key", "value"?} (no value removes it), '
            '{"kind": "removeEdge", "id"}, {"kind": "removeNode", "id"} (after its relationships). '
            "Relationships: contains, controlledBy, emits, runs, consumes, monitors, reads, describes.",
            {
                "message": {"type": "string", "description": "What the change does and why, for the reviewer"},
                "ops": {"type": "array", "items": {"type": "object"}, "maxItems": MAX_PROPOSED_OPS},
            },
            lambda ctx, args: propose_ontology_change(ctx, args, conversation_id),
            ["message", "ops"],
            writes=True,
        )
    ]
    return (proposing if can_propose else []) + [
        tool(
            "site_overview",
            "The site's name, how many ontology nodes of each type it has, how many signals, and how many "
            "warnings are open (not resolved) and still out.",
            {},
            site_overview,
        ),
        tool(
            "find_signals",
            "Search the site's signals (tags, descriptions and the ontology nodes they are linked to). Gives each "
            "one's unit, description, node, asset, event kind, latest reading and data-quality badge.",
            {
                "query": {"type": "string", "description": "Words in the tag, description or node; empty for all"},
                "limit": {"type": "integer", "minimum": 1, "maximum": LIST_LIMIT},
            },
            find_signals,
        ),
        tool(
            "graph_query",
            "The plant's ontology (ISA-95 style: Site, Area/Workcenter, Line, Machine, PLC, Signal, Process, "
            "Material…). With `node` (an id or exact label): that node, every node it is linked to and how "
            "(contains, controlledBy, emits, runs…), and the signal tags mapped to it. Otherwise: nodes whose "
            "label, id or properties contain every word of `query`, optionally of one `type`.",
            {
                "node": {"type": "string"},
                "query": {"type": "string"},
                "type": {"type": "string", "enum": sorted(ontology.NODE_TYPES)},
                "limit": {"type": "integer", "minimum": 1, "maximum": LIST_LIMIT},
            },
            graph_query,
        ),
        tool(
            "ontology_health",
            "The ontology health check: a score out of 100, counts, and issues (relationships to missing nodes, "
            "duplicate relationships, nodes without any, missing required properties).",
            {},
            ontology_health,
        ),
        tool(
            "time_series",
            "A signal's readings over a time range (default: the 24 hours up to its latest reading): min, max, "
            "mean, first and last, and up to `points` points (bucket averages with min and max for long ranges).",
            {
                "tag": {"type": "string"},
                "from": TIME,
                "to": TIME,
                "points": {"type": "integer", "minimum": 10, "maximum": 200},
            },
            time_series,
            ["tag"],
        ),
        tool(
            "wear_check",
            "Has a signal's level moved from its baseline, as a wearing tool's does (a welder tip's power, a "
            "spindle's current)? Compares the median of the last `recent_hours` (default 24) with the "
            "`baseline_hours` (default 72) before, in buckets; says wearing or stable, the slope per day, and "
            "the hours until `limit` at that pace.",
            {
                "tag": {"type": "string"},
                "end": TIME,
                "recent_hours": {"type": "number"},
                "baseline_hours": {"type": "number"},
                "bucket_minutes": {"type": "number"},
                "direction": {"type": "string", "enum": ["up", "down", "either"]},
                "threshold": {"type": "number", "description": "A fraction of the baseline (0.05 = 5%)"},
                "limit": {"type": "number"},
            },
            wear_check,
            ["tag"],
        ),
        tool(
            "virtual_sensors",
            "The virtual sensors (physics models bound to signals): each one's model and version, input and output "
            "signals with their latest values, whether it runs, up to when, and its last run's windows, failures "
            "and error.",
            {"name": {"type": "string", "description": "Part of the binding's name; empty for all"}},
            virtual_sensors,
        ),
        tool(
            "events",
            'Warnings raised by detectors (kind "warnings": the signal, when, peak against baseline and threshold, '
            'acknowledged, assignee, resolution and outcome) or recorded events (kind "events": downtime, scrap… '
            "readings with their codes), newest first, by default over the last 30 days.",
            {
                "kind": {"type": "string", "enum": ["warnings", "events"]},
                "tag": {"type": "string"},
                "asset": {"type": "string", "description": "The machine as the MES names it"},
                "since": TIME,
                "until": TIME,
                "limit": {"type": "integer", "minimum": 1, "maximum": 50},
            },
            events,
        ),
        tool(
            "correlate",
            "The correlation finder on an uploaded batch table: which variables separate the failed batches from "
            "the good ones (Cohen's d with its 95% interval, per segment of `split`). Without `outcome` it lists "
            "the dataset's columns; with an unknown `dataset` it lists the site's datasets.",
            {
                "dataset": {"type": "string"},
                "outcome": {"type": "string"},
                "ng_values": {"type": "array", "items": {}, "description": "Outcome values that mean failed"},
                "variables": {"type": "array", "items": {"type": "string"}},
                "split": {"type": "string"},
            },
            correlate,
            ["dataset"],
        ),
    ]
