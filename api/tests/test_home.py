"""Home by role (U5.01): each person keeps their home's cards per site; none kept means the role's."""

import psycopg
from fastapi.testclient import TestClient
from test_agents import ADMIN, ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures


def test_each_person_keeps_their_own_cards_in_order(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    home = f"/sites/{site}/me/home"
    assert api.get(home, headers=VIEWER).json() == {"cards": None, "updated_at": None}
    # Any member keeps theirs, a viewer too: it changes nothing on the site.
    res = api.put(home, json={"cards": ["my-warnings", "machines-out"]}, headers=VIEWER)
    assert res.status_code == 200, res.text
    assert res.json()["cards"] == ["my-warnings", "machines-out"]
    api.put(home, json={"cards": ["reviews"]}, headers=ENG)
    assert api.get(home, headers=VIEWER).json()["cards"] == ["my-warnings", "machines-out"]
    assert api.get(home, headers=ENG).json()["cards"] == ["reviews"]
    assert api.get(home, headers=ADMIN).json()["cards"] is None
    # Reordered, then emptied (a home with no cards is a choice too).
    api.put(home, json={"cards": ["machines-out", "my-warnings"]}, headers=VIEWER)
    assert api.get(home, headers=VIEWER).json()["cards"] == ["machines-out", "my-warnings"]
    assert api.put(home, json={"cards": []}, headers=VIEWER).json()["cards"] == []
    # Back to the role's.
    assert api.delete(home, headers=VIEWER).status_code == 204
    assert api.get(home, headers=VIEWER).json()["cards"] is None
    assert api.delete(home, headers=VIEWER).status_code == 204  # nothing kept: still fine
    with psycopg.connect(database_url) as conn:
        rows = conn.execute(
            "SELECT after FROM audit_log WHERE site_id = %s AND action = 'home.layout' ORDER BY id", [site]
        ).fetchall()
    assert [r[0]["cards"] for r in rows] == [
        ["my-warnings", "machines-out"],
        ["reviews"],
        ["machines-out", "my-warnings"],
        [],
        None,
    ]


def test_cards_are_ids_from_the_catalogue(api: TestClient, site: str) -> None:  # noqa: F811
    home = f"/sites/{site}/me/home"
    for bad in (
        {"cards": ["My warnings"]},
        {"cards": ["reviews", "reviews"]},
        {"cards": [f"card-{n}" for n in range(17)]},
        {"cards": ["x" * 33]},
        {"cards": ["reviews"], "user": "eng"},
        {"cards": "reviews"},
    ):
        assert api.put(home, json=bad, headers=ENG).status_code == 422, bad
