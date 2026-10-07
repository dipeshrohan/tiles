"""Schema v1: migrations apply and reverse cleanly; constraints hold."""

import json
from collections.abc import Iterator

import psycopg
import pytest
from psycopg import errors
from psycopg.rows import dict_row

from tiles_api.db import alembic_config, downgrade, main, next_revision_id, sqlalchemy_url, upgrade
from tiles_api.settings import Settings, get_settings

TABLES = {
    "orgs",
    "sites",
    "users",
    "site_members",
    "ontology_nodes",
    "ontology_edges",
    "commits",
    "staged_ops",
    "signals",
    "events",
    "models",
    "runs",
    "audit_log",
}


@pytest.fixture
def conn(database_url: str) -> Iterator[psycopg.Connection[dict[str, object]]]:
    """A connection whose changes are rolled back after each test."""
    with psycopg.connect(database_url, row_factory=dict_row) as c:
        yield c
        c.rollback()


@pytest.fixture
def site(conn: psycopg.Connection[dict[str, object]]) -> dict[str, object]:
    org = conn.execute("INSERT INTO orgs (slug, name) VALUES ('acme', 'Acme') RETURNING id").fetchone()
    assert org
    row = conn.execute(
        "INSERT INTO sites (org_id, slug, name) VALUES (%s, 'plant-1', 'Plant 1') RETURNING id, org_id", [org["id"]]
    ).fetchone()
    assert row
    return row


def tables(url: str) -> set[str]:
    with psycopg.connect(url) as c:
        rows = c.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public'").fetchall()
    return {r[0] for r in rows} - {"alembic_version"}


def test_upgrade_creates_every_v1_table(database_url: str) -> None:
    assert tables(database_url) == TABLES


def test_downgrade_drops_everything_and_upgrade_restores_it(database_url: str) -> None:
    settings = Settings(database_url=database_url)
    downgrade(settings, "base")
    assert tables(database_url) == set()
    upgrade(settings)
    assert tables(database_url) == TABLES


def test_timescaledb_is_installed(conn: psycopg.Connection[dict[str, object]]) -> None:
    row = conn.execute("SELECT 1 AS ok FROM pg_extension WHERE extname = 'timescaledb'").fetchone()
    assert row == {"ok": 1}


def test_event_ids_are_unique_and_reimports_are_detected(
    conn: psycopg.Connection[dict[str, object]], site: dict[str, object]
) -> None:
    insert = (
        "INSERT INTO events (id, site_id, kind, started_at, source, source_ref)"
        " VALUES (%s, %s, 'downtime', %s, 'mes', %s)"
    )
    event_id = "00000000-0000-0000-0000-000000000001"
    conn.execute(insert, [event_id, site["id"], "2026-10-07T08:00Z", "MES-1"])
    # Same id with a corrected start time: refused, not a second row.
    with pytest.raises(errors.UniqueViolation), conn.transaction():
        conn.execute(insert, [event_id, site["id"], "2026-10-07T08:05Z", "MES-2"])
    # The same MES event imported again under a new id: refused too.
    with pytest.raises(errors.UniqueViolation), conn.transaction():
        conn.execute(insert, ["00000000-0000-0000-0000-000000000002", site["id"], "2026-10-07T08:00Z", "MES-1"])


def test_ontology_round_trips_nodes_edges_and_commits(
    conn: psycopg.Connection[dict[str, object]], site: dict[str, object]
) -> None:
    sid = site["id"]
    props = {"tonnage": 840, "vendor": "Bühler", "active": True}
    conn.execute(
        "INSERT INTO ontology_nodes (site_id, id, type, label, props) VALUES (%s, 'm1', 'Machine', 'DC-02', %s)",
        [sid, json.dumps(props)],
    )
    # Edges may point at nodes that don't exist; the health check reports them.
    conn.execute(
        "INSERT INTO ontology_edges (site_id, id, from_id, rel, to_id) VALUES (%s, 'e1', 'm1', 'feeds', 'ghost')",
        [sid],
    )
    ops = [{"kind": "addNode", "node": {"id": "m1", "type": "Machine", "label": "DC-02", "props": props}}]
    inverses = [{"kind": "removeNode", "id": "m1"}]
    conn.execute(
        "INSERT INTO commits (site_id, id, seq, message, author_name, ops, inverses, stats)"
        " VALUES (%s, 'c1', 1, 'add DC-02', 'Demo User', %s, %s, %s)",
        [sid, json.dumps(ops), json.dumps(inverses), json.dumps({"nodes": 1, "edges": 0, "props": 0})],
    )
    conn.execute(
        "INSERT INTO commits (site_id, id, seq, message, author_name, ops, inverses, stats, reverts)"
        " VALUES (%s, 'c2', 2, 'Revert \"add DC-02\"', 'Demo User', %s, %s, %s, 'c1')",
        [sid, json.dumps(inverses), json.dumps(ops), json.dumps({"nodes": 1, "edges": 0, "props": 0})],
    )
    node = conn.execute("SELECT props FROM ontology_nodes WHERE site_id = %s", [sid]).fetchone()
    assert node == {"props": props}
    history = conn.execute("SELECT id, ops FROM commits WHERE site_id = %s ORDER BY seq DESC", [sid]).fetchall()
    assert [c["id"] for c in history] == ["c2", "c1"]
    assert history[1]["ops"] == ops


