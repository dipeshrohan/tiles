"""File imports (T2.07): engineers start an import, send its readings in batches and finish it."""

import threading
import time
from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures

T0 = datetime(2026, 9, 1, 6, 0, tzinfo=UTC)


def readings(tag: str, n: int, start: int = 0) -> list[dict[str, Any]]:
    return [{"signal": tag, "at": (T0 + timedelta(minutes=i)).isoformat(), "value": float(i)} for i in range(start, n)]


def start(api: TestClient, site: str, name: str = "press-line-2025.csv") -> dict[str, Any]:  # noqa: F811
    res = api.post(f"/sites/{site}/imports", json={"name": name}, headers=ENG)
    assert res.status_code == 201, res.text
    body: dict[str, Any] = res.json()
    return body


def test_an_import_backfills_readings_and_counts_them(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    imp = start(api, site)
    assert (imp["received"], imp["stored"], imp["finished_at"], imp["created_by"]) == (0, 0, None, "eng")
    path = f"/sites/{site}/imports/{imp['id']}"
    assert api.post(f"{path}/samples", json={"samples": readings("press2.force", 3)}, headers=ENG).json() == {
        "received": 3,
        "stored": 3,
    }
    # Overlapping batch: the first three are already stored.
    res = api.post(f"{path}/samples", json={"samples": readings("press2.force", 5)}, headers=ENG)
    assert res.json() == {"received": 5, "stored": 2}
    done = api.post(f"{path}/finish", headers=ENG).json()
    assert (done["received"], done["stored"]) == (8, 5)
    assert done["finished_at"] is not None

    [listed] = [i for i in api.get(f"/sites/{site}/imports", headers=VIEWER).json() if i["id"] == imp["id"]]
    assert listed == done
    with psycopg.connect(database_url) as conn:
        row = conn.execute(
            "SELECT g.source, count(*) FROM samples s JOIN signals g ON g.id = s.signal_id"
            " WHERE g.site_id = %s AND g.tag = 'press2.force' GROUP BY g.source",
            [site],
        ).fetchone()
        audit = conn.execute("SELECT action FROM audit_log WHERE entity_id = %s ORDER BY id", [imp["id"]]).fetchall()
    assert row == ("import:press-line-2025.csv", 5)
    assert [a[0] for a in audit] == ["import.start", "import.finish"]


def test_a_finished_import_takes_no_more_readings(api: TestClient, site: str) -> None:  # noqa: F811
    imp = start(api, site)
    path = f"/sites/{site}/imports/{imp['id']}"
    assert api.post(f"{path}/finish", headers=ENG).status_code == 200
    assert api.post(f"{path}/finish", headers=ENG).status_code == 409
    res = api.post(f"{path}/samples", json={"samples": readings("press2.force", 1)}, headers=ENG)
    assert res.status_code == 409


def test_viewers_can_see_imports_but_not_run_them(api: TestClient, site: str) -> None:  # noqa: F811
    assert api.post(f"/sites/{site}/imports", json={"name": "x.csv"}, headers=VIEWER).status_code == 403
    imp = start(api, site)
    path = f"/sites/{site}/imports/{imp['id']}"
    assert api.post(f"{path}/samples", json={"samples": readings("a.b", 1)}, headers=VIEWER).status_code == 403
    assert api.post(f"{path}/finish", headers=VIEWER).status_code == 403
    assert api.get(f"/sites/{site}/imports", headers=VIEWER).status_code == 200


def test_imports_are_checked(api: TestClient, site: str) -> None:  # noqa: F811
    for bad in ("", "x" * 201, "two\nlines"):
        assert api.post(f"/sites/{site}/imports", json={"name": bad}, headers=ENG).status_code == 422, bad
    missing = f"/sites/{site}/imports/00000000-0000-0000-0000-000000000000"
    assert api.post(f"{missing}/samples", json={"samples": []}, headers=ENG).status_code == 404
    assert api.post(f"{missing}/finish", headers=ENG).status_code == 404
    imp = start(api, site)
    bad_batch = [*readings("ok.tag", 1), {"signal": "Not A Tag", "at": T0.isoformat(), "value": 1.0}]
    res = api.post(f"/sites/{site}/imports/{imp['id']}/samples", json={"samples": bad_batch}, headers=ENG)
    assert res.status_code == 422
    assert api.get(f"/sites/{site}/imports", headers=ENG).json()[0]["received"] == 0


def test_finishing_waits_for_a_batch_being_stored(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The counts a finish records are final: it waits for a batch already being stored."""
    from tiles_api import api_imports, api_samples

    imp = start(api, site)
    path = f"/sites/{site}/imports/{imp['id']}"
    storing, release = threading.Event(), threading.Event()
    real = api_samples.store_samples

    def slow_store(*args: Any) -> int:
        storing.set()
        release.wait(10)
        return real(*args)

    # Another engineer finishes it (one user's two requests would also queue on that user's row).
    other = {"X-Tiles-User": "eng2@example.com"}
    assert api.get(f"/sites/{site}/me", headers=other).json()["role"] == "engineer"
    monkeypatch.setattr(api_imports, "store_samples", slow_store)
    answers: dict[str, Any] = {}
    batch = threading.Thread(
        target=lambda: answers.update(
            batch=api.post(f"{path}/samples", json={"samples": readings("w.x", 4)}, headers=ENG)
        )
    )
    finish = threading.Thread(target=lambda: answers.update(finish=api.post(f"{path}/finish", headers=other)))
    batch.start()
    assert storing.wait(10)
    finish.start()
    time.sleep(0.5)
    assert finish.is_alive()  # waiting for the batch's lock on the import
    release.set()
    batch.join(10)
    finish.join(10)
    assert answers["batch"].json() == {"received": 4, "stored": 4}
    done = answers["finish"].json()
    assert (done["received"], done["stored"]) == (4, 4)
