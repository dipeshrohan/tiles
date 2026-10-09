"""The copilot over HTTP (T4.01): conversations per user, questions answered with tool calls on
the site's own data and streamed as server-sent events; Claude is a scripted stand-in."""

import json
from collections.abc import Iterator
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from pydantic import SecretStr
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_assistant import Scripted, call, text
from test_series import load

from tiles_api import api_copilot
from tiles_api.assistant import Turn


def events(raw: str) -> list[tuple[str, dict[str, Any]]]:
    out = []
    for block in raw.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        out.append((lines["event"], json.loads(lines["data"])))
    return out


def ask(api: TestClient, site: str, conversation: str, question: str, who: dict[str, str] = ENG) -> Any:  # noqa: F811
    path = f"/sites/{site}/copilot/conversations/{conversation}/messages"
    with api.stream("POST", path, json={"text": question}, headers=who) as res:
        res.read()
    return res


def start(api: TestClient, site: str, who: dict[str, str] = ENG) -> str:  # noqa: F811
    res = api.post(f"/sites/{site}/copilot/conversations", json={}, headers=who)
    assert res.status_code == 201, res.text
    return str(res.json()["id"])


@pytest.fixture
def model(api: TestClient) -> Iterator[Scripted]:  # noqa: F811
    stand_in = Scripted()
    api.app.state.copilot_model = stand_in  # type: ignore[attr-defined]
    yield stand_in
    api.app.state.copilot_model = None  # type: ignore[attr-defined]


