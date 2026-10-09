"""Site-level permissions in the database (T5.04): row security scopes a request's transaction to
its site, for every table of a site's data; jobs (no site named) see every site."""

import importlib
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from test_agents import ADMIN, ENG, api, site  # noqa: F401 - api and site are fixtures
from test_reviews import member

from tiles_api import copilot_usage
from tiles_api.api_ontology import SiteContext
from tiles_api.identity import User
from tiles_api.settings import Settings
from tiles_api.store import UNSCOPED, act_as_app, all_sites, open_pool

RLS = importlib.import_module("tiles_api.migrations.versions.0024_site_row_security")
# Tables of a site's data made after 0024, each with its policy in its own migration.
LATER = [importlib.import_module(f"tiles_api.migrations.versions.{m}") for m in ("0028_apps", "0029_documents")]
SITE_TABLES = {*RLS.SITE_TABLES, *(t for m in LATER for t in m.SITE_TABLES)}
# Tables of no one site: the organisation's, people, and the readings hypertable (TimescaleDB
# refuses row security on a compressed hypertable: the API reads it through `site_samples` and
# writes it with `tiles_store_samples`, and may not touch it otherwise). An organisation's sign-in
# and SCIM tokens (T5.05) are its own, read before any site is named.
NO_SITE = {
    "alembic_version",
    "orgs",
    "sites",
    "users",
    "models",
    "samples",
    "job_runs",
    "org_identity_providers",
    "scim_tokens",
}


def tables(conn: psycopg.Connection[Any]) -> dict[str, tuple[bool, bool, bool]]:
    """Each public table: (has a site_id column, row security on, forced)."""
    rows = conn.execute(
        """
        SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
               EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'site_id'
                       AND NOT a.attisdropped) AS has_site
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        """
    ).fetchall()
    return {r[0]: (r[3], r[1], r[2]) for r in rows}


def test_every_table_of_a_sites_data_has_forced_row_security(database_url: str) -> None:
    with psycopg.connect(database_url) as conn:
        found = tables(conn)
    with_site = {t for t, (has_site, _, _) in found.items() if has_site}
    assert with_site == SITE_TABLES, "a table with site_id needs a policy (or one was dropped)"
    children = {t for t, *_ in RLS.CHILD_TABLES}
    assert set(found) - with_site - children == NO_SITE, "a new table: does it hold a site's data?"
    for table in with_site | children:
        assert found[table][1:] == (True, True), table


@pytest.fixture
def two_sites(api: TestClient, site: str, database_url: str) -> dict[str, Any]:  # noqa: F811
    """This site and another of the same organisation, each with a signal, a dataset with a row,
    and a conversation with a message; written as a job would (no site named)."""
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        org = conn.execute("SELECT org_id FROM sites WHERE id = %s", [site]).fetchone()
        assert org
        other = conn.execute(
            "INSERT INTO sites (org_id, slug, name) VALUES (%s, %s, 'Other') RETURNING id",
            [org["org_id"], f"other-{uuid.uuid4().hex[:6]}"],
        ).fetchone()
        assert other
        user = uuid.UUID(member(api, site, ENG))
        for s in (site, other["id"]):
            conn.execute("INSERT INTO signals (site_id, tag) VALUES (%s, %s)", [s, f"tag-{s}"])
            ds = conn.execute(
                "INSERT INTO datasets (site_id, name, columns) VALUES (%s, %s, '[]') RETURNING id",
                [s, f"d-{s}"],
            ).fetchone()
            assert ds
            conn.execute("INSERT INTO dataset_rows (dataset_id, i, row) VALUES (%s, 0, '{}')", [ds["id"]])
            cv = conn.execute(
                "INSERT INTO conversations (site_id, user_id) VALUES (%s, %s) RETURNING id", [s, user]
            ).fetchone()
            assert cv
            conn.execute(
                "INSERT INTO conversation_messages (conversation_id, seq, role, content) VALUES (%s, 0, 'user', '[]')",
                [cv["id"]],
            )
            conn.execute(
                "INSERT INTO samples (signal_id, at, value) SELECT id, now(), 1 FROM signals WHERE site_id = %s", [s]
            )
        conn.execute(  # an organisation-level entry, of no site
            "INSERT INTO audit_log (org_id, actor_name, action, entity_type, entity_id)"
            " VALUES (%s, 'x', 'org', 'org', 'o')",
            [org["org_id"]],
        )
    return {"site": uuid.UUID(site), "other": other["id"], "org": org["org_id"], "user": user}


