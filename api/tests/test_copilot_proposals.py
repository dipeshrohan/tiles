"""The copilot proposes ontology changes (T4.09): only for engineers and admins, as a change request
in the name of the person who asked, which that person can't approve; another engineer reviews it
and only their approval commits it."""

import json
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_assistant import Scripted, call, text
from test_copilot import ask, events, start, turn_on
from test_reviews import ENG2, base, member, require_review, stage

from tiles_api import copilot_tools
from tiles_api.api_ontology import SiteContext
from tiles_api.assistant import ToolError, Turn
from tiles_api.identity import User

LINE_NODE = {"id": "line-3", "type": "Line", "label": "Assembly Line 3"}
LINE = {"kind": "addNode", "node": LINE_NODE}
EDGE = {"kind": "addEdge", "edge": {"id": "e-l3", "from": "plant", "rel": "contains", "to": "line-3"}}


@pytest.fixture
def model(api: TestClient, site: str) -> Iterator[Scripted]:  # noqa: F811
    stand_in = Scripted()
    turn_on(api, site)
    api.app.state.copilot_model = stand_in  # type: ignore[attr-defined]
    yield stand_in
    api.app.state.copilot_model = None  # type: ignore[attr-defined]


def head(api: TestClient, site: str) -> dict[str, Any]:  # noqa: F811
    nodes: dict[str, Any] = api.get(f"{base(site)}/graph?view=head", headers=ENG).json()["nodes"]
    return nodes


def committed_plant(api: TestClient, site: str) -> None:  # noqa: F811
    stage(api, site, {"kind": "addNode", "node": {"id": "plant", "type": "Site", "label": "Plant 1"}})
    assert api.post(f"{base(site)}/commits", json={"message": "plant"}, headers=ENG).status_code == 201


def proposing(model: Scripted, ops: list[dict[str, Any]], answer: str) -> None:
    model.script += [
        ([], Turn([call("propose_ontology_change", {"message": "Add line 3 to the plant", "ops": ops})], "tool_use")),
        ([answer], Turn([text(answer)], "end_turn")),
    ]


def test_a_proposal_waits_for_another_engineer(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    model: Scripted,
    database_url: str,
) -> None:
    committed_plant(api, site)
    proposing(model, [LINE, EDGE], "I proposed it as change request 1 [1]; another engineer must approve it.")
    conversation = start(api, site)
    res = ask(api, site, conversation, "Add Assembly Line 3 to the plant")
    got = events(res.text)
    assert "propose_ontology_change" in [t["name"] for t in model.calls[0]["tools"]]
    [result] = [d for k, d in got if k == "tool_result"]
    assert result["is_error"] is False
    stored = model.calls[1]["messages"][-1]["content"][0]["content"]
    assert json.loads(stored.split("\n", 1)[1]) == {
        "change_request": 1,
        "status": "open",
        "changes": {"nodes": 1, "edges": 1, "props": 0},
        "committed": False,
        "next": "Another engineer of the site must approve it on the Change reviews page; until then nothing changes.",
    }
    # Nothing changed yet: it is an open request, by the person who asked, from the copilot.
    assert list(head(api, site)) == ["plant"]
    review = api.get(f"{base(site)}/reviews/1", headers=ENG).json()
    assert (review["status"], review["source"], review["author"]) == ("open", "copilot", review["author"])
    assert review["author_id"] == member(api, site, ENG)
    assert review["ops"] == [{"kind": "addNode", "node": {**LINE_NODE, "props": {}}}, EDGE]
    assert api.get(f"{base(site)}/staged", headers=ENG).json() == []  # their own staged work is untouched

    # The person who asked can't approve it; another engineer can, and that commits it.
    res = api.post(f"{base(site)}/reviews/1/approve", json={}, headers=ENG)
    assert res.status_code == 403
    approved = api.post(f"{base(site)}/reviews/1/approve", json={"comment": "Yes"}, headers=ENG2).json()
    assert approved["status"] == "approved"
    assert sorted(head(api, site)) == ["line-3", "plant"]

    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        entry = conn.execute(
            "SELECT after FROM audit_log WHERE action = 'ontology.review.request' ORDER BY id DESC LIMIT 1"
        ).fetchone()
        stored_conv = conn.execute("SELECT conversation_id FROM change_requests WHERE number = 1").fetchone()
    assert entry is not None and stored_conv is not None
    assert (entry["after"]["source"], entry["after"]["conversation_id"]) == ("copilot", conversation)
    assert str(stored_conv["conversation_id"]) == conversation


def test_viewers_are_not_offered_the_tool(api: TestClient, site: str, model: Scripted) -> None:  # noqa: F811
    model.script.append((["Which line?"], Turn([text("Which line?")], "end_turn")))
    ask(api, site, start(api, site, VIEWER), "Add a line", who=VIEWER)
    assert "propose_ontology_change" not in [t["name"] for t in model.calls[0]["tools"]]


