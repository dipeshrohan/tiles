"""The menu's counts (U3.06): how many warnings are open on a site, and how many change requests
wait for you to review them, read in two counts rather than lists."""

from fastapi import APIRouter
from pydantic import BaseModel

from tiles_api.api_ontology import Ctx, can_edit

router = APIRouter(tags=["menu"])


class MenuCounts(BaseModel):
    open_warnings: int
    reviews_waiting: int


@router.get("/sites/{site_id}/menu-counts", response_model=MenuCounts)
def menu_counts(ctx: Ctx) -> MenuCounts:
    """What the menu counts for you: the site's warnings not yet resolved, and the open change
    requests you may approve (engineers and admins: not your own, asked of you or of anyone)."""
    warnings = ctx.conn.execute(
        "SELECT count(*) AS n FROM warnings WHERE site_id = %s AND resolved_at IS NULL", [ctx.site_id]
    ).fetchone()
    reviews = None
    if can_edit(ctx.conn, ctx.site_id, ctx.org_id, ctx.user.id):
        reviews = ctx.conn.execute(
            """
            SELECT count(*) AS n FROM change_requests
            WHERE site_id = %(site)s AND status = 'open' AND author_id IS DISTINCT FROM %(me)s
              AND (reviewer_id IS NULL OR reviewer_id = %(me)s)
            """,
            {"site": ctx.site_id, "me": ctx.user.id},
        ).fetchone()
    return MenuCounts(
        open_warnings=int(warnings["n"]) if warnings else 0,
        reviews_waiting=int(reviews["n"]) if reviews else 0,
    )
