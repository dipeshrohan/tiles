"""The notification centre (U5.07): each person's inbox on a site, for the bell in the top bar.

The inbox is worked out when it is read, from what waits for the person now:

- a warning assigned to them by someone else, not yet resolved;
- a change request they may approve (asked of them, or of any engineer; not their own);
- an insight waiting for another engineer's review (not their own);
- an import of theirs that never finished (left more than an hour, in the last week).

So it is always true: an item goes once it no longer waits (the warning resolved, the request
decided). What they have read is kept by each item's key, which names its version (a warning
assigned to them again is a new item). Reading is the person's own and changes nothing on the
site (`Ctx`, still audited). The browser asks at most once a minute."""

from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Body
from pydantic import BaseModel, Field

from tiles_api.api_ontology import Ctx, can_edit

router = APIRouter(tags=["Notifications"])

MAX_ITEMS = 50  # listed; the unread count covers up to MAX_COUNTED
MAX_COUNTED = 500
KEEP_READS_DAYS = 90


class InboxItem(BaseModel):
    key: str = Field(description="The item and its version: read marks are kept by it")
    kind: Literal["warning", "review", "insight", "import"]
    title: str
    detail: str
    href: str = Field(description="The page that shows it, as an address in the app")
    at: datetime
    read: bool


class Inbox(BaseModel):
    items: list[InboxItem]
    unread: int


ITEMS = """
SELECT * FROM (
    -- Warnings assigned to me by someone else, not resolved: the latest assignment.
    SELECT 'warning:' || w.id || ':' || a.id AS key, 'warning' AS kind,
           'Warning on ' || g.tag || ' assigned to you' AS title,
           'By ' || coalesce(u.name, 'someone')
               || CASE WHEN w.ended_at IS NULL THEN ', still out' ELSE '' END AS detail,
           '#/warnings?show=all&warning=' || w.id AS href, a.at
    FROM warnings w
    JOIN signals g ON g.id = w.signal_id
    JOIN LATERAL (
        SELECT x.id, x.at, x.actor_id, x.assignee_id FROM warning_activity x
        WHERE x.warning_id = w.id AND x.action = 'assigned' ORDER BY x.id DESC LIMIT 1
    ) a ON true
    LEFT JOIN users u ON u.id = a.actor_id
    WHERE w.site_id = %(site)s AND w.assignee_id = %(me)s AND w.resolved_at IS NULL
      AND a.assignee_id = %(me)s AND a.actor_id IS DISTINCT FROM %(me)s

    UNION ALL
    -- Change requests I may approve: the menu's count (api_menu.py) uses the same rule, and
    -- tests/test_inbox.py checks that the two agree.
    SELECT 'review:' || r.number, 'review', 'Change request #' || r.number || ' waits for your review',
           r.message || ' (from ' || r.author_name || ')', '#/reviews/' || r.number, r.created_at
    FROM change_requests r
    WHERE %(editor)s AND r.site_id = %(site)s AND r.status = 'open' AND r.author_id IS DISTINCT FROM %(me)s
      AND (r.reviewer_id IS NULL OR r.reviewer_id = %(me)s)

    UNION ALL
    -- Insights waiting for another engineer.
    SELECT 'insight:' || i.number || ':' || (extract(epoch FROM i.updated_at) * 1000000)::bigint, 'insight',
           'Insight #' || i.number || ' waits for a review',
           i.title || ' (from ' || i.author_name || ')', '#/insights/' || i.number, i.updated_at
    FROM insights i
    WHERE %(editor)s AND i.site_id = %(site)s AND i.status = 'proposed' AND i.author_id IS DISTINCT FROM %(me)s

    UNION ALL
    -- My imports that never finished.
    SELECT 'import:' || m.id, 'import', 'Import of ' || m.name || ' did not finish',
           m.received || ' readings received; start it again from Import data', '#/import', m.created_at
    FROM imports m
    WHERE m.site_id = %(site)s AND m.created_by = %(me)s AND m.finished_at IS NULL
      AND m.created_at < now() - interval '1 hour' AND m.created_at > now() - interval '7 days'
) items
ORDER BY at DESC, key
LIMIT %(limit)s
"""


def _items(ctx: Any) -> list[dict[str, Any]]:
    """Every item waiting (up to MAX_COUNTED), newest first, each marked read or not."""
    rows: list[dict[str, Any]] = ctx.conn.execute(
        ITEMS,
        {
            "site": ctx.site_id,
            "me": ctx.user.id,
            "editor": can_edit(ctx.conn, ctx.site_id, ctx.org_id, ctx.user.id),
            "limit": MAX_COUNTED,
        },
    ).fetchall()
    read = {
        r["key"]
        for r in ctx.conn.execute(
            "SELECT key FROM inbox_reads WHERE site_id = %s AND user_id = %s AND key = ANY(%s)",
            [ctx.site_id, ctx.user.id, [r["key"] for r in rows]],
        ).fetchall()
    }
    return [{**r, "read": r["key"] in read} for r in rows]


@router.get("/sites/{site_id}/inbox", response_model=Inbox)
def get_inbox(ctx: Ctx) -> dict[str, Any]:
    """What waits for you on this site, newest first (at most 50), each marked read or not."""
    return _inbox(_items(ctx))


def _inbox(items: list[dict[str, Any]]) -> dict[str, Any]:
    return {"items": items[:MAX_ITEMS], "unread": sum(1 for i in items if not i["read"])}


class ReadIn(BaseModel):
    keys: Annotated[list[Annotated[str, Field(min_length=1, max_length=120)]], Field(max_length=MAX_ITEMS)] = Field(
        description="The items read; none: every item in your inbox now"
    )


@router.post("/sites/{site_id}/inbox/read", response_model=Inbox)
def mark_read(ctx: Ctx, body: Annotated[ReadIn, Body()]) -> dict[str, Any]:
    """Mark items of your inbox read (`keys`), or all of them (an empty list). Only items in your
    inbox now are marked. Marks of items no longer waiting go after 90 days. Returns the inbox."""
    items = _items(ctx)
    present = {i["key"] for i in items}
    keys = [k for k in (body.keys or list(present)) if k in present]
    if keys:
        ctx.conn.execute(
            """
            INSERT INTO inbox_reads (site_id, user_id, key)
            SELECT %s, %s, unnest(%s::text[]) ON CONFLICT DO NOTHING
            """,
            [ctx.site_id, ctx.user.id, keys],
        )
        ctx.conn.execute(
            "DELETE FROM inbox_reads WHERE site_id = %s AND user_id = %s"
            " AND read_at < now() - make_interval(days => %s) AND NOT (key = ANY(%s))",
            [ctx.site_id, ctx.user.id, KEEP_READS_DAYS, list(present)],
        )
        ctx.audit("inbox.read", "user", str(ctx.user.id), after={"keys": keys})
    return _inbox([{**i, "read": i["read"] or i["key"] in keys} for i in items])
