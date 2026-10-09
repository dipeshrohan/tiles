"""Saved insights over HTTP (T3.12): a finding with its query and the evidence the API computed,
reviewed by another engineer, numbered per site."""

from typing import Any

import psycopg
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from test_agents import ADMIN, ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_datasets import upload
from test_reviews import ENG2, member
from test_series import MINUTE, T0, load, series

CORRELATION = {"kind": "correlation", "outcome": "ng", "variables": ["tension", "speed"], "split": "material"}


def save(api: TestClient, site: str, source: dict[str, Any], **body: Any) -> Any:  # noqa: F811
    payload = {"title": "Tension splits by material", "source": source, **body}
    return api.post(f"/sites/{site}/insights", json=payload, headers=ENG)


def test_a_correlation_is_saved_with_its_evidence_and_reviewed_by_another_engineer(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    member(api, site, ENG2)
    dataset = upload(api, site)
    source = CORRELATION | {"dataset_id": dataset}
    res = save(api, site, source, summary="Anode fails high, cathode low.", actions=["Lower anode tension to 1000 N"])
    assert res.status_code == 201, res.text
    insight = res.json()
    assert (insight["number"], insight["status"], insight["author"], insight["kind"]) == (
        1,
        "proposed",
        "eng",
        "correlation",
    )
    assert insight["actions"] == ["Lower anode tension to 1000 N"]
    assert insight["query"] == source | {"ng_values": None, "min_effect": 0.8}
    # The evidence is what the correlation finder gives for the same question.
    ran = api.post(
        f"/sites/{site}/datasets/{dataset}/correlate",
        json={k: v for k, v in source.items() if k not in ("kind", "dataset_id")},
        headers=VIEWER,
    ).json()
    evidence = insight["evidence"]
    assert evidence["result"] == ran
    assert evidence["dataset"] == {"id": dataset, "name": "cutter batches", "row_count": 720}
    assert evidence["findings_total"] == 4

    # Kept as it was: the dataset can go, the insight still shows what was seen.
    assert api.delete(f"/sites/{site}/datasets/{dataset}", headers=ENG).status_code == 204
    path = f"/sites/{site}/insights/1"
    assert api.get(path, headers=VIEWER).json()["evidence"] == evidence

    # Its author doesn't review it; another engineer does, and rejecting says why.
    review = f"{path}/review"
    res = api.post(review, json={"decision": "accepted"}, headers=ENG)
    assert (res.status_code, res.json()["detail"]) == (403, "Another engineer reviews your insight")
    assert api.post(review, json={"decision": "accepted"}, headers=VIEWER).status_code == 403
    res = api.post(review, json={"decision": "rejected", "note": "  "}, headers=ENG2)
    assert (res.status_code, res.json()["detail"]) == (422, "Say why the insight is rejected")
    res = api.post(review, json={"decision": "rejected", "note": " Only 4 weeks of batches "}, headers=ENG2)
    assert res.status_code == 200, res.text
    assert (res.json()["status"], res.json()["reviewer"], res.json()["review_note"]) == (
        "rejected",
        "eng2",
        "Only 4 weeks of batches",
    )
    res = api.post(review, json={"decision": "accepted"}, headers=ENG2)
    assert (res.status_code, res.json()["detail"]) == (409, "Insight #1 is already rejected")

    # Its author revises it: reopen, edit, and it is reviewed again.
    res = api.patch(path, json={"title": "Tension, again"}, headers=ENG)
    assert (res.status_code, res.json()["detail"]) == (409, "Insight #1 is rejected: reopen it first")
    assert api.post(f"{path}/reopen", headers=ENG2).status_code == 403
    reopened = api.post(f"{path}/reopen", headers=ENG).json()
    assert (reopened["status"], reopened["reviewer"], reopened["review_note"]) == ("proposed", None, "")
    assert api.post(f"{path}/reopen", headers=ENG).status_code == 409
    assert api.patch(path, json={"title": "Not mine"}, headers=ENG2).status_code == 403
    bads: list[dict[str, Any]] = [{"title": " x"}, {"actions": [""]}, {"query": {}}]
    for bad in bads:
        assert api.patch(path, json=bad, headers=ENG).status_code == 422, bad
    edited = api.patch(path, json={"title": "Tension splits by material", "actions": []}, headers=ENG).json()
    assert (edited["actions"], edited["evidence"]) == ([], evidence)
    accepted = api.post(review, json={"decision": "accepted", "note": "Seen again in October"}, headers=ENG2).json()
    assert (accepted["status"], accepted["reviewer"]) == ("accepted", "eng2")

    listed = api.get(f"/sites/{site}/insights", headers=VIEWER).json()
    assert (listed["total"], [i["number"] for i in listed["insights"]]) == (1, [1])
    assert "evidence" not in listed["insights"][0]
    assert api.get(f"/sites/{site}/insights", params={"status": "proposed"}, headers=VIEWER).json() == {
        "insights": [],
        "total": 0,
    }

    assert api.delete(path, headers=ENG2).status_code == 403
    assert api.delete(path, headers=ADMIN).status_code == 204
    assert api.get(path, headers=VIEWER).status_code == 404
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        actions = [
            r["action"]
            for r in conn.execute(
                "SELECT action FROM audit_log WHERE site_id = %s AND entity_type = 'insight' ORDER BY id", [site]
            )
        ]
    assert actions == [
        "insight.create",
        "insight.review",
        "insight.reopen",
        "insight.update",
        "insight.review",
        "insight.delete",
    ]


def test_signals_over_a_range_are_kept_as_the_explorer_plots_them(api: TestClient, site: str) -> None:  # noqa: F811
    a = load(api, site, "press9.temp", [20.0 + i % 7 for i in range(300)])
    b = load(api, site, "press9.force", [100.0 + i for i in range(300)])
    end = T0 + 300 * MINUTE
    source = {"kind": "series", "signals": [a, b], "start": T0.isoformat(), "end": end.isoformat(), "points": 100}
    res = save(api, site, source)
    assert res.status_code == 201, res.text
    kept = res.json()["evidence"]["series"]
    assert [s["tag"] for s in kept] == ["press9.temp", "press9.force"]
    assert kept[0] == series(api, site, a, T0, end, points=100).json()
    assert kept[0]["bucket_s"] == 180  # 300 readings in at most 100 points
    # Numbered per site.
    assert save(api, site, source).json()["number"] == 2

    for bad, code in (
        (source | {"signals": [a, a]}, 422),
        (source | {"signals": []}, 422),
        (source | {"end": T0.isoformat()}, 422),
        (source | {"points": 5000}, 422),
        (source | {"signals": ["00000000-0000-0000-0000-000000000000"]}, 404),
        (CORRELATION | {"dataset_id": "00000000-0000-0000-0000-000000000000"}, 404),
        (CORRELATION | {"dataset_id": "00000000-0000-0000-0000-000000000000", "split": "ng"}, 422),
        ({"kind": "warning"}, 422),
    ):
        assert save(api, site, bad).status_code == code, bad
    assert save(api, site, source, title=" padded").status_code == 422
    assert save(api, site, source, actions=["x"] * 21).status_code == 422
    res = api.post(f"/sites/{site}/insights", json={"title": "x", "source": source}, headers=VIEWER)
    assert res.status_code == 403
    assert api.get(f"/sites/{site}/insights", headers=VIEWER).json()["total"] == 2