@pytest.mark.parametrize(
    ("statement", "error"),
    [
        ("INSERT INTO orgs (slug, name) VALUES ('Not A Slug', 'x')", errors.CheckViolation),
        (
            "INSERT INTO ontology_nodes (site_id, id, type, label) VALUES ({site}, 'n', 'Spaceship', 'x')",
            errors.CheckViolation,
        ),
        (
            "INSERT INTO ontology_nodes (site_id, id, type, label, props) VALUES ({site}, 'n', 'Line', 'x', '[]')",
            errors.CheckViolation,
        ),
        ("INSERT INTO users (org_id, email, name) VALUES ({org}, 'Upper@Example.com', 'x')", errors.CheckViolation),
        (
            "WITH u AS (INSERT INTO users (org_id, email, name) VALUES ({org}, 'a@example.com', 'x') RETURNING id)"
            " INSERT INTO site_members (site_id, user_id, role) SELECT {site}, id, 'root' FROM u",
            errors.CheckViolation,
        ),
        (
            "INSERT INTO users (org_id, email, name, oidc_subject) VALUES ({org}, 'a@example.com', 'x', 'sub')",
            errors.CheckViolation,
        ),
        (
            "INSERT INTO commits (site_id, id, seq, message, author_name, ops, inverses, stats)"
            " VALUES ({site}, 'c', 1, 'm', 'a', '[]', '[]', '{{}}'), ({site}, 'd', 1, 'm', 'a', '[]', '[]', '{{}}')",
            errors.UniqueViolation,
        ),
        (
            "INSERT INTO commits (site_id, id, seq, message, author_name, ops, inverses, stats, reverts)"
            " VALUES ({site}, 'c', 1, 'm', 'a', '[]', '[]', '{{}}', 'missing')",
            errors.ForeignKeyViolation,
        ),
        (
            "INSERT INTO events (site_id, kind, started_at, ended_at)"
            " VALUES ({site}, 'downtime', now(), now() - '1h'::interval)",
            errors.CheckViolation,
        ),
        ("INSERT INTO signals (site_id, tag, sample_rate_hz) VALUES ({site}, 'DC02.P', 0)", errors.CheckViolation),
    ],
)
def test_constraints_reject_bad_rows(
    conn: psycopg.Connection[dict[str, object]], site: dict[str, object], statement: str, error: type[Exception]
) -> None:
    query = statement.format(site=f"'{site['id']}'", org=f"'{site['org_id']}'")
    with pytest.raises(error):
        conn.execute(query)


def test_audit_log_is_append_only(conn: psycopg.Connection[dict[str, object]], site: dict[str, object]) -> None:
    conn.execute(
        "INSERT INTO audit_log (org_id, site_id, actor_name, action, entity_type, entity_id, after)"
        " VALUES (%s, %s, 'Demo User', 'commit', 'commit', 'c1', '{\"message\": \"m\"}')",
        [site["org_id"], site["id"]],
    )
    with pytest.raises(errors.InsufficientPrivilege), conn.transaction():
        conn.execute("UPDATE audit_log SET action = 'tampered'")
    with pytest.raises(errors.InsufficientPrivilege), conn.transaction():
        conn.execute("UPDATE audit_log SET org_id = NULL, site_id = NULL, actor_id = NULL")
    with pytest.raises(errors.InsufficientPrivilege), conn.transaction():
        conn.execute("DELETE FROM audit_log")
    with pytest.raises(errors.InsufficientPrivilege), conn.transaction():
        conn.execute("TRUNCATE audit_log")
    # Deleting the site leaves the entry exactly as written.
    conn.execute("DELETE FROM sites WHERE id = %s", [site["id"]])
    entry = conn.execute("SELECT site_id, org_id, action FROM audit_log").fetchone()
    assert entry == {"site_id": site["id"], "org_id": site["org_id"], "action": "commit"}


def test_runs_keep_lineage_and_models_cannot_be_deleted_under_them(
    conn: psycopg.Connection[dict[str, object]], site: dict[str, object]
) -> None:
    model = conn.execute(
        "INSERT INTO models (org_id, key, version, name) VALUES (%s, 'beam', 'v2', 'Beam') RETURNING id",
        [site["org_id"]],
    ).fetchone()
    assert model
    parent = conn.execute(
        "INSERT INTO runs (model_id, params, outputs) VALUES (%s, '{\"L\": 2}', '{\"defl\": 1.5}') RETURNING id",
        [model["id"]],
    ).fetchone()
    assert parent
    conn.execute(
        "INSERT INTO runs (model_id, params, parent_id) VALUES (%s, '{\"L\": 3}', %s)", [model["id"], parent["id"]]
    )
    with pytest.raises(errors.ForeignKeyViolation), conn.transaction():
        conn.execute("DELETE FROM models WHERE id = %s", [model["id"]])


