# ruff: noqa: S101 - a check run by scripts/upgrade-test.sh: a failed assert is the failure it reports
"""Data that must survive an upgrade (T6.04), for scripts/upgrade-test.sh.

    python upgrade_check.py write   with the older version's code: puts data in through its API
    python upgrade_check.py read    with either version's code: checks the data through its API

It uses only endpoints both versions have, through the API's own app (no server needed), against
TILES_DATABASE_URL, as the development identity (an engineer).
"""

import sys
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient

from tiles_api.main import create_app
from tiles_api.settings import Settings

TAG = "upgrade.press-1.force"
READINGS = 600
ROWS = 10
START = datetime(2026, 1, 5, 6, 0, tzinfo=UTC)


def client() -> TestClient:
    return TestClient(create_app(Settings(env="development")))


def ok(res: Any, code: int = 200) -> Any:
    assert res.status_code == code, f"{res.request.method} {res.request.url.path}: {res.status_code} {res.text}"
    return res.json() if res.content else None


def site(api: TestClient) -> str:
    sites = ok(api.get("/sites"))
    assert sites, "no site: run tiles-seed first"
    return str(sites[0]["id"])


def write() -> None:
    with client() as api:
        s = site(api)
        node = {"id": "press-1", "type": "Machine", "label": "Press 1", "props": {"vendor": "Acme"}}
        ok(api.post(f"/sites/{s}/ontology/staged", json={"kind": "addNode", "node": node}), 201)
        ok(api.post(f"/sites/{s}/ontology/commits", json={"message": "before the upgrade"}), 201)
        imp = ok(api.post(f"/sites/{s}/imports", json={"name": "before-upgrade.csv"}), 201)
        samples = [
            {"signal": TAG, "at": (START + timedelta(seconds=i)).isoformat(), "value": 100 + i % 7}
            for i in range(READINGS)
        ]
        stored = ok(api.post(f"/sites/{s}/imports/{imp['id']}/samples", json={"samples": samples}))
        assert stored["stored"] == READINGS, stored
        ok(api.post(f"/sites/{s}/imports/{imp['id']}/finish"))
        columns = [{"name": "batch", "kind": "text"}, {"name": "yield", "kind": "number"}]
        ds = ok(api.post(f"/sites/{s}/datasets", json={"name": "before-upgrade", "columns": columns}), 201)
        rows = [{"batch": f"B{i}", "yield": 90 + i} for i in range(ROWS)]
        ok(api.post(f"/sites/{s}/datasets/{ds['id']}/rows", json={"rows": rows}))
    print("wrote: a committed node, an import of 600 readings, a dataset of 10 rows")


def read() -> None:
    with client() as api:
        s = site(api)
        graph = ok(api.get(f"/sites/{s}/ontology/graph?view=head"))
        assert graph["nodes"]["press-1"]["props"] == {"vendor": "Acme"}, graph["nodes"].get("press-1")
        commits = ok(api.get(f"/sites/{s}/ontology/commits"))
        assert any(c["message"] == "before the upgrade" for c in commits), commits
        found = ok(api.get(f"/sites/{s}/signals", params={"q": TAG}))
        [signal] = [g for g in found["signals"] if g["tag"] == TAG]
        end = START + timedelta(seconds=READINGS)
        series = ok(
            api.get(
                f"/sites/{s}/signals/{signal['id']}/series",
                params={"from": START.isoformat(), "to": end.isoformat(), "points": 1000},
            )
        )
        assert len(series["points"]) == READINGS, len(series["points"])
        [ds] = [d for d in ok(api.get(f"/sites/{s}/datasets")) if d["name"] == "before-upgrade"]
        assert ds["row_count"] == ROWS, ds
        imports = ok(api.get(f"/sites/{s}/imports"))
        assert any(i["name"] == "before-upgrade.csv" and i["stored"] == READINGS for i in imports), imports
    print("read back: the node and its commit, all 600 readings, the 10 dataset rows and the import")


if __name__ == "__main__":
    {"write": write, "read": read}[sys.argv[1]]()
