"""Copilot cost and latency controls (T4.07): rate limits and token budgets refuse a question with
429 and Retry-After, every question's tokens and times are recorded, and admins read the usage."""

from collections.abc import Iterator
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from test_agents import ADMIN, ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_assistant import Scripted, call, text
from test_copilot import ask, start

from tiles_api import grounding
from tiles_api.assistant import Turn

DECLINE = grounding.DECLINE + ": nothing on the site answers it."


@pytest.fixture
def model(api: TestClient) -> Iterator[Scripted]:  # noqa: F811
    stand_in = Scripted()
    api.app.state.copilot_model = stand_in  # type: ignore[attr-defined]
    yield stand_in
    api.app.state.copilot_model = None  # type: ignore[attr-defined]


@pytest.fixture
def settings(api: TestClient) -> Any:  # noqa: F811
    return api.app.state.settings  # type: ignore[attr-defined]


def declines(model: Scripted, n: int, usage: dict[str, int] | None = None) -> None:
    for _ in range(n):
        model.script.append(([DECLINE], Turn([text(DECLINE)], "end_turn", usage or {"input_tokens": 10})))


def rows(database_url: str) -> list[dict[str, Any]]:
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        return conn.execute("SELECT * FROM copilot_usage ORDER BY id").fetchall()


def test_each_question_records_its_tokens_times_and_outcome(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    model: Scripted,
    database_url: str,
) -> None:
    model.script += [
        (
            [],
            Turn([call("site_overview", {})], "tool_use", {"input_tokens": 1000, "cache_creation_input_tokens": 3000}),
        ),
        (
            ["Nothing", " found."],
            Turn(
                [text(DECLINE)], "end_turn", {"input_tokens": 50, "cache_read_input_tokens": 4000, "output_tokens": 30}
            ),
        ),
    ]
    conversation = start(api, site)
    assert ask(api, site, conversation, "What runs here?").status_code == 200
    [row] = rows(database_url)
    assert row["outcome"] == "answered"
    assert row["model_calls"] == 2
    assert (row["input_tokens"], row["output_tokens"]) == (1050, 30)
    assert (row["cache_write_tokens"], row["cache_read_tokens"]) == (3000, 4000)
    assert row["billed_tokens"] == 1050 + 30 + 3000 + 400
    assert str(row["conversation_id"]) == conversation
    assert row["first_text_ms"] is not None and row["total_ms"] is not None
    assert 0 <= row["first_text_ms"] <= row["total_ms"]
    assert row["finished_at"] is not None


def test_a_question_over_its_budget_stops_and_says_so(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    model: Scripted,
    settings: Any,
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "copilot_question_tokens", 1500)
    model.script += [
        ([], Turn([call("site_overview", {}, f"t{i}")], "tool_use", {"input_tokens": 1000})) for i in range(2)
    ]
    res = ask(api, site, start(api, site), "Everything, please")
    assert '"over_budget": true' in res.text
    assert "budget of 1,500 tokens" in res.text
    assert model.script == []  # the third call was never made
    [row] = rows(database_url)
    assert (row["outcome"], row["model_calls"], row["billed_tokens"]) == ("over_budget", 2, 2000)


def test_rate_limits_per_user_and_per_organisation(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    model: Scripted,
    settings: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "copilot_user_questions_per_minute", 2)
    monkeypatch.setattr(settings, "copilot_org_questions_per_minute", 3)
    declines(model, 3)
    mine = start(api, site)
    assert ask(api, site, mine, "One").status_code == 200
    assert ask(api, site, mine, "Two").status_code == 200
    res = ask(api, site, mine, "Three")
    assert res.status_code == 429
    assert res.json()["detail"] == "You have asked 2 questions in the last minute: wait a moment"
    assert 1 <= int(res.headers["Retry-After"]) <= 60
    # The refused question wasn't stored or counted.
    detail = api.get(f"/sites/{site}/copilot/conversations/{mine}", headers=ENG).json()
    assert [m["content"][0]["text"] for m in detail["history"] if m["role"] == "user"] == ["One", "Two"]

    # Someone else may still ask, until the organisation's limit.
    theirs = start(api, site, VIEWER)
    assert ask(api, site, theirs, "Mine?", who=VIEWER).status_code == 200
    res = ask(api, site, theirs, "Again?", who=VIEWER)
    assert res.status_code == 429
    assert res.json()["detail"] == "Your organisation has asked 3 questions in the last minute: wait a moment"
    # 0 turns a limit off.
    monkeypatch.setattr(settings, "copilot_user_questions_per_minute", 0)
    monkeypatch.setattr(settings, "copilot_org_questions_per_minute", 0)
    declines(model, 1)
    assert ask(api, site, mine, "Three").status_code == 200


def test_the_organisations_daily_budget(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    model: Scripted,
    settings: Any,
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "copilot_org_daily_tokens", 5000)
    declines(model, 1, {"input_tokens": 5000})
    conversation = start(api, site)
    assert ask(api, site, conversation, "One").status_code == 200
    res = ask(api, site, conversation, "Two")
    assert res.status_code == 429
    assert res.json()["detail"] == "Your organisation has used its copilot budget of 5,000 tokens for today (UTC)"
    assert 1 <= int(res.headers["Retry-After"]) <= 86_400
    # Yesterday's questions don't count against today.
    with psycopg.connect(database_url) as conn:
        conn.execute("UPDATE copilot_usage SET asked_at = asked_at - interval '1 day'")
    declines(model, 1)
    assert ask(api, site, conversation, "Two").status_code == 200


def test_admins_read_the_sites_usage(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    model: Scripted,
    database_url: str,
) -> None:
    declines(model, 2, {"input_tokens": 100, "output_tokens": 10, "cache_read_input_tokens": 1000})
    ask(api, site, start(api, site), "One")
    ask(api, site, start(api, site, VIEWER), "Two", who=VIEWER)
    # Nothing scripted: the model call fails, and so does the question.
    with psycopg.connect(database_url) as conn:
        conn.execute("UPDATE copilot_usage SET asked_at = asked_at - interval '2 days'")
    ask(api, site, start(api, site), "Three")

    assert api.get(f"/sites/{site}/copilot/usage", headers=ENG).status_code == 403
    usage = api.get(f"/sites/{site}/copilot/usage", headers=ADMIN).json()
    today, earlier = usage["days"]
    assert (today["questions"], today["answered"], today["failed"]) == (1, 0, 1)
    assert (earlier["questions"], earlier["answered"], earlier["billed_tokens"]) == (2, 2, 2 * 210)
    assert earlier["cache_read_tokens"] == 2000
    assert earlier["first_text_p50_ms"] is not None and earlier["total_p95_ms"] is not None
    assert sorted((u["email"], u["questions"], u["billed_tokens"]) for u in usage["users"]) == [
        ("eng@example.com", 2, 210),  # one answered, one failed before any tokens
        ("viewer@example.com", 1, 210),
    ]
    assert usage["today"] == {"org_billed_tokens": 0, "site_billed_tokens": 0}
    assert usage["limits"]["org_daily_tokens"] == 5_000_000
    # Only the last day.
    assert len(api.get(f"/sites/{site}/copilot/usage?days=1", headers=ADMIN).json()["days"]) == 1
    assert api.get(f"/sites/{site}/copilot/usage?days=0", headers=ADMIN).status_code == 422
