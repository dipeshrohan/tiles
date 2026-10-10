"""UX analytics, privacy first (U1.09). An organisation opts in (off by default); then the browser
sends what people do on its sites as events: a page viewed, a task done (a warning acknowledged, an
app made), the command palette used, help opened, an error shown. An event is its kind, a name from
a fixed vocabulary (lower-case words, no free text), the time it arrived and its browser session,
hashed: never a user, an e-mail, a record's id or anything typed. Events stay in this deployment's
database for 90 days, and admins read them as counts. Sending events changes nothing on the site, so
it isn't audited; turning the analytics on or off is (an organisation entry)."""

import hashlib
from typing import Any, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from tiles_api import audit
from tiles_api.api_ontology import Admin, Ctx
from tiles_api.api_sites import OrgAdmin

router = APIRouter(tags=["UX analytics"])

KEEP_DAYS = 90
Kind = Literal["page", "task", "palette", "help", "error"]
NAME = r"^[a-z0-9][a-z0-9._-]{0,63}$"


class Setting(BaseModel):
    enabled: bool = Field(description="Whether the organisation's sites record UX events")


class SettingIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: StrictBool


class Event(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Kind
    name: str = Field(pattern=NAME, description="From the app's vocabulary: a page id, a task, an error's kind")


class Events(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session: str = Field(
        pattern=r"^[A-Za-z0-9-]{16,64}$", description="A random id the browser makes per tab; it is stored hashed"
    )
    events: list[Event] = Field(max_length=100)


class Stored(BaseModel):
    stored: int = Field(description="0 when the organisation hasn't turned the analytics on")


class Count(BaseModel):
    kind: Kind
    name: str
    events: int
    sessions: int


class Summary(BaseModel):
    enabled: bool
    days: int
    sessions: int = Field(description="Browser sessions that sent events in the period")
    counts: list[Count]


COUNTS = """
SELECT kind, name, count(*) AS events, count(DISTINCT session) AS sessions
FROM ux_events WHERE site_id = %s AND at >= now() - make_interval(days => %s)
GROUP BY kind, name ORDER BY kind, events DESC, name
"""
SESSIONS = (
    "SELECT count(DISTINCT session) AS n FROM ux_events WHERE site_id = %s AND at >= now() - make_interval(days => %s)"
)


def _enabled(conn: Any, org_id: Any) -> bool:
    row = conn.execute("SELECT ux_analytics FROM orgs WHERE id = %s", [org_id]).fetchone()
    return bool(row and row["ux_analytics"])


def session_hash(session: str) -> str:
    """The session as stored: 16 hex characters of its SHA-256, which counts sessions without
    keeping what the browser sent."""
    return hashlib.sha256(f"tiles-ux:{session}".encode()).hexdigest()[:16]


@router.get("/org/ux-analytics", response_model=Setting)
def get_ux_analytics(caller: OrgAdmin) -> dict[str, bool]:
    """Whether your organisation's sites record UX events (organisation admins)."""
    return {"enabled": _enabled(caller.conn, caller.org_id)}


@router.put("/org/ux-analytics", response_model=Setting)
def set_ux_analytics(body: SettingIn, caller: OrgAdmin) -> dict[str, bool]:
    """Turn UX analytics on or off for your organisation's sites (organisation admins). Off, nothing
    is recorded; the events already kept stay until they are 90 days old."""
    before = _enabled(caller.conn, caller.org_id)
    if before != body.enabled:
        caller.conn.execute("UPDATE orgs SET ux_analytics = %s WHERE id = %s", [body.enabled, caller.org_id])
        audit.record_org(
            caller.conn,
            org_id=caller.org_id,
            actor_id=caller.user_id,
            actor_name=caller.name,
            action="org.ux_analytics",
            entity_type="org",
            entity_id=str(caller.org_id),
            before={"enabled": before},
            after={"enabled": body.enabled},
        )
    return {"enabled": body.enabled}


@router.get("/sites/{site_id}/ux-analytics", response_model=Setting)
def site_ux_analytics(ctx: Ctx) -> dict[str, bool]:
    """Whether this site records UX events (its organisation turned them on): the browser sends
    none otherwise."""
    return {"enabled": _enabled(ctx.conn, ctx.org_id)}


@router.post("/sites/{site_id}/ux-events", response_model=Stored)
def record_ux_events(body: Events, ctx: Ctx) -> dict[str, int]:
    """Records a batch of UX events from one browser session (any member). Nothing is stored unless
    the organisation turned the analytics on; events older than 90 days are let go."""
    if not body.events or not _enabled(ctx.conn, ctx.org_id):
        return {"stored": 0}
    session = session_hash(body.session)
    with ctx.conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO ux_events (site_id, kind, name, session) VALUES (%s, %s, %s, %s)",
            [(ctx.site_id, e.kind, e.name, session) for e in body.events],
        )
    ctx.conn.execute(
        "DELETE FROM ux_events WHERE site_id = %s AND at < now() - make_interval(days => %s)",
        [ctx.site_id, KEEP_DAYS],
    )
    return {"stored": len(body.events)}


@router.get("/sites/{site_id}/ux-events/summary", response_model=Summary)
def ux_summary(ctx: Admin, days: int = Query(30, ge=1, le=KEEP_DAYS)) -> dict[str, Any]:
    """How often each page, task, palette use, help topic and error came up on this site over the
    last `days` days, and in how many browser sessions (admins). Counts only."""
    counts = ctx.conn.execute(COUNTS, [ctx.site_id, days]).fetchall()
    total = ctx.conn.execute(SESSIONS, [ctx.site_id, days]).fetchone()
    return {
        "enabled": _enabled(ctx.conn, ctx.org_id),
        "days": days,
        "sessions": int(total["n"]) if total else 0,
        "counts": counts,
    }
