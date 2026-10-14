"""Search across a site (U4.01): signals, ontology nodes, warnings, insights, documents and apps,
ranked the same way, grouped by kind, a few of each; another site's records are never found."""

import time
import uuid
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_apps import make
from test_documents import upload
from test_insights import save
from test_reviews import ENG2, member
from test_series import MINUTE, T0, load
from test_warnings import raise_warnings

from tiles_api.api_search import like_escape, params, regex_escape


def search(api: TestClient, site: str, q: str, who: dict[str, str] = VIEWER, **query: Any) -> Any:  # noqa: F811
    res = api.get(f"/sites/{site}/search", params={"q": q, **query}, headers=who)
    assert res.status_code == 200, res.text
    return res.json()


def titles(found: dict[str, Any], kind: str) -> list[str]:
    group = next((g for g in found["groups"] if g["kind"] == kind), None)
    return [r["title"] for r in group["results"]] if group else []


def nodes(database_url: str, site: str, rows: list[tuple[str, str, str]]) -> None:  # noqa: F811
    with psycopg.connect(database_url) as conn:
        for node_id, kind, label in rows:
            conn.execute(
                "INSERT INTO ontology_nodes (site_id, id, type, label) VALUES (%s, %s, %s, %s)",
                [site, node_id, kind, label],
            )


def test_ranked_equal_then_start_then_word_then_anywhere_then_every_word(api: TestClient, site: str) -> None:  # noqa: F811
    for tag in ("pump.temp", "press9.temp", "press9.force", "die.press9.oil", "oil.xpress9z", "temp"):
        load(api, site, tag, [1.0, 2.0])
    # The query itself, then tags starting with it (shorter first), then a word starting with it,
    # then anywhere in it.
    found = search(api, site, "press9")
    assert titles(found, "signal") == ["press9.temp", "press9.force", "die.press9.oil", "oil.xpress9z"]
    scores = [r["score"] for r in found["groups"][0]["results"]]
    assert scores == [0.8, 0.8, 0.6, 0.4]
    assert titles(search(api, site, "temp"), "signal")[0] == "temp"  # equal comes first
    # Words in another order: found by every word, ranked last.
    assert titles(search(api, site, "oil die"), "signal") == ["die.press9.oil"]
    assert search(api, site, "oil die")["groups"][0]["results"][0]["score"] == 0.2
    # Case and spacing don't matter; wildcards are taken as they are.
    assert titles(search(api, site, "  PRESS9.TEMP "), "signal")[0] == "press9.temp"
    assert titles(search(api, site, "%%"), "signal") == []
    assert titles(search(api, site, "pr_ss"), "signal") == []


