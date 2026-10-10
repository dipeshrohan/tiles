"""The menu's counts (U3.06): open warnings for everyone on the site, and the change requests you
may approve: engineers and admins only, never your own, asked of you or of anyone."""

from typing import Any

from fastapi.testclient import TestClient
from test_agents import ADMIN, ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_reviews import NODE, ask, member, stage
from test_warnings import ENG2, raise_warnings


def counts(api: TestClient, site: str, who: dict[str, str]) -> dict[str, Any]:  # noqa: F811
    res = api.get(f"/sites/{site}/menu-counts", headers=who)
    assert res.status_code == 200, res.text
    return dict(res.json())


def test_open_warnings_count_until_resolved(api: TestClient, site: str) -> None:  # noqa: F811
    assert counts(api, site, VIEWER) == {"open_warnings": 0, "reviews_waiting": 0}
    ids = raise_warnings(api, site)
    assert counts(api, site, VIEWER)["open_warnings"] == 3
    res = api.post(f"/sites/{site}/warnings/{ids[0]}/resolve", json={"outcome": "true_alarm"}, headers=ENG)
    assert res.status_code == 200, res.text
    assert counts(api, site, VIEWER)["open_warnings"] == 2


def test_reviews_wait_for_engineers_who_may_approve_them(api: TestClient, site: str) -> None:  # noqa: F811
    member(api, site, ENG2)
    stage(api, site, {"kind": "addNode", "node": NODE})
    ask(api, site, message="Add Press 9")  # by eng, for anyone
    assert counts(api, site, ENG)["reviews_waiting"] == 0  # your own
    assert counts(api, site, ENG2)["reviews_waiting"] == 1
    assert counts(api, site, ADMIN)["reviews_waiting"] == 1
    assert counts(api, site, VIEWER)["reviews_waiting"] == 0  # can't approve
    # One asked of a named engineer waits for them alone.
    stage(api, site, {"kind": "addNode", "node": {**NODE, "id": "machine-press-10", "label": "Press 10"}}, who=ENG2)
    ask(api, site, who=ENG2, message="Add Press 10", reviewer_id=member(api, site, ENG))
    assert counts(api, site, ENG)["reviews_waiting"] == 1
    assert counts(api, site, ADMIN)["reviews_waiting"] == 1
