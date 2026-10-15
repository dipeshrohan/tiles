"""In-app feedback (U4.09). Anyone on a site can say what they think of Tiles from any page ("Send
feedback" in the help sheet): a mood, a few words, the page they were on, the version and their
browser, and, if they chose to attach it (having seen it), a screenshot of the page. It is
anonymous unless they chose to give their name: then the row keeps who sent it. The site's admins
list it, open its screenshot and delete it. Sending is audited like any change; without a name, the
entry has neither the sender nor the request's ID, which would lead back to them. Deleting is
audited too."""

import base64
import binascii
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Response, status
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator

from tiles_api import audit
from tiles_api.api_ontology import Admin, Ctx
from tiles_api.errors import Problem
from tiles_api.store import one

router = APIRouter(tags=["Feedback"])

Mood = Literal["unhappy", "neutral", "happy"]
MAX_SCREENSHOT = 2 * 1024 * 1024  # bytes, decoded
# How much feedback one site takes an hour: plenty for people, and a script can't fill the table.
SITE_PER_HOUR = 60
PNG = b"\x89PNG\r\n\x1a\n"
JPEG = b"\xff\xd8\xff"
ANONYMOUS = "Anonymous"


class FeedbackIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mood: Mood
    text: str = Field(min_length=1, max_length=2000, description="What they want to say")
    page: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$", description="The page's id, never its address")
    version: str = Field(pattern=r"^[0-9A-Za-z.+-]{1,32}$", description="The app's version")
    browser: str = Field(max_length=300, description="The browser's user agent")
    named: StrictBool = Field(False, description="Whether to keep who sent it; anonymous otherwise")
    screenshot: str | None = Field(
        None, description="A PNG or JPEG of the page as a data URL (base64), at most 2 MiB decoded"
    )

    @field_validator("text")
    @classmethod
    def _text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Say something about it")
        return value.strip()

    @field_validator("browser")
    @classmethod
    def _browser(cls, value: str) -> str:
        return "".join(c for c in value if c.isprintable())


class Sent(BaseModel):
    id: int


class FeedbackOut(BaseModel):
    id: int
    created_at: datetime
    mood: Mood
    text: str
    page: str
    version: str
    browser: str
    user: str | None = Field(description="Who sent it, when they chose to give their name")
    screenshot: bool = Field(description="Whether a screenshot was attached")


def image(data_url: str) -> bytes:
    """The screenshot's bytes, or a 422: a PNG or JPEG data URL, at most MAX_SCREENSHOT."""
    head, _, data = data_url.partition(",")
    if head not in ("data:image/png;base64", "data:image/jpeg;base64"):
        raise Problem(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "feedback.screenshot_type",
            "The screenshot must be a PNG or JPEG data URL",
        )
    if len(data) > (MAX_SCREENSHOT * 4) // 3 + 4:
        raise Problem(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "feedback.screenshot_too_large",
            "The screenshot is larger than 2 MiB",
        )
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise Problem(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "feedback.screenshot_not_base64", "The screenshot isn't valid base64"
        ) from None
    if len(raw) > MAX_SCREENSHOT:
        raise Problem(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "feedback.screenshot_too_large",
            "The screenshot is larger than 2 MiB",
        )
    if not raw.startswith(PNG if head == "data:image/png;base64" else JPEG):
        raise Problem(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "feedback.screenshot_mismatch",
            "The screenshot isn't the image it says",
        )
    return raw


