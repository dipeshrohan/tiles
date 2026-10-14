"""In-app feedback (U4.09): any member sends it, anonymous unless they give their name, with an
optional screenshot; admins list it, open the screenshot and delete it; sending and deleting are
audited."""

import base64
from typing import Any

import psycopg
from fastapi.testclient import TestClient
from test_agents import ADMIN, ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures

from tiles_api import api_feedback

PNG = base64.b64encode(api_feedback.PNG + b"\x00" * 32).decode()
UA = "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0"


def body(**extra: Any) -> dict[str, Any]:
    return (
        {"mood": "unhappy", "text": "  The chart is hard to read.  ", "page": "explorer", "version": "0.2.0"}
        | {"browser": UA}
        | extra
    )


def audits(database_url: str, entity_id: int) -> list[tuple[Any, ...]]:
    with psycopg.connect(database_url) as conn:
        return conn.execute(
            "SELECT action, actor_id, actor_name, after, before, request_id FROM audit_log"
            " WHERE entity_type = 'feedback' AND entity_id = %s ORDER BY id",
            [str(entity_id)],
        ).fetchall()


def test_feedback_is_anonymous_unless_named_and_admins_list_it(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    # A viewer (an operator) can send it: it changes nothing on the site.
    res = api.post(f"/sites/{site}/feedback", json=body(), headers=VIEWER)
    assert res.status_code == 201, res.text
    anonymous = res.json()["id"]
    named = api.post(
        f"/sites/{site}/feedback",
        json=body(
            mood="happy", text="Love the tours", page="help", named=True, screenshot=f"data:image/png;base64,{PNG}"
        ),
        headers=ENG,
    ).json()["id"]

    # Only admins read it.
    assert api.get(f"/sites/{site}/feedback", headers=ENG).status_code == 403
    rows = api.get(f"/sites/{site}/feedback", headers=ADMIN).json()
    assert [r["id"] for r in rows] == [named, anonymous]  # newest first
    assert rows[1] | {"created_at": None} == {
        "id": anonymous,
        "created_at": None,
        "mood": "unhappy",
        "text": "The chart is hard to read.",
        "page": "explorer",
        "version": "0.2.0",
        "browser": UA,
        "user": None,
        "screenshot": False,
    }
    assert rows[0]["user"] == "eng"  # the name they gave
    assert rows[0]["screenshot"] is True
    assert [r["id"] for r in api.get(f"/sites/{site}/feedback?mood=happy", headers=ADMIN).json()] == [named]

    # The anonymous row keeps no one, in the table or in the audit log.
    with psycopg.connect(database_url) as conn:
        kept = conn.execute("SELECT user_id FROM feedback WHERE id = %s", [anonymous]).fetchone()
    assert kept == (None,)
    # Nor the request's ID, which the API's logs would lead back to them by.
    [(action, actor_id, actor_name, after, _, request_id)] = audits(database_url, anonymous)
    assert (action, actor_id, actor_name, request_id) == ("feedback.send", None, "Anonymous", None)
    assert after == {"mood": "unhappy", "page": "explorer", "screenshot": False}
    [(_, actor_id, _, after, _, request_id)] = audits(database_url, named)
    assert actor_id is not None and request_id and after["screenshot"] is True

    # The screenshot, as sent, for admins only; none for the one without.
    assert api.get(f"/sites/{site}/feedback/{named}/screenshot", headers=ENG).status_code == 403
    shot = api.get(f"/sites/{site}/feedback/{named}/screenshot", headers=ADMIN)
    assert shot.status_code == 200
    assert shot.headers["content-type"] == "image/png"
    assert shot.headers["content-security-policy"] == "sandbox"
    assert shot.content == base64.b64decode(PNG)
    assert api.get(f"/sites/{site}/feedback/{anonymous}/screenshot", headers=ADMIN).status_code == 404

    # Admins delete it, audited.
    assert api.delete(f"/sites/{site}/feedback/{named}", headers=ENG).status_code == 403
    assert api.delete(f"/sites/{site}/feedback/{named}", headers=ADMIN).status_code == 204
    assert api.delete(f"/sites/{site}/feedback/{named}", headers=ADMIN).status_code == 404
    assert [r["id"] for r in api.get(f"/sites/{site}/feedback", headers=ADMIN).json()] == [anonymous]
    assert [(a[0], a[4]) for a in audits(database_url, named)][-1] == (
        "feedback.delete",
        {"mood": "happy", "page": "help"},
    )


def test_feedback_is_checked(api: TestClient, site: str) -> None:  # noqa: F811
    def send(**extra: Any) -> int:
        return api.post(f"/sites/{site}/feedback", json=body(**extra), headers=VIEWER).status_code

    assert send(text="   ") == 422
    assert send(text="x" * 2001) == 422
    assert send(mood="angry") == 422
    assert send(page="#/warnings?q=eng@example.com") == 422  # the page's id, never its address
    assert send(version="1.0 <b>") == 422
    assert send(user="eng") == 422
    assert send(named="yes") == 422
    assert send(screenshot="data:image/svg+xml;base64,PHN2Zz4=") == 422
    assert send(screenshot="data:image/png;base64,not base64!") == 422
    jpeg_as_png = base64.b64encode(b"\xff\xd8\xff" + b"\x00" * 8).decode()
    assert send(screenshot=f"data:image/png;base64,{jpeg_as_png}") == 422
    assert send(screenshot=f"data:image/jpeg;base64,{jpeg_as_png}") == 201
    big = base64.b64encode(api_feedback.PNG + b"\x00" * api_feedback.MAX_SCREENSHOT).decode()
    assert send(screenshot=f"data:image/png;base64,{big}") == 422
    # Control characters are dropped from the browser's description.
    assert send(browser="Firefox\x00\n130") == 201


def test_a_site_takes_so_much_feedback_an_hour(api: TestClient, site: str, monkeypatch: Any) -> None:  # noqa: F811
    monkeypatch.setattr(api_feedback, "SITE_PER_HOUR", 2)
    for _ in range(2):
        assert api.post(f"/sites/{site}/feedback", json=body(), headers=VIEWER).status_code == 201
    res = api.post(f"/sites/{site}/feedback", json=body(), headers=VIEWER)
    assert res.status_code == 429 and res.headers["retry-after"] == "600"
    # Refused before its screenshot is read.
    bad = api.post(f"/sites/{site}/feedback", json=body(screenshot="data:image/png;base64,!!"), headers=VIEWER)
    assert bad.status_code == 429
