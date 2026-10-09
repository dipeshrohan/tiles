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
BUSY_MINUTES = 5  # a question still answering after this long is taken as lost


class Status(BaseModel):
    configured: bool


class ConversationIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Annotated[str, Field(max_length=200)] = ""


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
    text: Annotated[str, Field(min_length=1, max_length=8000)]


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


def sound(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The stored messages as the model can take them: a tool call whose results were never stored
    (the answer broke off) is left out, or the Messages API would refuse the conversation."""
    out = [{"role": m["role"], "content": m["content"]} for m in messages]
    while out and out[-1]["role"] == "assistant" and any(b.get("type") == "tool_use" for b in out[-1]["content"]):
        out.pop()
    return out


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
    ctx.conn.execute("DELETE FROM conversations WHERE id = %s", [conversation_id])
    ctx.audit("copilot.conversation.delete", "conversation", str(conversation_id))


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
    busy = one(
        ctx.conn.execute(
            "SELECT busy_since > now() - %s * interval '1 minute' AS busy FROM conversations WHERE id = %s",
            [BUSY_MINUTES, conversation_id],
        ).fetchone()
    )["busy"]
    if busy:
        raise HTTPException(status.HTTP_409_CONFLICT, "The copilot is still answering in this conversation")
    if conversation["messages"] >= MAX_MESSAGES:
        raise HTTPException(status.HTTP_409_CONFLICT, "This conversation is full: start a new one")
    text = body.text.strip()
    if not text:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Ask a question")
    question = {"role": "user", "content": [{"type": "text", "text": text}]}
    history = [*sound(_history(ctx.conn, conversation_id)), question]
    seq = conversation["messages"]
    ctx.conn.execute(
        "INSERT INTO conversation_messages (conversation_id, seq, role, content) VALUES (%s, %s, 'user', %s)",
        [conversation_id, seq, Jsonb(question["content"])],
    )
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
    settings = request.app.state.settings

    @contextmanager
    def open_ctx() -> Iterator[SiteContext]:
        with pool.connection() as conn:
            yield SiteContext(conn, site_id, org_id, user)

    def stream() -> Iterator[str]:
        nonlocal seq
        usage: dict[str, int] = {}
        try:
            events = assistant.respond(
                model,
                assistant.SYSTEM.format(site=names["site"], org=names["org"]),
                history,
                assistant_tools,
                settings.copilot_max_rounds,
            )
            for event in events:
                if event.kind == "message":
                    seq += 1
                    with pool.connection() as conn:
                        conn.execute(
                            "INSERT INTO conversation_messages (conversation_id, seq, role, content)"
                            " VALUES (%s, %s, %s, %s)",
                            [conversation_id, seq, event.data["role"], Jsonb(event.data["content"])],
                        )
                    continue
                if event.kind in ("done", "error"):
                    usage = event.data.get("usage", usage)
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
