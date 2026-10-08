"""Notification settings over HTTP (T3.09): your own preferences on a site, the site's Teams
channel (admins), and what was sent and what failed (admins). Queueing and sending are notify.py.

A Teams webhook URL lets anyone who has it post to the channel, so it is a secret: it is written
here and read only by `tiles-notify`. The API shows its host, and audits only that.
"""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field

from tiles_api import notify
from tiles_api.api_ontology import Admin, Ctx, Editor, SiteContext

router = APIRouter(tags=["notifications"])


class Preferences(BaseModel):
    on_raised: bool  # email me every new warning on the site
    on_assigned: bool  # email me when someone assigns me a warning
    email: str  # where the emails go


class PreferencesIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    on_raised: bool
    on_assigned: bool


class Teams(BaseModel):
    configured: bool
    host: str | None  # the webhook's host; the URL itself is never shown
    on_raised: bool


class TeamsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    webhook_url: Annotated[str, Field(max_length=2000)] | None  # null removes the channel
    on_raised: bool = True


class Delivery(BaseModel):
    id: int
    kind: Literal["warning_raised", "warning_assigned"]
    channel: Literal["email", "teams"]
    recipient: str  # an email address, or the Teams channel
    signal_tag: str
    warning_id: uuid.UUID
    created_at: datetime
    sent_at: datetime | None
    failed_at: datetime | None  # given up
    attempts: int
    last_error: str | None


def _preferences(ctx: SiteContext) -> dict[str, Any]:
    row = ctx.conn.execute(
        "SELECT on_raised, on_assigned FROM notification_prefs WHERE site_id = %s AND user_id = %s",
        [ctx.site_id, ctx.user.id],
    ).fetchone()
    return {"on_raised": False, "on_assigned": True, **(row or {}), "email": ctx.user.email}


@router.get("/sites/{site_id}/notifications/preferences", response_model=Preferences)
def get_preferences(ctx: Ctx) -> dict[str, Any]:
    """Which warnings reach you by email. Until you choose: those assigned to you, not every new one."""
    return _preferences(ctx)


@router.put("/sites/{site_id}/notifications/preferences", response_model=Preferences)
def set_preferences(ctx: Editor, body: PreferencesIn) -> dict[str, Any]:
    before = _preferences(ctx)
    ctx.conn.execute(
        """
        INSERT INTO notification_prefs (site_id, user_id, on_raised, on_assigned) VALUES (%s, %s, %s, %s)
        ON CONFLICT (site_id, user_id) DO UPDATE
        SET on_raised = EXCLUDED.on_raised, on_assigned = EXCLUDED.on_assigned, updated_at = now()
        """,
        [ctx.site_id, ctx.user.id, body.on_raised, body.on_assigned],
    )
    changes = {k: before[k] for k in ("on_raised", "on_assigned")}
    ctx.audit("notification.preferences", "user", str(ctx.user.id), before=changes, after=body.model_dump())
    return _preferences(ctx)


def _teams(ctx: SiteContext) -> dict[str, Any]:
    row = ctx.conn.execute(
        "SELECT teams_webhook_url, teams_on_raised FROM site_notifications WHERE site_id = %s", [ctx.site_id]
    ).fetchone()
    url = row["teams_webhook_url"] if row else None
    return {
        "configured": url is not None,
        "host": urlsplit(url).hostname if url else None,
        "on_raised": row["teams_on_raised"] if row else True,
    }


@router.get("/sites/{site_id}/notifications/teams", response_model=Teams)
def get_teams(ctx: Admin) -> dict[str, Any]:
    """The site's Teams channel, which hears of every new warning (admins)."""
    return _teams(ctx)


@router.put("/sites/{site_id}/notifications/teams", response_model=Teams)
def set_teams(ctx: Admin, body: TeamsIn) -> dict[str, Any]:
    """Point the site at a Teams channel's webhook (Workflows, or an incoming webhook), or remove it."""
    url = body.webhook_url.strip() if body.webhook_url else None
    if url:
        problem = notify.teams_url_problem(url)
        if problem:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, problem)
    before = _teams(ctx)
    ctx.conn.execute(
        """
        INSERT INTO site_notifications (site_id, teams_webhook_url, teams_on_raised) VALUES (%s, %s, %s)
        ON CONFLICT (site_id) DO UPDATE
        SET teams_webhook_url = EXCLUDED.teams_webhook_url, teams_on_raised = EXCLUDED.teams_on_raised,
            updated_at = now()
        """,
        [ctx.site_id, url, body.on_raised],
    )
    after = _teams(ctx)
    ctx.audit("notification.teams", "site", str(ctx.site_id), before=before, after=after)  # hosts, not URLs
    return after


@router.get("/sites/{site_id}/notifications", response_model=list[Delivery])
def deliveries(
    ctx: Admin,
    state: Literal["all", "pending", "sent", "failed"] = "all",
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> list[dict[str, Any]]:
    """What was sent, what waits, and what failed with why, newest first (admins)."""
    return ctx.conn.execute(
        """
        SELECT n.id, n.kind, n.channel, coalesce(u.email, 'Teams channel') AS recipient, g.tag AS signal_tag,
               n.warning_id, n.created_at, n.sent_at, n.failed_at, n.attempts, n.last_error
        FROM notifications n
        JOIN warnings w ON w.id = n.warning_id
        JOIN signals g ON g.id = w.signal_id
        LEFT JOIN users u ON u.id = n.recipient_id
        WHERE n.site_id = %(site)s
          AND CASE %(state)s
                WHEN 'pending' THEN n.sent_at IS NULL AND n.failed_at IS NULL
                WHEN 'sent' THEN n.sent_at IS NOT NULL
                WHEN 'failed' THEN n.failed_at IS NOT NULL OR n.last_error IS NOT NULL
                ELSE true
              END
        ORDER BY n.created_at DESC, n.id DESC LIMIT %(limit)s
        """,
        {"site": ctx.site_id, "state": state, "limit": limit},
    ).fetchall()