def test_run_parents_must_be_the_same_model(
    conn: psycopg.Connection[dict[str, object]], site: dict[str, object]
) -> None:
    def model(key: str, version: str) -> object:
        row = conn.execute(
            "INSERT INTO models (org_id, key, version, name) VALUES (%s, %s, %s, %s) RETURNING id",
            [site["org_id"], key, version, key],
        ).fetchone()
        assert row
        return row["id"]

    beam_v1, beam_v2, pump = model("beam", "v1"), model("beam", "v2"), model("pump", "v1")
    parent = conn.execute("INSERT INTO runs (model_id, params) VALUES (%s, '{}') RETURNING id", [beam_v1]).fetchone()
    assert parent
    # Another version of the same model may continue the lineage...
    conn.execute("INSERT INTO runs (model_id, params, parent_id) VALUES (%s, '{}', %s)", [beam_v2, parent["id"]])
    # ...an unrelated model may not.
    with pytest.raises(errors.ForeignKeyViolation, match="same model"), conn.transaction():
        conn.execute("INSERT INTO runs (model_id, params, parent_id) VALUES (%s, '{}', %s)", [pump, parent["id"]])


def test_site_roles_are_per_site(conn: psycopg.Connection[dict[str, object]], site: dict[str, object]) -> None:
    other = conn.execute(
        "INSERT INTO sites (org_id, slug, name) VALUES (%s, 'plant-2', 'Plant 2') RETURNING id", [site["org_id"]]
    ).fetchone()
    user = conn.execute(
        "INSERT INTO users (org_id, email, name) VALUES (%s, 'eng@example.com', 'Eng') RETURNING id, org_admin",
        [site["org_id"]],
    ).fetchone()
    assert other and user
    assert user["org_admin"] is False
    conn.execute(
        "INSERT INTO site_members (site_id, user_id, role) VALUES (%s, %s, 'engineer'), (%s, %s, 'viewer')",
        [site["id"], user["id"], other["id"], user["id"]],
    )
    roles = conn.execute(
        "SELECT s.slug, m.role FROM site_members m JOIN sites s ON s.id = m.site_id WHERE m.user_id = %s ORDER BY 1",
        [user["id"]],
    ).fetchall()
    assert roles == [{"slug": "plant-1", "role": "engineer"}, {"slug": "plant-2", "role": "viewer"}]


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        ("postgresql://u:p@h:5432/d", "postgresql+psycopg://u:p@h:5432/d"),
        ("postgres://u@h/d", "postgresql+psycopg://u@h/d"),
        ("postgresql+psycopg://u@h/d", "postgresql+psycopg://u@h/d"),
    ],
)
def test_sqlalchemy_url_uses_psycopg3(given: str, expected: str) -> None:
    assert sqlalchemy_url(given) == expected


def test_sqlalchemy_url_rejects_other_databases() -> None:
    with pytest.raises(ValueError, match="postgresql"):
        sqlalchemy_url("mysql://u@h/d")


def test_alembic_config_escapes_percent_in_passwords() -> None:
    cfg = alembic_config(Settings(database_url="postgresql://u:p%40ss@h/d"))
    assert cfg.get_main_option("sqlalchemy.url") == "postgresql+psycopg://u:p%40ss@h/d"


def test_next_revision_id_follows_the_head() -> None:
    assert next_revision_id(alembic_config(Settings())) == "0003"


def test_migrate_command_upgrades_and_reports(database_url: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TILES_DATABASE_URL", database_url)
    get_settings.cache_clear()
    try:
        main(["downgrade", "base"])
        assert tables(database_url) == set()
        main(["upgrade"])
        assert tables(database_url) == TABLES
    finally:
        get_settings.cache_clear()


def test_isa95_node_types_are_accepted(conn: psycopg.Connection[dict[str, object]], site: dict[str, object]) -> None:
    for i, t in enumerate(("Enterprise", "Site", "Workcenter", "Line", "Cell", "Machine")):
        conn.execute(
            "INSERT INTO ontology_nodes (site_id, id, type, label) VALUES (%s, %s, %s, 'x')", [site["id"], f"n{i}", t]
        )


def test_downgrading_isa95_types_refuses_while_they_are_in_use(database_url: str) -> None:
    settings = Settings(database_url=database_url)
    with psycopg.connect(database_url) as c:
        org = c.execute("INSERT INTO orgs (slug, name) VALUES ('isa', 'Isa') RETURNING id").fetchone()
        assert org
        s = c.execute("INSERT INTO sites (org_id, slug, name) VALUES (%s, 'p', 'P') RETURNING id", [org[0]]).fetchone()
        assert s
        c.execute("INSERT INTO ontology_nodes (site_id, id, type, label) VALUES (%s, 'c', 'Cell', 'Cell 1')", [s[0]])
    with pytest.raises(Exception, match="ontology_nodes_type_check"):
        downgrade(settings, "0001")
    with psycopg.connect(database_url) as c:
        c.execute("DELETE FROM orgs WHERE slug = 'isa'")
    downgrade(settings, "0001")
    upgrade(settings)