def scoped(database_url: str, two_sites: dict[str, Any]) -> Any:
    """A connection as the API's pool makes them, and a request's context on this site."""
    conn = psycopg.connect(database_url, row_factory=dict_row)
    act_as_app(conn)
    ctx = SiteContext(
        conn, two_sites["site"], two_sites["org"], User(two_sites["user"], "eng", "e@example.com", "engineer")
    )
    return conn, ctx


def test_a_request_sees_and_writes_only_its_sites_rows(database_url: str, two_sites: dict[str, Any]) -> None:
    conn, _ = scoped(database_url, two_sites)
    with conn:
        # A query that forgets its site filter still gets this site's rows only.
        sites = {r["site_id"] for r in conn.execute("SELECT site_id FROM signals").fetchall()}
        assert sites == {two_sites["site"]}
        assert conn.execute("SELECT count(*) AS n FROM datasets").fetchone() == {"n": 1}
        assert conn.execute("SELECT count(*) AS n FROM dataset_rows").fetchone() == {"n": 1}  # through its parent
        assert conn.execute("SELECT count(*) AS n FROM conversation_messages").fetchone() == {"n": 1}
        # Another site's row by id: not there.
        theirs = "SELECT id FROM datasets WHERE site_id = %s"
        assert conn.execute(theirs, [two_sites["other"]]).fetchall() == []
        # Nor can it be written there, or changed.
        with pytest.raises(psycopg.errors.InsufficientPrivilege), conn.transaction():
            conn.execute("INSERT INTO signals (site_id, tag) VALUES (%s, 'sneaky')", [two_sites["other"]])
        assert (
            conn.execute("UPDATE signals SET description = 'x' WHERE site_id = %s", [two_sites["other"]]).rowcount == 0
        )
        # Readings, through the view the API reads: this site's only. The hypertable itself is closed.
        sig = "SELECT DISTINCT g.site_id FROM site_samples x JOIN signals g ON g.id = x.signal_id"
        assert [r["site_id"] for r in conn.execute(sig).fetchall()] == [two_sites["site"]]
        with pytest.raises(psycopg.errors.InsufficientPrivilege), conn.transaction():
            conn.execute("SELECT count(*) FROM samples")
        # Readings are stored for this site's signals only.
        other_signal = conn.execute("SELECT id FROM signals").fetchone()  # this site's
        with all_sites(conn):
            theirs_signal = conn.execute("SELECT id FROM signals WHERE site_id = %s", [two_sites["other"]]).fetchone()
        store = (
            "SELECT tiles_store_samples(%s::uuid[], %s::timestamptz[], %s::float8[], %s::text[], %s::bool[],"
            " %s::text[]) AS n"
        )
        later = datetime.now(UTC) + timedelta(hours=1)
        assert other_signal and theirs_signal

        def args(sid: uuid.UUID) -> list[Any]:
            return [[sid], [later], [2.0], [None], [None], ["good"]]

        assert conn.execute(store, args(other_signal["id"])).fetchone() == {"n": 1}
        assert conn.execute(store, args(theirs_signal["id"])).fetchone() == {"n": 0}
        # The organisation's own audit entries aren't any site's.
        assert conn.execute("SELECT count(*) AS n FROM audit_log WHERE site_id IS NULL").fetchone() == {"n": 0}
        # An organisation's total, by design, spans its sites; then the scope is back.
        with all_sites(conn):
            assert conn.execute(
                "SELECT count(*) AS n FROM datasets WHERE site_id = ANY(%s)", [[two_sites["site"], two_sites["other"]]]
            ).fetchone() == {"n": 2}
        assert conn.execute("SELECT count(*) AS n FROM datasets").fetchone() == {"n": 1}
    # The scope ends with the transaction: a pooled connection doesn't carry it to the next one.
    with psycopg.connect(database_url, row_factory=dict_row) as conn2:
        assert conn2.execute(
            "SELECT count(*) AS n FROM datasets WHERE site_id = ANY(%s)", [[two_sites["site"], two_sites["other"]]]
        ).fetchone() == {"n": 2}


