"""UX analytics, privacy first (U1.09): off until the organisation turns it on; events carry a kind,
a name from the vocabulary and a hashed session, nothing else; admins read counts."""

from typing import Any

import psycopg
from fastapi.testclient import TestClient
from test_agents import ADMIN, ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_onboarding import make_org_admin

from tiles_api.api_ux import session_hash

SESSION = "0123456789abcdef-tab"


def send(api: TestClient, site: str, events: list[dict[str, str]], who: dict[str, str] = VIEWER) -> Any:  # noqa: F811
    return api.post(f"/sites/{site}/ux-events", json={"session": SESSION, "events": events}, headers=who)


def turn(api: TestClient, enabled: bool) -> Any:  # noqa: F811
    return api.put("/org/ux-analytics?org=demo", json={"enabled": enabled}, headers=ADMIN)


def test_nothing_is_recorded_until_the_organisation_turns_it_on(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    make_org_admin(database_url, "admin@example.com")
    try:
        turn(api, False)
        assert api.get(f"/sites/{site}/ux-analytics", headers=VIEWER).json() == {"enabled": False}
        res = send(api, site, [{"kind": "page", "name": "warnings"}])
        assert (res.status_code, res.json()) == (200, {"stored": 0})
        # Organisation admins only turn it on; it is audited for the organisation.
        assert api.put("/org/ux-analytics?org=demo", json={"enabled": True}, headers=ENG).status_code == 403
        assert turn(api, True).json() == {"enabled": True}
        assert api.get("/org/ux-analytics?org=demo", headers=ADMIN).json() == {"enabled": True}
        assert api.get(f"/sites/{site}/ux-analytics", headers=VIEWER).json() == {"enabled": True}
        with psycopg.connect(database_url) as conn:
            row = conn.execute(
                "SELECT after FROM audit_log WHERE action = 'org.ux_analytics' AND site_id IS NULL"
                " ORDER BY id DESC LIMIT 1"
            ).fetchone()
        assert row is not None and row[0] == {"enabled": True}
    finally:
        turn(api, False)
        make_org_admin(database_url, "admin@example.com", False)


def test_events_are_counted_for_admins_and_keep_no_one_s_identity(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    make_org_admin(database_url, "admin@example.com")
    try:
        turn(api, True)
        res = send(
            api,
            site,
            [
                {"kind": "page", "name": "warnings"},
                {"kind": "page", "name": "warnings"},
                {"kind": "task", "name": "warning.acknowledged"},
                {"kind": "error", "name": "api.403"},
            ],
        )
        assert (res.status_code, res.json()) == (200, {"stored": 4})
        send(api, site, [{"kind": "page", "name": "warnings"}], who=ENG)  # the same tab id: one session
        # Only the vocabulary: no free text, no other kinds, at most 100 at a time.
        for bad in (
            {"kind": "page", "name": "Warnings for eng@example.com"},
            {"kind": "click", "name": "x"},
            {"kind": "page", "name": "warnings", "user": "eng"},
        ):
            assert send(api, site, [bad]).status_code == 422, bad
        assert send(api, site, [{"kind": "page", "name": "home"}] * 101).status_code == 422
        bad_session = {"session": "eng@example.com", "events": [{"kind": "page", "name": "home"}]}
        assert api.post(f"/sites/{site}/ux-events", json=bad_session, headers=VIEWER).status_code == 422

        # Stored: kind, name, time and the session's hash; nothing about who.
        with psycopg.connect(database_url) as conn:
            conn.execute("SELECT set_config('tiles.site_id', '*', false)")
            columns = [
                r[0]
                for r in conn.execute(
                    "SELECT column_name FROM information_schema.columns WHERE table_name = 'ux_events' ORDER BY 1"
                )
            ]
            sessions = {r[0] for r in conn.execute("SELECT session FROM ux_events WHERE site_id = %s", [site])}
        assert columns == ["at", "kind", "name", "session", "site_id"]
        assert sessions == {session_hash(SESSION)} and SESSION not in sessions

        # Admins read counts; others don't.
        assert api.get(f"/sites/{site}/ux-events/summary", headers=ENG).status_code == 403
        summary = api.get(f"/sites/{site}/ux-events/summary?days=7", headers=ADMIN).json()
        assert (summary["enabled"], summary["days"], summary["sessions"]) == (True, 7, 1)
        counts = {(c["kind"], c["name"]): (c["events"], c["sessions"]) for c in summary["counts"]}
        assert counts == {
            ("error", "api.403"): (1, 1),
            ("page", "warnings"): (3, 1),
            ("task", "warning.acknowledged"): (1, 1),
        }
        assert api.get(f"/sites/{site}/ux-events/summary?days=91", headers=ADMIN).status_code == 422

        # Events older than the period aren't counted; the database lets them go 90 days on.
        with psycopg.connect(database_url) as conn:
            conn.execute("SELECT set_config('tiles.site_id', '*', false)")
            conn.execute(
                "INSERT INTO ux_events (site_id, at, kind, name, session)"
                " VALUES (%s, now() - interval '91 days', 'error', 'api.500', %s)",
                [site, session_hash(SESSION)],
            )
            policy = conn.execute(
                "SELECT config->>'drop_after' FROM timescaledb_information.jobs"
                " WHERE hypertable_name = 'ux_events' AND proc_name = 'policy_retention'"
            ).fetchone()
        assert policy is not None and policy[0] == "90 days"
        names = {c["name"] for c in api.get(f"/sites/{site}/ux-events/summary?days=90", headers=ADMIN).json()["counts"]}
        assert names == {"warnings", "warning.acknowledged", "api.403"}

        # One browser session sends at most an hour's share; beyond it, events are let go.
        many = [{"kind": "page", "name": "home"}] * 100
        stored = [send(api, site, many).json()["stored"] for _ in range(7)]
        assert stored == [100, 100, 100, 100, 100, 95, 0]  # 600 an hour, five were sent above
    finally:
        turn(api, False)
        make_org_admin(database_url, "admin@example.com", False)