def test_the_copilot_is_off_until_configured(api: TestClient, site: str, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: F811
    assert api.get(f"/sites/{site}/copilot", headers=VIEWER).json() == {"configured": False}
    settings = api.app.state.settings  # type: ignore[attr-defined]
    monkeypatch.setattr(api.app.state, "copilot_client", None)  # type: ignore[attr-defined]
    monkeypatch.setattr(settings, "anthropic_api_key", SecretStr(""))  # as Compose passes an unset one
    monkeypatch.setattr(settings, "copilot_model", "stand-in")
    assert api.get(f"/sites/{site}/copilot", headers=VIEWER).json() == {"configured": False}
    monkeypatch.setattr(settings, "anthropic_api_key", SecretStr("sk-test"))
    assert api.get(f"/sites/{site}/copilot", headers=VIEWER).json() == {"configured": True}
    monkeypatch.setattr(settings, "copilot_model", "")
    res = ask(api, site, start(api, site), "Hello?")
    assert res.status_code == 503
    assert "TILES_ANTHROPIC_API_KEY and TILES_COPILOT_MODEL" in res.json()["detail"]


def test_a_question_is_answered_from_the_sites_own_signals(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    model: Scripted,
    database_url: str,
) -> None:
    load(api, site, "press9.oil_temp", [41.5, 42.0])
    assert api.get(f"/sites/{site}/copilot", headers=VIEWER).json() == {"configured": True}
    model.script += [
        (
            ["Looking."],
            Turn([text("Looking."), call("find_signals", {"query": "oil"})], "tool_use", {"input_tokens": 50}),
        ),
        (
            ["press9.oil_temp ", "reads 42."],
            Turn([text("press9.oil_temp reads 42.")], "end_turn", {"input_tokens": 80, "output_tokens": 12}),
        ),
    ]
    conversation = start(api, site)
    res = ask(api, site, conversation, "  Which oil temperatures do we measure?  ")
    assert (res.status_code, res.headers["content-type"].split(";")[0]) == (200, "text/event-stream")
    got = events(res.text)
    assert [k for k, _ in got] == ["text", "tool_use", "tool_result", "text", "text", "done"]
    assert got[1][1] == {"id": "t1", "name": "find_signals", "input": {"query": "oil"}}
    assert got[2][1]["is_error"] is False
    assert got[-1][1]["usage"] == {"input_tokens": 130, "output_tokens": 12}
    # The site's name is in the prompt; the tool read this site's signals.
    assert model.calls[0]["system"].startswith("You are the Tiles copilot for Plant 1, a site of Demo Manufacturing.")
    result = model.calls[1]["messages"][2]["content"][0]
    assert json.loads(result["content"])["signals"][0]["tag"] == "press9.oil_temp"
    assert json.loads(result["content"])["signals"][0]["last_value"] == 42.0

    detail = api.get(f"/sites/{site}/copilot/conversations/{conversation}", headers=ENG).json()
    assert detail["title"] == "Which oil temperatures do we measure?"
    assert [m["role"] for m in detail["history"]] == ["user", "assistant", "user", "assistant"]
    assert detail["history"][0]["content"] == [text("Which oil temperatures do we measure?")]
    assert (detail["messages"], detail["input_tokens"], detail["output_tokens"]) == (4, 130, 12)

    # The next question carries the whole conversation.
    model.script.append((["Yes."], Turn([text("Yes.")], "end_turn")))
    ask(api, site, conversation, "Is that the only one?")
    assert [m["role"] for m in model.calls[2]["messages"]] == ["user", "assistant", "user", "assistant", "user"]
    listed = api.get(f"/sites/{site}/copilot/conversations", headers=ENG).json()
    assert [(c["id"], c["messages"]) for c in listed] == [(conversation, 6)]

    # Private to its user.
    assert api.get(f"/sites/{site}/copilot/conversations", headers=VIEWER).json() == []
    assert api.get(f"/sites/{site}/copilot/conversations/{conversation}", headers=VIEWER).status_code == 404
    assert ask(api, site, conversation, "Mine?", who=VIEWER).status_code == 404
    assert api.delete(f"/sites/{site}/copilot/conversations/{conversation}", headers=VIEWER).status_code == 404
    assert api.delete(f"/sites/{site}/copilot/conversations/{conversation}", headers=ENG).status_code == 204
    assert api.get(f"/sites/{site}/copilot/conversations/{conversation}", headers=ENG).status_code == 404
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        actions = [
            r["action"]
            for r in conn.execute(
                "SELECT action FROM audit_log WHERE entity_id = %s ORDER BY id", [conversation]
            ).fetchall()
        ]
    assert actions == ["copilot.conversation.create", "copilot.ask", "copilot.ask", "copilot.conversation.delete"]


def test_viewers_ask_too_and_one_answer_at_a_time(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    model: Scripted,
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conversation = start(api, site, VIEWER)
    model.script.append((["Hi."], Turn([text("Hi.")], "end_turn")))
    assert ask(api, site, conversation, "Hello?", who=VIEWER).status_code == 200
    with psycopg.connect(database_url) as conn:
        conn.execute("UPDATE conversations SET busy_since = now() WHERE id = %s", [conversation])
    res = ask(api, site, conversation, "Again?", who=VIEWER)
    assert (res.status_code, res.json()["detail"]) == (409, "The copilot is still answering in this conversation")
    with psycopg.connect(database_url) as conn:  # an answer that broke off long ago doesn't block
        conn.execute(
            "UPDATE conversations SET busy_since = now() - interval '10 minutes' WHERE id = %s", [conversation]
        )
    model.script.append((["Hi."], Turn([text("Hi.")], "end_turn")))
    assert ask(api, site, conversation, "Again?", who=VIEWER).status_code == 200
    assert ask(api, site, conversation, " ", who=VIEWER).status_code == 422
    # Room for a question and every round of its answer (8 by default: 17 messages), or it's full.
    monkeypatch.setattr(api_copilot, "MAX_MESSAGES", 4 + 17)
    model.script.append((["Hi."], Turn([text("Hi.")], "end_turn")))
    assert ask(api, site, conversation, "Once more?", who=VIEWER).status_code == 200
    res = ask(api, site, conversation, "More?", who=VIEWER)
    assert (res.status_code, res.json()["detail"]) == (409, "This conversation is full: start a new one")
    monkeypatch.setattr(api_copilot, "MAX_MESSAGES", 200)
    monkeypatch.setattr(api_copilot, "MAX_HISTORY_CHARS", 100)
    res = ask(api, site, conversation, "More?", who=VIEWER)
    assert res.json()["detail"] == "This conversation is too long to carry on: start a new one"


def test_a_broken_answer_says_so_counts_its_tokens_and_leaves_a_usable_conversation(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    model: Scripted,
    database_url: str,
) -> None:
    conversation = start(api, site)
    calls = 0

    def broken(**_: Any) -> Iterator[str | Turn]:
        nonlocal calls
        calls += 1
        if calls == 1:
            yield Turn([call("site_overview", {})], "tool_use", {"input_tokens": 70, "output_tokens": 9})
            return
        yield "Let me"
        raise RuntimeError("connection reset")

    model.stream = broken  # type: ignore[method-assign]
    got = events(ask(api, site, conversation, "What broke?").text)
    assert [k for k, _ in got] == ["tool_use", "tool_result", "text", "error"]
    assert got[-1][1] == {"detail": "The copilot could not answer: try again in a moment"}
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        row = conn.execute(
            "SELECT busy_since, input_tokens, output_tokens FROM conversations WHERE id = %s", [conversation]
        ).fetchone()
        assert row == {"busy_since": None, "input_tokens": 70, "output_tokens": 9}  # the first call is counted
        # A tool call whose results were never stored (the process died between them), then a question.
        conn.execute(
            "INSERT INTO conversation_messages (conversation_id, seq, role, content) VALUES (%s, 3, 'assistant', %s)",
            [conversation, json.dumps([text("Hmm."), call("find_signals", {}, "t9")])],
        )
    del model.stream
    for answer in ("Fine.", "Still fine."):
        model.script.append(([answer], Turn([text(answer)], "end_turn")))
    ask(api, site, conversation, "Now?")
    ask(api, site, conversation, "And now?")  # the broken call is no longer the last message
    sent = model.calls[-1]["messages"]
    assert not [b for m in sent for b in m["content"] if b.get("id") == "t9"]
    assert [m["role"] for m in sent] == ["user", "assistant", "user", "assistant", "user", "assistant", "user"]

    # It can't be deleted while it answers; a NUL can't be stored.
    with psycopg.connect(database_url) as busy_conn:
        busy_conn.execute("UPDATE conversations SET busy_since = now() WHERE id = %s", [conversation])
    res = api.delete(f"/sites/{site}/copilot/conversations/{conversation}", headers=ENG)
    assert (res.status_code, res.json()["detail"]) == (409, "The copilot is still answering in this conversation")
    assert ask(api, site, start(api, site), "a\x00b").status_code == 422
    assert api.post(f"/sites/{site}/copilot/conversations", json={"title": "a\x00"}, headers=ENG).status_code == 422


def test_a_tool_says_what_was_wrong_with_its_input(api: TestClient, site: str, model: Scripted) -> None:  # noqa: F811
    model.script += [
        ([], Turn([call("find_signals", {"limit": "ten"})], "tool_use")),
        ([], Turn([text("Sorry.")], "end_turn")),
    ]
    ask(api, site, start(api, site), "Ten signals?")
    result = model.calls[1]["messages"][-1]["content"][0]
    assert (result["content"], result["is_error"]) == ("limit must be a whole number from 1 to 25", True)
