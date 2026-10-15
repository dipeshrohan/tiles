"""Preferences (U6.06): each person keeps their own, the same on every site of their organisation."""

import uuid

import psycopg
from fastapi.testclient import TestClient
from test_agents import ADMIN, ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures

PREFS = {
    "theme": "dark",
    "density": "compact",
    "language": "de",
    "numbers": "en-US",
    "time_zone": "device",
    "motion": "reduce",
    "shortcuts": False,
    "start": "warnings",
}


def test_each_person_keeps_their_own_on_every_site(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    mine = f"/sites/{site}/me/preferences"
    assert api.get(mine, headers=VIEWER).json() == {"preferences": None, "updated_at": None}
    # Any member keeps theirs, a viewer too: they change nothing on the site.
    res = api.put(mine, json=PREFS, headers=VIEWER)
    assert res.status_code == 200, res.text
    assert res.json()["preferences"] == PREFS
    assert api.get(mine, headers=VIEWER).json()["preferences"] == PREFS
    assert api.get(mine, headers=ENG).json()["preferences"] is None
    # The same on another site of the organisation, where the viewer is a member too.
    with psycopg.connect(database_url) as conn:
        org = conn.execute("SELECT org_id FROM sites WHERE id = %s", [site]).fetchone()
        assert org
        other = conn.execute(
            "INSERT INTO sites (org_id, slug, name) VALUES (%s, %s, 'Other') RETURNING id",
            [org[0], f"other-{uuid.uuid4().hex[:6]}"],
        ).fetchone()
        assert other
        conn.execute(
            "INSERT INTO site_members (site_id, user_id, role)"
            " SELECT %s, user_id, role FROM site_members WHERE site_id = %s",
            [other[0], site],
        )
    there = api.get(f"/sites/{other[0]}/me/preferences", headers=VIEWER)
    assert there.status_code == 200, there.text
    assert there.json()["preferences"] == PREFS
    # Changed there; back here it is the same. Only what changed is audited, on the site it was changed from.
    api.put(f"/sites/{other[0]}/me/preferences", json={**PREFS, "theme": "light", "start": None}, headers=VIEWER)
    assert api.get(mine, headers=VIEWER).json()["preferences"] == {**PREFS, "theme": "light", "start": None}
    api.put(mine, json={**PREFS, "theme": "light", "start": None}, headers=VIEWER)  # no change: not audited
    with psycopg.connect(database_url) as conn:
        rows = conn.execute(
            "SELECT site_id, before, after FROM audit_log WHERE action = 'preferences.update' ORDER BY id"
        ).fetchall()
    assert [(str(r[0]), r[1], r[2]) for r in rows] == [
        (site, {k: None for k in sorted(PREFS)}, {k: PREFS[k] for k in sorted(PREFS)}),
        (str(other[0]), {"start": "warnings", "theme": "dark"}, {"start": None, "theme": "light"}),
    ]


def test_preferences_have_their_shape(api: TestClient, site: str) -> None:  # noqa: F811
    mine = f"/sites/{site}/me/preferences"
    for bad in (
        {**PREFS, "theme": "blue"},
        {**PREFS, "density": "tiny"},
        {**PREFS, "language": "deutsch"},
        {**PREFS, "numbers": "en_us"},
        {**PREFS, "time_zone": "Europe/Berlin"},
        {**PREFS, "motion": "none"},
        {**PREFS, "shortcuts": "off"},
        {**PREFS, "start": "../settings"},
        {**PREFS, "start": "x" * 33},
        {**PREFS, "user": "eng"},
        {k: v for k, v in PREFS.items() if k != "theme"},
    ):
        assert api.put(mine, json=bad, headers=ADMIN).status_code == 422, bad
    assert api.get(mine, headers=ADMIN).json()["preferences"] is None
