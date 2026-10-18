"""Work orders drafted by Tiles (T9.02): on each site with `work_order_lead_days` set, a draft for
every component whose remaining life (api_remaining_life) says it reaches its wear limit within that
many days, or is there already, and has no open work order yet. Drafted by "Tiles", so anyone with
the engineer role approves it; nothing goes out until a person does. `tiles-draft-work-orders`,
e.g. hourly from cron.

The draft names the component and its machine, says what was predicted (the level, the limit, the
time to it with its interval) and is due at the next planned stop before the limit (T9.03) or, with
none in time, at the predicted limit. Within two days it is high priority. Its words are English, as
the API stores shared text.
"""

import argparse
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from tiles_api import api_remaining_life, api_work_orders, audit, jobs, telemetry
from tiles_api.api_ontology import SiteContext
from tiles_api.identity import User
from tiles_api.store import Conn, one

DRAFTER = "Tiles"
URGENT = timedelta(days=2)


def due(conn: Conn, site_id: uuid.UUID | None = None) -> list[uuid.UUID]:
    """The sites (one, if given) where Tiles drafts work orders."""
    rows = conn.execute(
        "SELECT id FROM sites WHERE work_order_lead_days IS NOT NULL AND (%s::uuid IS NULL OR id = %s) ORDER BY id",
        [site_id, site_id],
    )
    return [r["id"] for r in rows]


def _hours(h: float) -> str:
    return f"{h / 24:.1f} days" if h >= 48 else f"{h:.0f} h"


def _description(c: dict[str, Any]) -> str:
    unit = f" {c['unit']}" if c["unit"] else ""
    level = "unknown" if c["level"] is None else f"{c['level']:g}{unit}"
    if not c["hours_to_limit"]:
        when = "It is at its wear limit now."
    else:
        when = f"It reaches its wear limit in about {_hours(c['hours_to_limit'])}"
        if c["hours_earliest"] is not None:
            latest = "or never" if c["hours_latest"] is None else _hours(c["hours_latest"])
            when += f" ({_hours(c['hours_earliest'])} to {latest})"
        when += "."
    window = c.get("window")
    stop = (
        f" Next planned stop: {window['starts_at'].astimezone(UTC):%Y-%m-%d %H:%M} UTC"
        + (f" ({window['reason']})." if window["reason"] else ".")
        if window
        else " No planned stop comes before it."
    )
    return (
        f"Drafted by Tiles from remaining life: {c['tag']} is at {level}, its wear limit {c['limit']:g}{unit}. "
        + when
        + stop
    )


def run(conn: Conn, site_id: uuid.UUID, now: datetime | None = None) -> list[int]:
    """Drafts the site's due work orders; their numbers."""
    now = now or datetime.now(UTC)
    site = one(conn.execute("SELECT org_id, work_order_lead_days FROM sites WHERE id = %s", [site_id]).fetchone())
    if site["work_order_lead_days"] is None:
        return []
    lead = timedelta(days=site["work_order_lead_days"])
    # As the API's remaining life sees it, read with the role of an engineer (it only reads).
    tiles = User(uuid.UUID(int=0), DRAFTER, "", "engineer")
    ctx = SiteContext(conn, site_id, site["org_id"], tiles)
    components, _ = api_remaining_life.assess(ctx, None, None)  # every component, not the page's first 50
    made = []
    for c in components:
        hours = c["hours_to_limit"]
        if hours is None:
            continue
        # From now, not from its latest reading: a tag whose readings stopped is due all the sooner.
        limit_at = c["end"] + timedelta(hours=hours)
        if limit_at - now > lead:
            continue
        if api_work_orders.open_for_component(conn, site_id, c["signal_id"]) is not None:
            continue
        window = c.get("window")
        number = api_work_orders.insert(
            conn,
            site_id,
            source="remaining_life",
            warning_id=None,
            signal_id=c["signal_id"],
            asset=api_work_orders.machine_asset(conn, site_id, c["signal_id"]),
            title=f"Replace {c['component']} on {c['machine_label']} before its wear limit"[:200],
            description=_description(c)[:4000],
            priority="high" if limit_at - now <= URGENT else "medium",
            due_at=window["starts_at"] if window else limit_at,
            drafted_by_id=None,
            drafted_by=DRAFTER,
        )
        audit.record(
            conn,
            org_id=site["org_id"],
            site_id=site_id,
            actor_id=None,
            actor_name=DRAFTER,
            action="work_order.draft",
            entity_type="work_order",
            entity_id=str(number),
            after=api_work_orders.audited(api_work_orders.get(ctx, number)),
        )
        made.append(number)
    return made


@telemetry.job_main("tiles-draft-work-orders")
def main(argv: list[str] | None = None) -> None:
    """`tiles-draft-work-orders`: drafts a work order for each component nearing its wear limit on the
    sites that ask for it, e.g. hourly from cron."""
    parser = argparse.ArgumentParser(prog="tiles-draft-work-orders", description=main.__doc__)
    parser.add_argument("--site", type=uuid.UUID, help="only this site (its id)")
    args = parser.parse_args(argv)

    def run_one(conn: Conn, site_id: uuid.UUID) -> tuple[str, bool]:
        made = run(conn, site_id)
        return f"{len(made)} work order(s) drafted" + (f": {', '.join(map(str, made))}" if made else ""), True

    jobs.run_each(lambda conn: due(conn, args.site), run_one)