def test_a_proposal_that_does_not_fit_says_why(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    model: Scripted,
) -> None:
    require_review(api, site, False)
    proposing(model, [EDGE], "It can't be proposed [1].")  # the plant node isn't there
    res = ask(api, site, start(api, site), "Put line 3 in the plant")
    [result] = [d for k, d in events(res.text) if k == "tool_result"]
    assert result["is_error"] is True
    reason = model.calls[1]["messages"][-1]["content"][0]["content"]
    assert reason.endswith("Relationship e-l3 points at a missing node")
    assert api.get(f"{base(site)}/reviews", headers=ENG).json() == []


@pytest.fixture
def question(api: TestClient, site: str, database_url: str) -> Any:  # noqa: F811
    """The tools of one question, as the engineer, in a conversation: its propose tool."""

    def tools(conversation: str | None = None) -> Any:
        user = User(uuid.UUID(member(api, site, ENG)), "eng", "eng@example.com", "engineer")

        @contextmanager
        def open_ctx() -> Iterator[SiteContext]:
            with psycopg.connect(database_url, row_factory=dict_row) as conn:
                org = conn.execute("SELECT org_id FROM sites WHERE id = %s", [site]).fetchone()
                assert org
                yield SiteContext(conn, uuid.UUID(site), org["org_id"], user)

        cid = uuid.UUID(conversation) if conversation else None
        made = copilot_tools.tools_for(open_ctx, can_propose=True, conversation_id=cid)
        return lambda **args: {t.name: t for t in made}["propose_ontology_change"].run(args)

    return tools


def refused(propose: Any, **args: Any) -> str:
    with pytest.raises(ToolError) as e:
        propose(**args)
    return str(e.value)


def test_what_a_proposal_may_be(api: TestClient, site: str, question: Any, database_url: str) -> None:  # noqa: F811
    committed_plant(api, site)
    propose = question()
    assert refused(propose, ops=[LINE]).startswith("Give the change request a message")
    assert refused(propose, message="m" * 2001, ops=[LINE]) == "The message has 2001 characters; keep it to 2000"
    assert refused(propose, message="m").startswith("Give `ops`")
    assert refused(propose, message="m", ops=[LINE] * 201) == "At most 200 changes in one proposal: split it"
    assert "kind" in refused(propose, message="m", ops=[{"kind": "paint", "id": "plant"}])
    assert "type" in refused(propose, message="m", ops=[{"kind": "addNode", "node": {"id": "x", "label": "X"}}])
    assert api.get(f"{base(site)}/reviews", headers=ENG).json() == []
    # Even where changes needn't be reviewed, a proposal is a request, never a commit.
    require_review(api, site, False)
    assert propose(message="Add line 3", ops=[LINE])["change_request"] == 1
    assert list(head(api, site)) == ["plant"]
    # One proposal per question: a second call (a withdrawn answer tried again) opens nothing.
    assert refused(propose, message="Add line 3", ops=[LINE]) == (
        "This question already proposed change request #1: refer to it"
    )
    assert len(api.get(f"{base(site)}/reviews", headers=ENG).json()) == 1


def test_a_demoted_engineer_cannot_propose(api: TestClient, site: str, question: Any, database_url: str) -> None:  # noqa: F811
    committed_plant(api, site)
    propose = question()  # asked as an engineer
    with psycopg.connect(database_url) as conn:  # demoted while the answer runs
        conn.execute(
            "UPDATE site_members SET role = 'viewer' WHERE site_id = %s AND user_id = %s",
            [site, member(api, site, ENG)],
        )
    assert refused(propose, message="m", ops=[LINE]) == (
        "Only engineers and admins of the site can propose ontology changes"
    )


def test_the_same_proposal_asked_again_is_the_same_request(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    question: Any,
    database_url: str,
) -> None:
    committed_plant(api, site)
    conversation = start(api, site)
    first = question(conversation)(message="Add line 3", ops=[LINE])
    # The answer broke off before it was stored; the person asks again in the conversation.
    again = question(conversation)(message="Add line 3, please", ops=[LINE])
    assert again["change_request"] == first["change_request"] == 1
    other = question(conversation)(message="Add line 3 and its link", ops=[LINE, EDGE])
    assert other["change_request"] == 2  # other changes are another request
    elsewhere = question(start(api, site))(message="Add line 3", ops=[LINE])
    assert elsewhere["change_request"] == 3  # and so is another conversation
    with psycopg.connect(database_url) as conn:
        audited = conn.execute(
            "SELECT count(*) FROM audit_log WHERE action = 'ontology.review.request' AND site_id = %s", [site]
        ).fetchone()
    assert audited == (3,)
    # A deleted conversation leaves its requests.
    assert api.delete(f"/sites/{site}/copilot/conversations/{conversation}", headers=ENG).status_code == 204
    review = api.get(f"{base(site)}/reviews/1", headers=ENG).json()
    assert (review["status"], review["source"]) == ("open", "copilot")
