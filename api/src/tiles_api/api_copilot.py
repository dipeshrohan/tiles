"""The copilot over HTTP (T4.01): each user's conversations on a site, and questions answered by
Claude with tool use, streamed as server-sent events.

`POST …/conversations/{id}/messages` stores the question, then streams the answer:
`text` (a piece of the answer as it is written), `tool_use` and `tool_result` (a tool the model
called, and whether it answered), then `done` (with the tokens used) or `error`. Every message of
the exchange is stored as it completes, so the next question carries the whole conversation.

Conversations are private to their user. Anyone on the site may use the copilot: its tools only
read, as the user who asked. It is off until TILES_ANTHROPIC_API_KEY and TILES_COPILOT_MODEL are
set.
"""

import json
import logging
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field

from tiles_api import assistant
from tiles_api.api_ontology import Ctx, SiteContext
from tiles_api.copilot_tools import tools_for
from tiles_api.store import Conn, one

router = APIRouter(tags=["copilot"])
log = logging.getLogger("tiles_api.copilot")

MAX_MESSAGES = 200  # stored per conversation (each tool round adds two)
MAX_HISTORY_CHARS = 400_000  # about 100,000 tokens of conversation sent with each question
BUSY_MINUTES = 10  # an answer that has stored nothing for this long is taken as lost
NO_NUL = r"^[^\x00]*$"  # PostgreSQL text can't hold NUL


class Status(BaseModel):
    configured: bool


class ConversationIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Annotated[str, Field(max_length=200, pattern=NO_NUL)] = ""


class Conversation(BaseModel):
    id: uuid.UUID
    title: str
    created_at: datetime
    updated_at: datetime
    messages: int
    input_tokens: int
    output_tokens: int


class Message(BaseModel):
    seq: int
    role: str
    content: list[dict[str, Any]]  # Messages API content blocks: text, tool_use, tool_result
    created_at: datetime


class ConversationDetail(Conversation):
    history: list[Message]


class AskIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: Annotated[str, Field(min_length=1, max_length=8000, pattern=NO_NUL)]


def model_for(request: Request) -> assistant.Model | None:
    """The model to answer with: the one tests set, or Claude when the settings name a key and a
    model; None while the copilot is off."""
    state = request.app.state
    if state.copilot_model is not None:
        model: assistant.Model = state.copilot_model
        return model
    settings = state.settings
    key = settings.anthropic_api_key.get_secret_value() if settings.anthropic_api_key else ""
    if not key or not settings.copilot_model:  # unset, or set empty (as Compose passes an unset one)
        return None
    if state.copilot_client is None:
        import anthropic

        state.copilot_client = anthropic.Anthropic(api_key=key, max_retries=2, timeout=120)
    return assistant.AnthropicModel(state.copilot_client, settings.copilot_model, settings.copilot_max_tokens)


CONVERSATIONS = """
SELECT c.id, c.title, c.created_at, c.updated_at, c.input_tokens, c.output_tokens,
       (SELECT count(*) FROM conversation_messages m WHERE m.conversation_id = c.id) AS messages
FROM conversations c WHERE c.site_id = %s AND c.user_id = %s
"""


def _own(ctx: SiteContext, conversation_id: uuid.UUID, *, lock: bool = False) -> dict[str, Any]:
    """The user's own conversation (another user's is not found)."""
    if lock:
        ctx.conn.execute(
            "SELECT 1 FROM conversations WHERE id = %s AND site_id = %s AND user_id = %s FOR UPDATE",
            [conversation_id, ctx.site_id, ctx.user.id],
        )
    row = ctx.conn.execute(CONVERSATIONS + " AND c.id = %s", [ctx.site_id, ctx.user.id, conversation_id]).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such conversation")
    return row


def _history(conn: Conn, conversation_id: uuid.UUID) -> list[dict[str, Any]]:
    return conn.execute(
        "SELECT seq, role, content, created_at FROM conversation_messages WHERE conversation_id = %s ORDER BY seq",
        [conversation_id],
    ).fetchall()


@router.get("/sites/{site_id}/copilot", response_model=Status)
def copilot_status(ctx: Ctx, request: Request) -> dict[str, Any]:
    return {"configured": model_for(request) is not None}


@router.get("/sites/{site_id}/copilot/conversations", response_model=list[Conversation])
def list_conversations(ctx: Ctx) -> list[dict[str, Any]]:
    """Your conversations on this site, the latest first."""
    return ctx.conn.execute(
        CONVERSATIONS + " ORDER BY c.updated_at DESC LIMIT 100", [ctx.site_id, ctx.user.id]
    ).fetchall()


@router.post("/sites/{site_id}/copilot/conversations", response_model=Conversation, status_code=status.HTTP_201_CREATED)
def create_conversation(ctx: Ctx, body: ConversationIn) -> dict[str, Any]:
    row = one(
        ctx.conn.execute(
            "INSERT INTO conversations (site_id, user_id, title) VALUES (%s, %s, %s) RETURNING id",
            [ctx.site_id, ctx.user.id, body.title.strip()],
        ).fetchone()
    )
    ctx.audit("copilot.conversation.create", "conversation", str(row["id"]))
    return _own(ctx, row["id"])


@router.get("/sites/{site_id}/copilot/conversations/{conversation_id}", response_model=ConversationDetail)
def get_conversation(ctx: Ctx, conversation_id: uuid.UUID) -> dict[str, Any]:
    return _own(ctx, conversation_id) | {"history": _history(ctx.conn, conversation_id)}


