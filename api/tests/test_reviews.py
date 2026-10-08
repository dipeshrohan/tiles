"""Change approval (T2.12): a change request, its review, approval (a commit) or rejection, and rework."""

import threading
import time
from typing import Any

import psycopg
from fastapi.testclient import TestClient
from test_agents import ADMIN, ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures

ENG2 = {"X-Tiles-User": "eng2@example.com"}
NODE = {"id": "machine-press-9", "type": "Machine", "label": "Press 9", "props": {}}


def base(site: str) -> str:  # noqa: F811
    return f"/sites/{site}/ontology"


def stage(api: TestClient, site: str, *ops: dict[str, Any], who: dict[str, str] = ENG) -> None:  # noqa: F811
    res = api.post(f"{base(site)}/staged/batch", json=list(ops), headers=who)
    assert res.status_code == 201, res.text


def ask(api: TestClient, site: str, who: dict[str, str] = ENG, **body: Any) -> dict[str, Any]:  # noqa: F811
    res = api.post(f"{base(site)}/reviews", json=body, headers=who)
    assert res.status_code == 201, res.text
    review: dict[str, Any] = res.json()
    return review


def member(api: TestClient, site: str, who: dict[str, str]) -> str:  # noqa: F811
    me: dict[str, Any] = api.get(f"/sites/{site}/me", headers=who).json()
    return str(me["user_id"])


def require_review(api: TestClient, site: str, required: bool = True) -> None:  # noqa: F811
    res = api.put(f"{base(site)}/review-policy", json={"required": required}, headers=ADMIN)
    assert res.status_code == 200, res.text