def test_every_kind_grouped_the_best_group_first_a_few_of_each(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    raise_warnings(api, site)  # dc1.friction and its detector, three warnings
    nodes(database_url, site, [("m-dc01", "Machine", "Die-caster DC-01"), ("plc-dc01", "PLC", "Friction PLC DC-01")])
    signal = load(api, site, "press9.friction.estimate", [1.0 + i % 3 for i in range(60)])
    end = T0 + 60 * MINUTE
    source = {"kind": "series", "signals": [signal], "start": T0.isoformat(), "end": end.isoformat()}
    assert save(api, site, source, title="Friction climbs before a seizure").status_code == 201
    sop = "SOP 14\fCheck the hydraulic pressure.\fLow friction keeps the plunger tip from seizing."
    assert upload(api, site, sop.encode(), "text/plain", title="SOP 14 start-up").status_code == 201
    assert make(api, site, "Friction watch", "spc-limits", signal=signal).status_code == 201

    found = search(api, site, "friction", limit=2)
    kinds = [g["kind"] for g in found["groups"]]
    assert set(kinds) == {"signal", "node", "warning", "insight", "document", "app"}
    assert kinds[0] in {"app", "insight", "node"}  # a title starting with "Friction" (0.8) leads
    by_kind = {g["kind"]: g for g in found["groups"]}
    assert [r["title"] for r in by_kind["warning"]["results"]] == ["dc1.friction", "dc1.friction"]
    assert by_kind["warning"]["more"] is True  # three warnings, two shown
    assert by_kind["warning"]["results"][0]["detail"].startswith("dc1-friction")
    assert by_kind["node"]["results"][0] == {
        "kind": "node",
        "id": "plc-dc01",
        "title": "Friction PLC DC-01",
        "detail": "PLC",
        "score": 0.8,
        "page": None,
        "snippet": None,
    }
    doc = by_kind["document"]["results"][0]
    assert (doc["title"], doc["page"]) == ("SOP 14 start-up", 3)  # found by its words, with the page
    assert "\u0002friction\u0003" in doc["snippet"].lower()
    assert by_kind["insight"]["results"][0]["detail"] == "proposed"
    # One kind, or a few.
    only = search(api, site, "friction", kind=["document", "app"])
    assert [g["kind"] for g in only["groups"]] in (["app", "document"], ["document", "app"])
    # Every role on the site finds the same.
    assert search(api, site, "friction", who=ENG, limit=2) == found


def test_another_sites_records_are_never_found(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    load(api, site, "line.oven.temp", [1.0])
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        org = conn.execute("SELECT org_id FROM sites WHERE id = %s", [site]).fetchone()
        assert org
        other = conn.execute(
            "INSERT INTO sites (org_id, slug, name) VALUES (%s, %s, 'Other') RETURNING id",
            [org["org_id"], f"other-{uuid.uuid4().hex[:6]}"],
        ).fetchone()
        assert other
        conn.execute("INSERT INTO signals (site_id, tag) VALUES (%s, 'line.oven.secret')", [other["id"]])
        conn.execute(
            "INSERT INTO ontology_nodes (site_id, id, type, label) VALUES (%s, 'oven-x', 'Machine', 'Oven secret')",
            [other["id"]],
        )
    found = search(api, site, "oven")
    assert titles(found, "signal") == ["line.oven.temp"]
    assert titles(found, "node") == []
    # The other site's search finds its records, not this site's.
    there = search(api, str(other["id"]), "oven")
    assert (titles(there, "signal"), titles(there, "node")) == (["line.oven.secret"], ["Oven secret"])


def test_archived_and_rejected_records_are_left_out(api: TestClient, site: str) -> None:  # noqa: F811
    signal = load(api, site, "oven.zone2", [1.0 + i % 3 for i in range(60)])
    assert make(api, site, "Oven watch", "spc-limits", signal=signal).status_code == 201
    assert upload(api, site, b"Oven start-up\fOven zone checks", "text/plain", title="Oven SOP").status_code == 201
    source = {"kind": "series", "signals": [signal], "start": T0.isoformat(), "end": (T0 + 60 * MINUTE).isoformat()}
    assert save(api, site, source, title="Oven drifts").status_code == 201
    found = search(api, site, "oven")
    assert (titles(found, "app"), titles(found, "document"), titles(found, "insight")) == (
        ["Oven watch"],
        ["Oven SOP"],
        ["Oven drifts"],
    )
    assert api.delete(f"/sites/{site}/apps/1", headers=ENG).status_code == 204
    assert api.delete(f"/sites/{site}/documents/1", headers=ENG).status_code == 204
    member(api, site, ENG2)
    rejected = api.post(
        f"/sites/{site}/insights/1/review", json={"decision": "rejected", "note": "Too short"}, headers=ENG2
    )
    assert rejected.status_code == 200, rejected.text
    found = search(api, site, "oven")
    assert (titles(found, "app"), titles(found, "document"), titles(found, "insight")) == ([], [], [])
    assert titles(found, "signal") == ["oven.zone2"]


def test_document_words_are_all_the_words_typed_never_an_operator(api: TestClient, site: str) -> None:  # noqa: F811
    assert upload(api, site, b"Plunger tip\fHydraulic pressure 140 bar", "text/plain", title="SOP 9").status_code == 201
    assert upload(api, site, b"Spindle speed\fCoolant level", "text/plain", title="SOP 10").status_code == 201
    # A leading - is a word typed, not "every page without it": nothing has "oven".
    assert titles(search(api, site, "-oven"), "document") == []
    assert titles(search(api, site, "hydraulic pressure"), "document") == ["SOP 9"]
    found = search(api, site, "hydraulic pressure")["groups"][0]["results"][0]
    assert (found["page"], found["detail"]) == (2, "2 pages")
    assert titles(search(api, site, "pressure spindle"), "document") == []  # every word, on one page


def test_requests_are_checked(api: TestClient, site: str) -> None:  # noqa: F811
    queries: list[dict[str, str | int]] = [{"q": "a"}, {"q": " "}, {"q": "x" * 201}]
    queries += [{"q": "oven", "limit": 0}, {"q": "oven", "limit": 21}]
    for query in queries:
        assert api.get(f"/sites/{site}/search", params=query, headers=VIEWER).status_code == 422, query
    assert api.get(f"/sites/{site}/search", params={"q": "oven", "kind": "people"}, headers=VIEWER).status_code == 422
    assert search(api, site, "nothing like this anywhere") == {"query": "nothing like this anywhere", "groups": []}
    # A kind asked for twice is one group.
    load(api, site, "oven.zone1", [1.0])
    twice = search(api, site, "oven", kind=["signal", "signal"])
    assert [g["kind"] for g in twice["groups"]] == ["signal"]


def test_the_patterns_take_the_query_as_written() -> None:
    assert like_escape("50%_a\\b") == "50\\%\\_a\\\\b"
    assert regex_escape("a.b(c)*") == "a\\.b\\(c\\)\\*"
    p = params("  Press 9  ", "site", 5)
    assert (p["q"], p["prefix"], p["anywhere"], p["words"]) == ("press 9", "press 9%", "%press 9%", ["%press%", "%9%"])


@pytest.mark.parametrize("signals", [5000])
def test_fast_on_a_site_the_size_of_the_load_test(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    signals: int,
) -> None:
    with psycopg.connect(database_url) as conn, conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO signals (site_id, tag, description) VALUES (%s, %s, %s)",
            [
                (site, f"line{i % 30}.press{i % 100}.sensor{i}", f"Sensor {i} on press {i % 100}")
                for i in range(signals)
            ],
        )
        cur.executemany(
            "INSERT INTO ontology_nodes (site_id, id, type, label) VALUES (%s, %s, 'Signal', %s)",
            [(site, f"s{i}", f"Sensor {i}") for i in range(signals)],
        )
    search(api, site, "press7")  # warm
    started = time.perf_counter()
    found = search(api, site, "press7")
    took = time.perf_counter() - started
    assert titles(found, "signal")
    assert took < 0.5, f"{took * 1000:.0f} ms"  # the target is 150 ms on the load-test site; CI is slower