@router.delete("/sites/{site_id}/copilot/conversations/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_conversation(ctx: Ctx, conversation_id: uuid.UUID) -> None:
    _own(ctx, conversation_id, lock=True)
    if _busy(ctx.conn, conversation_id):
        raise HTTPException(status.HTTP_409_CONFLICT, "The copilot is still answering in this conversation")
    ctx.conn.execute("DELETE FROM conversations WHERE id = %s", [conversation_id])
    ctx.audit("copilot.conversation.delete", "conversation", str(conversation_id))


def _busy(conn: Conn, conversation_id: uuid.UUID) -> bool:
    return bool(
        one(
            conn.execute(
                "SELECT coalesce(busy_since > now() - %s * interval '1 minute', false) AS busy"
                " FROM conversations WHERE id = %s",
                [BUSY_MINUTES, conversation_id],
            ).fetchone()
        )["busy"]
    )


# The next message of a conversation, numbered after the last one stored.
STORE = """
INSERT INTO conversation_messages (conversation_id, seq, role, content)
SELECT %(c)s, coalesce(max(seq), -1) + 1, %(role)s, %(content)s FROM conversation_messages WHERE conversation_id = %(c)s
"""


def _event(kind: str, data: dict[str, Any]) -> str:
    return f"event: {kind}\ndata: {json.dumps(data, default=str, ensure_ascii=False)}\n\n"


@router.post("/sites/{site_id}/copilot/conversations/{conversation_id}/messages")
def ask(ctx: Ctx, request: Request, conversation_id: uuid.UUID, body: AskIn) -> StreamingResponse:
    """Ask a question in the conversation; the answer streams back as server-sent events."""
    model = model_for(request)
    if model is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "The copilot is off: set TILES_ANTHROPIC_API_KEY and TILES_COPILOT_MODEL on the API",
        )
    conversation = _own(ctx, conversation_id, lock=True)
    settings = request.app.state.settings
    if _busy(ctx.conn, conversation_id):
        raise HTTPException(status.HTTP_409_CONFLICT, "The copilot is still answering in this conversation")
    text = body.text.strip()
    if not text:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Ask a question")
    stored = _history(ctx.conn, conversation_id)
    # Room for the question and every round of its answer, and a conversation the model can still read.
    if conversation["messages"] + 1 + 2 * settings.copilot_max_rounds > MAX_MESSAGES:
        raise HTTPException(status.HTTP_409_CONFLICT, "This conversation is full: start a new one")
    if sum(len(json.dumps(m["content"])) for m in stored) > MAX_HISTORY_CHARS:
        raise HTTPException(status.HTTP_409_CONFLICT, "This conversation is too long to carry on: start a new one")
    question = {"role": "user", "content": [{"type": "text", "text": text}]}
    history = assistant.repaired([*stored, question])
    ctx.conn.execute(STORE, {"c": conversation_id, "role": "user", "content": Jsonb(question["content"])})
    ctx.conn.execute(
        """
        UPDATE conversations SET busy_since = now(), updated_at = now(),
                                 title = CASE WHEN title = '' THEN left(%s, 80) ELSE title END
        WHERE id = %s
        """,
        [text, conversation_id],
    )
    ctx.audit("copilot.ask", "conversation", str(conversation_id), after={"chars": len(text)})
    names = one(
        ctx.conn.execute(
            "SELECT s.name AS site, o.name AS org FROM sites s JOIN orgs o ON o.id = s.org_id WHERE s.id = %s",
            [ctx.site_id],
        ).fetchone()
    )
    pool = request.app.state.pool
    site_id, org_id, user = ctx.site_id, ctx.org_id, ctx.user

    @contextmanager
    def open_ctx() -> Iterator[SiteContext]:
        with pool.connection() as conn:
            yield SiteContext(conn, site_id, org_id, user)

    def stream() -> Iterator[str]:
        usage: dict[str, int] = {}  # every call's, so a broken-off answer is counted too
        try:
            events = assistant.respond(
                model,
                assistant.SYSTEM.format(site=names["site"], org=names["org"]),
                history,
                assistant_tools,
                settings.copilot_max_rounds,
            )
            for event in events:
                if event.kind == "usage":
                    for k, v in event.data.items():
                        usage[k] = usage.get(k, 0) + v
                    continue
                if event.kind == "message":
                    with pool.connection() as conn:  # stored, and the answer's lease renewed
                        conn.execute(
                            STORE,
                            {"c": conversation_id, "role": event.data["role"], "content": Jsonb(event.data["content"])},
                        )
                        conn.execute("UPDATE conversations SET busy_since = now() WHERE id = %s", [conversation_id])
                    continue
                yield _event(event.kind, event.data)
        except Exception:
            log.exception("copilot answer failed", extra={"conversation": str(conversation_id)})
            yield _event("error", {"detail": "The copilot could not answer: try again in a moment"})
        finally:
            with pool.connection() as conn:
                conn.execute(
                    """
                    UPDATE conversations SET busy_since = NULL, updated_at = now(),
                           input_tokens = input_tokens + %s, output_tokens = output_tokens + %s
                    WHERE id = %s
                    """,
                    [usage.get("input_tokens", 0), usage.get("output_tokens", 0), conversation_id],
                )

    assistant_tools = tools_for(open_ctx)
    return StreamingResponse(
        stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    )