def test_a_change_is_requested_reviewed_and_committed_with_its_author_and_reviewer(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    member(api, site, ENG2)
    stage(api, site, {"kind": "addNode", "node": NODE})
    review = ask(api, site, message="  Add press 9 ")
    assert (review["number"], review["message"], review["status"], review["author"]) == (
        1,
        "Add press 9",
        "open",
        "eng",
    )
    assert review["ops"] == [{"kind": "addNode", "node": NODE}]
    assert (review["stats"], review["conflict"], review["thread"]) == ({"nodes": 1, "edges": 0, "props": 0}, None, [])
    # The staged changes moved into the request; nothing is committed yet.
    assert api.get(f"{base(site)}/staged", headers=ENG).json() == []
    assert "machine-press-9" not in api.get(f"{base(site)}/graph?view=head", headers=ENG).json()["nodes"]
    assert [r["number"] for r in api.get(f"{base(site)}/reviews", headers=VIEWER).json()] == [1]

    path = f"{base(site)}/reviews/1"
    assert api.post(f"{path}/comments", json={"body": "Which line?"}, headers=VIEWER).status_code == 403
    assert api.post(f"{path}/comments", json={"body": "  "}, headers=ENG2).status_code == 422
    assert api.post(f"{path}/comments", json={"body": "Which line?"}, headers=ENG2).json()["comments"] == 1
    # Not by the author, nor a viewer.
    own = api.post(f"{path}/approve", json={}, headers=ENG)
    assert (own.status_code, own.json()["detail"]) == (403, "You can't review your own change: ask another engineer")
    assert api.post(f"{path}/approve", json={}, headers=VIEWER).status_code == 403

    approved = api.post(f"{path}/approve", json={"comment": "Looks right"}, headers=ENG2)
    assert approved.status_code == 200, approved.text
    body = approved.json()
    assert (body["status"], body["decided_by"], body["conflict"]) == ("approved", "eng2", None)
    assert [(c["author"], c["body"], c["verdict"]) for c in body["thread"]] == [
        ("eng2", "Which line?", None),
        ("eng2", "Looks right", "approved"),
    ]
    latest = api.get(f"{base(site)}/commits", headers=VIEWER).json()[0]
    assert (latest["id"], latest["message"], latest["author"], latest["reviewer"]) == (
        body["commit_id"],
        "Add press 9",
        "eng",
        "eng2",
    )
    assert "machine-press-9" in api.get(f"{base(site)}/graph?view=head", headers=ENG).json()["nodes"]
    assert api.get(f"{base(site)}/reviews", headers=VIEWER).json() == []
    assert [r["status"] for r in api.get(f"{base(site)}/reviews?state=closed", headers=VIEWER).json()] == ["approved"]
    again = api.post(f"{path}/approve", json={}, headers=ADMIN)
    assert (again.status_code, again.json()["detail"]) == (409, "Change request #1 is already approved")

    with psycopg.connect(database_url) as conn:
        actions = [
            r[0]
            for r in conn.execute(
                "SELECT action FROM audit_log WHERE site_id = %s AND action LIKE 'ontology.review%%' ORDER BY id",
                [site],
            )
        ]
    assert actions == ["ontology.review.request", "ontology.review.comment", "ontology.review.approve"]


def test_a_rejected_change_is_reworked_and_sent_again(api: TestClient, site: str) -> None:  # noqa: F811
    member(api, site, ENG2)
    stage(api, site, {"kind": "addNode", "node": NODE})
    ask(api, site, message="Add press 9")
    path = f"{base(site)}/reviews/1"
    assert api.post(f"{path}/reject", json={"comment": " "}, headers=ENG2).status_code == 422  # say why
    rejected = api.post(f"{path}/reject", json={"comment": "It's Press 8"}, headers=ENG2).json()
    assert (rejected["status"], rejected["thread"][-1]["verdict"]) == ("rejected", "rejected")
    assert api.post(f"{path}/approve", json={}, headers=ENG2).status_code == 409

    assert api.post(f"{path}/rework", headers=ENG2).status_code == 403  # the author's to rework
    reworked = api.post(f"{path}/rework", headers=ENG)
    assert reworked.status_code == 200 and reworked.json()["status"] == "rejected"
    assert api.get(f"{base(site)}/staged", headers=ENG).json() == [{"kind": "addNode", "node": NODE}]
    # Staged again: reworking once more would stage it twice.
    twice = api.post(f"{path}/rework", headers=ENG)
    assert (twice.status_code, twice.json()["detail"]) == (409, "Commit, send or discard your staged changes first")

    stage(api, site, {"kind": "setProp", "id": "machine-press-9", "key": "label", "value": "Press 8"})
    second = ask(api, site, message="Add press 8")
    assert (second["number"], second["stats"]) == (2, {"nodes": 1, "edges": 0, "props": 1})


def test_withdrawing_an_open_request_returns_it_to_the_author(api: TestClient, site: str) -> None:  # noqa: F811
    stage(api, site, {"kind": "addNode", "node": NODE})
    ask(api, site, message="Add press 9")
    withdrawn = api.post(f"{base(site)}/reviews/1/rework", headers=ENG).json()
    assert (withdrawn["status"], withdrawn["decided_by"], withdrawn["thread"][0]["verdict"]) == (
        "withdrawn",
        "eng",
        "withdrawn",
    )
    assert api.get(f"{base(site)}/staged", headers=ENG).json() == [{"kind": "addNode", "node": NODE}]
    assert api.post(f"{base(site)}/reviews/1/approve", json={}, headers=ADMIN).status_code == 409


def test_a_change_that_no_longer_fits_cannot_be_approved(api: TestClient, site: str) -> None:  # noqa: F811
    member(api, site, ENG2)
    stage(api, site, {"kind": "addNode", "node": NODE})
    ask(api, site, message="Add press 9")
    # Meanwhile someone else commits a node with the same id.
    stage(api, site, {"kind": "addNode", "node": {**NODE, "label": "Other press"}}, who=ENG2)
    assert api.post(f"{base(site)}/commits", json={"message": "other"}, headers=ENG2).status_code == 201
    review = api.get(f"{base(site)}/reviews/1", headers=VIEWER).json()
    assert review["conflict"] == "Node machine-press-9 already exists"
    res = api.post(f"{base(site)}/reviews/1/approve", json={}, headers=ENG2)
    assert res.status_code == 409 and "no longer fits the ontology" in res.json()["detail"]
    assert api.get(f"{base(site)}/reviews/1", headers=VIEWER).json()["status"] == "open"  # nothing changed
    rework = api.post(f"{base(site)}/reviews/1/rework", headers=ENG)
    assert rework.status_code == 409 and "Make it again instead" in rework.json()["detail"]


def test_requests_are_checked(api: TestClient, site: str) -> None:  # noqa: F811
    path = f"{base(site)}/reviews"
    nothing = api.post(path, json={"message": "x"}, headers=ENG)
    assert (nothing.status_code, nothing.json()["detail"]) == (409, "Nothing to review: stage some changes first")
    stage(api, site, {"kind": "addNode", "node": NODE})
    assert api.post(path, json={"message": " "}, headers=ENG).status_code == 422
    assert api.post(path, json={"message": "a\x00"}, headers=ENG).status_code == 422
    assert api.post(path, json={"message": "x"}, headers=VIEWER).status_code == 403
    eng = member(api, site, ENG)
    viewer = member(api, site, VIEWER)
    for reviewer in (eng, viewer, "00000000-0000-0000-0000-000000000000"):  # yourself, a viewer, no member
        assert api.post(path, json={"message": "x", "reviewer_id": reviewer}, headers=ENG).status_code == 422
    assert api.post(path, json={"message": "x", "reverts": "nope"}, headers=ENG).status_code == 409  # staged first
    assert api.get(f"{path}/7", headers=VIEWER).status_code == 404
    assert api.get(f"{base(site)}/staged", headers=ENG).json() != []  # a refused request keeps them staged


def test_a_named_reviewer_or_an_admin_decides(api: TestClient, site: str) -> None:  # noqa: F811
    eng2 = member(api, site, ENG2)
    other = {"X-Tiles-User": "eng3@example.com"}
    member(api, site, other)
    stage(api, site, {"kind": "addNode", "node": NODE})
    review = ask(api, site, message="Add press 9", reviewer_id=eng2)
    assert (review["reviewer"], review["reviewer_id"]) == ("eng2", eng2)
    path = f"{base(site)}/reviews/1"
    res = api.post(f"{path}/reject", json={"comment": "no"}, headers=other)
    assert (res.status_code, res.json()["detail"]) == (403, "Change request #1 waits for eng2 (or an admin)")
    assert api.post(f"{path}/approve", json={}, headers=ADMIN).json()["decided_by"] == "admin"


def test_a_site_can_require_a_review_for_every_change(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    member(api, site, ENG2)
    policy = f"{base(site)}/review-policy"
    assert api.get(policy, headers=VIEWER).json() == {"required": False}
    assert api.put(policy, json={"required": True}, headers=ENG).status_code == 403
    assert api.put(policy, json={"required": 1}, headers=ADMIN).status_code == 422
    require_review(api, site)
    require_review(api, site)  # no change: audited once
    assert api.get(policy, headers=VIEWER).json() == {"required": True}

    stage(api, site, {"kind": "addNode", "node": NODE})
    direct = api.post(f"{base(site)}/commits", json={"message": "Add press 9"}, headers=ENG)
    assert (direct.status_code, direct.json()["detail"]) == (
        409,
        "This site requires a review: request one instead of committing",
    )
    ask(api, site, message="Add press 9")
    commit_id = api.post(f"{base(site)}/reviews/1/approve", json={}, headers=ENG2).json()["commit_id"]

    # A revert goes through a review too.
    assert api.post(f"{base(site)}/commits/{commit_id}/revert", headers=ENG).status_code == 409
    revert = ask(api, site, reverts=commit_id)
    assert (revert["message"], revert["reverts"], revert["ops"]) == (
        'Revert "Add press 9"',
        commit_id,
        [{"kind": "removeNode", "id": "machine-press-9"}],
    )
    assert api.post(f"{base(site)}/reviews", json={"reverts": "c-none"}, headers=ENG).status_code == 404
    done = api.post(f"{base(site)}/reviews/2/approve", json={}, headers=ENG2).json()
    assert "machine-press-9" not in api.get(f"{base(site)}/graph?view=head", headers=ENG).json()["nodes"]
    with psycopg.connect(database_url) as conn:
        reverts = conn.execute(
            "SELECT reverts FROM commits WHERE site_id = %s AND id = %s", [site, done["commit_id"]]
        ).fetchone()
        policy_changes = conn.execute(
            "SELECT count(*) FROM audit_log WHERE site_id = %s AND action = 'ontology.review_policy'", [site]
        ).fetchone()
    assert reverts == (commit_id,)
    assert policy_changes == (1,)

    require_review(api, site, False)
    stage(api, site, {"kind": "addNode", "node": NODE})
    assert api.post(f"{base(site)}/commits", json={"message": "Add press 9"}, headers=ENG).status_code == 201


def test_two_approvals_at_once_commit_once(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    member(api, site, ENG2)
    stage(api, site, {"kind": "addNode", "node": NODE})
    ask(api, site, message="Add press 9")
    answers: list[int] = []
    with psycopg.connect(database_url) as other:
        other.execute("SELECT 1 FROM sites WHERE id = %s FOR UPDATE", [site])  # a commit in progress holds the site
        approvals = [
            threading.Thread(
                target=lambda who=who: answers.append(
                    api.post(f"{base(site)}/reviews/1/approve", json={}, headers=who).status_code
                )
            )
            for who in (ENG2, ADMIN)
        ]
        for t in approvals:
            t.start()
        time.sleep(0.3)
        other.commit()
        for t in approvals:
            t.join(10)
    assert sorted(answers) == [200, 409]
    commits = api.get(f"{base(site)}/commits", headers=VIEWER).json()
    assert [c["message"] for c in commits].count("Add press 9") == 1