@router.post("/sites/{site_id}/feedback", response_model=Sent, status_code=status.HTTP_201_CREATED)
def send_feedback(ctx: Ctx, body: FeedbackIn) -> dict[str, int]:
    """Send feedback about Tiles to the site's admins (any member). Anonymous unless `named`; a
    screenshot only if attached. At most 60 an hour per site (429 beyond)."""
    # One sender at a time per site, so the hour's count holds; checked before the screenshot is read.
    ctx.conn.execute("SELECT pg_advisory_xact_lock(hashtext('feedback:' || %s::text))", [ctx.site_id])
    recent = ctx.conn.execute(
        "SELECT count(*) AS n FROM feedback WHERE site_id = %s AND created_at >= now() - interval '1 hour'",
        [ctx.site_id],
    ).fetchone()
    if recent and int(recent["n"]) >= SITE_PER_HOUR:
        raise Problem(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "feedback.too_many",
            "This site has had a lot of feedback this hour. Try again later.",
            headers={"Retry-After": "600"},
        )
    shot = image(body.screenshot) if body.screenshot else None
    new = one(
        ctx.conn.execute(
            """
        INSERT INTO feedback (site_id, mood, body, page, version, browser, user_id, screenshot)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id
        """,
            [
                ctx.site_id,
                body.mood,
                body.text,
                body.page,
                body.version,
                body.browser,
                ctx.user.id if body.named else None,
                shot,
            ],
        ).fetchone()
    )["id"]
    audit.record(
        ctx.conn,
        org_id=ctx.org_id,
        site_id=ctx.site_id,
        actor_id=ctx.user.id if body.named else None,
        actor_name=ctx.user.name if body.named else ANONYMOUS,
        action="feedback.send",
        entity_type="feedback",
        entity_id=str(new),
        after={"mood": body.mood, "page": body.page, "screenshot": shot is not None},
        traceable=body.named,
    )
    return {"id": int(new)}


@router.get("/sites/{site_id}/feedback", response_model=list[FeedbackOut])
def list_feedback(
    ctx: Admin, mood: Mood | None = None, limit: Annotated[int, Query(ge=1, le=200)] = 100
) -> list[dict[str, Any]]:
    """The site's feedback, newest first, without the screenshots themselves (admins)."""
    return ctx.conn.execute(
        """
        SELECT f.id, f.created_at, f.mood, f.body AS text, f.page, f.version, f.browser, u.name AS user,
               f.screenshot IS NOT NULL AS screenshot
        FROM feedback f LEFT JOIN users u ON u.id = f.user_id
        WHERE f.site_id = %s AND (%s::text IS NULL OR f.mood = %s)
        ORDER BY f.created_at DESC, f.id DESC LIMIT %s
        """,
        [ctx.site_id, mood, mood, limit],
    ).fetchall()


@router.get("/sites/{site_id}/feedback/{feedback_id}/screenshot")
def feedback_screenshot(ctx: Admin, feedback_id: int) -> Response:
    """The screenshot attached to a piece of feedback, as it was sent (admins)."""
    row = ctx.conn.execute(
        "SELECT screenshot FROM feedback WHERE site_id = %s AND id = %s", [ctx.site_id, feedback_id]
    ).fetchone()
    if row is None or row["screenshot"] is None:
        raise Problem(status.HTTP_404_NOT_FOUND, "feedback.screenshot_not_found", "No such screenshot on this site")
    raw = bytes(row["screenshot"])
    return Response(
        raw,
        media_type="image/png" if raw.startswith(PNG) else "image/jpeg",
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
            "Cache-Control": "private, no-store",
        },
    )


@router.delete("/sites/{site_id}/feedback/{feedback_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_feedback(ctx: Admin, feedback_id: int) -> Response:
    """Delete a piece of feedback and its screenshot (admins)."""
    row = ctx.conn.execute(
        "DELETE FROM feedback WHERE site_id = %s AND id = %s RETURNING mood, page",
        [ctx.site_id, feedback_id],
    ).fetchone()
    if row is None:
        raise Problem(status.HTTP_404_NOT_FOUND, "feedback.not_found", "No such feedback on this site")
    ctx.audit("feedback.delete", "feedback", str(feedback_id), before={"mood": row["mood"], "page": row["page"]})
    return Response(status_code=status.HTTP_204_NO_CONTENT)
