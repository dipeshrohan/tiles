"""The copilot's tools (T4.01; T4.02 adds the rest): read-only views of the site, run as the user
who asked. Each call opens its own short, read-only transaction, so no connection is held while
the model writes."""

from collections.abc import Callable
from contextlib import AbstractContextManager
from typing import Any

from tiles_api import api_signals
from tiles_api.api_ontology import SiteContext
from tiles_api.assistant import Tool, ToolError
from tiles_api.store import one

OpenCtx = Callable[[], AbstractContextManager[SiteContext]]


def _read_only(open_ctx: OpenCtx, fn: Callable[[SiteContext, dict[str, Any]], Any]) -> Callable[[dict[str, Any]], Any]:
    def run(args: dict[str, Any]) -> Any:
        with open_ctx() as ctx:
            ctx.conn.execute("SET TRANSACTION READ ONLY")
            return fn(ctx, args)

    return run


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
    query = str(args.get("query", "")).strip()[:200]
    limit = min(max(int(args.get("limit", 10)), 1), 25)
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
                "last_value": s.last_value,
                "last_at": s.last_at,
                "quality": s.quality.badge if s.quality else None,
            }
            for s in page.signals
        ],
    }


def tools_for(open_ctx: OpenCtx) -> list[Tool]:
    return [
        Tool(
            "site_overview",
            "The site's name, how many ontology nodes of each type it has, how many signals, and how many "
            "warnings are open (not resolved) and still out.",
            {"type": "object", "properties": {}},
            _read_only(open_ctx, site_overview),
        ),
        Tool(
            "find_signals",
            "Search the site's signals (tags, descriptions and the ontology nodes they are linked to). Gives each "
            "one's unit, description, node, latest reading and data-quality badge.",
            {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Words in the tag, description or node; empty for all"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 25},
                },
            },
            _read_only(open_ctx, find_signals),
        ),
    ]