def test_no_site_named_sees_no_rows(database_url: str, two_sites: dict[str, Any]) -> None:
    """Code that names no site (an endpoint that forgot) gets nothing, not everything."""
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        act_as_app(conn)
        assert conn.execute("SELECT count(*) AS n FROM signals").fetchone() == {"n": 0}
        assert conn.execute("SELECT count(*) AS n FROM site_samples").fetchone() == {"n": 0}
        assert conn.execute("SELECT count(*) AS n FROM dataset_rows").fetchone() == {"n": 0}
    # Jobs name every site: they connect with it.
    with psycopg.connect(database_url, row_factory=dict_row, options=UNSCOPED) as conn:
        act_as_app(conn)
        everything = conn.execute("SELECT count(*) AS n FROM signals").fetchone()
        assert everything is not None and everything["n"] >= 2


def test_an_agent_reaches_only_its_own_site(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    two_sites: dict[str, Any],
) -> None:
    token = api.post(f"/sites/{site}/agents", json={"name": "line-1"}, headers=ADMIN).json()["token"]
    auth = {"Authorization": f"Bearer {token}"}
    beat = {"version": "1", "started_at": datetime.now(UTC).isoformat(), "heartbeat_seconds": 30}
    assert api.post("/agent/heartbeat", json=beat, headers=auth).status_code == 200
    # Its readings land on its site's signals, whatever tag another site uses.
    tag = f"tag-{two_sites['other']}"
    batch = {"samples": [{"signal": tag, "at": datetime.now(UTC).isoformat(), "value": 5.0}]}
    assert api.post("/agent/samples", json=batch, headers=auth).json()["stored"] == 1
    with psycopg.connect(database_url) as conn:
        sites = conn.execute(
            "SELECT g.site_id FROM samples x JOIN signals g ON g.id = x.signal_id WHERE x.value = 5"
        ).fetchall()
    assert sites == [(two_sites["site"],)]  # a new signal of its own site, not the other site's


def test_the_copilot_budget_counts_the_organisations_every_site(
    database_url: str, two_sites: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    with psycopg.connect(database_url) as conn:  # the other site's questions today
        conn.execute(
            "INSERT INTO copilot_usage (org_id, site_id, user_id, billed_tokens) VALUES (%s, %s, %s, 6000)",
            [two_sites["org"], two_sites["other"], two_sites["user"]],
        )
    settings = Settings(_env_file=None, copilot_org_daily_tokens=5000)
    conn, ctx = scoped(database_url, two_sites)
    with conn:
        with pytest.raises(Exception) as refused:
            copilot_usage.admit(conn, settings, ctx.org_id, ctx.site_id, ctx.user.id, uuid.uuid4())
        assert "budget of 5,000 tokens" in str(getattr(refused.value, "detail", refused.value))
        assert conn.execute("SELECT count(*) AS n FROM copilot_usage").fetchone() == {"n": 0}  # scope back
        usage = copilot_usage.dashboard(conn, settings, ctx.org_id, ctx.site_id, 30)
        assert usage["today"] == {"org_billed_tokens": 6000, "site_billed_tokens": 0}


def test_the_api_works_as_a_role_that_cant_skip_row_security(api: TestClient) -> None:  # noqa: F811
    state = api.app.state  # type: ignore[attr-defined]
    state.pool = state.pool or open_pool(state.settings)
    with state.pool.connection() as conn:
        row = conn.execute(
            "SELECT current_user AS who, rolsuper OR rolbypassrls AS skips FROM pg_roles WHERE rolname = current_user"
        ).fetchone()
    assert row == {"who": "tiles_app", "skips": False}
