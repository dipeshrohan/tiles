"""Schema v1: tenancy, users, ontology history, signals, events, models, runs, audit log.

Revision ID: 0001
Revises:
Create Date: 2026-10-07
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Tenancy -------------------------------------------------------------------

CREATE TABLE orgs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    name        text NOT NULL CHECK (name <> ''),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sites (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    slug        text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    name        text NOT NULL CHECK (name <> ''),
    timezone    text NOT NULL DEFAULT 'UTC',
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, slug)
);

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    email         text NOT NULL CHECK (email = lower(email) AND email LIKE '%_@_%'),
    name          text NOT NULL,
    -- OIDC issuer + subject, filled on first single sign-on login (T1.16).
    oidc_issuer   text,
    oidc_subject  text,
    role          text NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'engineer', 'admin')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz,
    UNIQUE (org_id, email),
    UNIQUE (oidc_issuer, oidc_subject),
    CHECK ((oidc_issuer IS NULL) = (oidc_subject IS NULL))
);

-- Ontology ------------------------------------------------------------------
-- The working graph per site. Edges are not foreign keys to nodes on purpose:
-- the health check reports dangling edges rather than the database refusing
-- them, matching the client-side ontology model.

CREATE TABLE ontology_nodes (
    site_id     uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    id          text NOT NULL CHECK (id <> ''),
    -- Mirrors NodeType in js/lib/types.ts; T1.19 (ISA-95 model) will revise it.
    type        text NOT NULL CHECK (type IN ('Site', 'Workcenter', 'Line', 'Machine', 'Process', 'Material',
                                              'PLC', 'Signal', 'Document', 'Model')),
    label       text NOT NULL,
    props       jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(props) = 'object'),
    PRIMARY KEY (site_id, id)
);
CREATE INDEX ontology_nodes_type ON ontology_nodes (site_id, type);

CREATE TABLE ontology_edges (
    site_id     uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    id          text NOT NULL CHECK (id <> ''),
    from_id     text NOT NULL,
    rel         text NOT NULL CHECK (rel <> ''),
    to_id       text NOT NULL,
    PRIMARY KEY (site_id, id)
);
CREATE INDEX ontology_edges_from ON ontology_edges (site_id, from_id);
CREATE INDEX ontology_edges_to ON ontology_edges (site_id, to_id);

-- Commit history, newest = highest seq. ops and inverses are Op[] as in
-- js/lib/types.ts; stats is DiffStats.
CREATE TABLE commits (
    site_id      uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    id           text NOT NULL CHECK (id <> ''),
    seq          bigint NOT NULL CHECK (seq > 0),
    message      text NOT NULL CHECK (message <> ''),
    author_id    uuid REFERENCES users (id) ON DELETE SET NULL,
    author_name  text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    ops          jsonb NOT NULL CHECK (jsonb_typeof(ops) = 'array'),
    inverses     jsonb NOT NULL CHECK (jsonb_typeof(inverses) = 'array'),
    stats        jsonb NOT NULL CHECK (jsonb_typeof(stats) = 'object'),
    -- Set when this commit reverts another one.
    reverts      text,
    PRIMARY KEY (site_id, id),
    UNIQUE (site_id, seq),
    FOREIGN KEY (site_id, reverts) REFERENCES commits (site_id, id)
);

-- Each user stages their own changes per site until they commit or discard.
CREATE TABLE staged_ops (
    site_id     uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    position    integer NOT NULL CHECK (position >= 0),
    op          jsonb NOT NULL CHECK (jsonb_typeof(op) = 'object' AND op ? 'kind'),
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (site_id, user_id, position)
);

-- Signals and events --------------------------------------------------------

CREATE TABLE signals (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id         uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    tag             text NOT NULL CHECK (tag <> ''),
    unit            text,
    sample_rate_hz  double precision CHECK (sample_rate_hz > 0),
    source          text NOT NULL DEFAULT 'manual',
    -- Ontology node this signal is mapped to (no FK: nodes are versioned).
    node_id         text,
    description     text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (site_id, tag)
);
CREATE INDEX signals_node ON signals (site_id, node_id);

-- Downtime, scrap and other plant events (from MES import or entered by hand).
CREATE TABLE events (
    id          uuid NOT NULL DEFAULT gen_random_uuid(),
    site_id     uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    kind        text NOT NULL CHECK (kind IN ('downtime', 'scrap', 'maintenance', 'alarm', 'note')),
    code        text NOT NULL DEFAULT '',
    node_id     text,
    started_at  timestamptz NOT NULL,
    ended_at    timestamptz,
    source      text NOT NULL DEFAULT 'manual',
    payload     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload) = 'object'),
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id, started_at),
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);
SELECT create_hypertable('events', by_range('started_at', INTERVAL '30 days'));
CREATE INDEX events_site_time ON events (site_id, started_at DESC);
CREATE INDEX events_node_time ON events (site_id, node_id, started_at DESC);

-- Models and runs -----------------------------------------------------------

CREATE TABLE models (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    key         text NOT NULL CHECK (key <> ''),
    version     text NOT NULL CHECK (version <> ''),
    name        text NOT NULL,
    domain      text NOT NULL DEFAULT '',
    kind        text NOT NULL DEFAULT 'design' CHECK (kind IN ('design', 'virtual-sensor')),
    -- Inputs, outputs and parameter specs (ParamSpec[] for design models).
    spec        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(spec) = 'object'),
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, key, version)
);

CREATE TABLE runs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    model_id    uuid NOT NULL REFERENCES models (id) ON DELETE RESTRICT,
    site_id     uuid REFERENCES sites (id) ON DELETE SET NULL,
    params      jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
    outputs     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(outputs) = 'object'),
    status      text NOT NULL DEFAULT 'done' CHECK (status IN ('queued', 'running', 'done', 'failed')),
    author_id   uuid REFERENCES users (id) ON DELETE SET NULL,
    note        text NOT NULL DEFAULT '',
    parent_id   uuid REFERENCES runs (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runs_model ON runs (model_id, created_at DESC);
CREATE INDEX runs_parent ON runs (parent_id);

-- Audit log -----------------------------------------------------------------
-- Append-only: a trigger rejects UPDATE and DELETE.

CREATE TABLE audit_log (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at           timestamptz NOT NULL DEFAULT now(),
    org_id       uuid REFERENCES orgs (id) ON DELETE SET NULL,
    site_id      uuid REFERENCES sites (id) ON DELETE SET NULL,
    actor_id     uuid REFERENCES users (id) ON DELETE SET NULL,
    actor_name   text NOT NULL,
    action       text NOT NULL CHECK (action <> ''),
    entity_type  text NOT NULL CHECK (entity_type <> ''),
    entity_id    text NOT NULL,
    before       jsonb,
    after        jsonb,
    request_id   text
);
CREATE INDEX audit_log_org_time ON audit_log (org_id, at DESC);
CREATE INDEX audit_log_entity ON audit_log (entity_type, entity_id);

CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Deleting the referenced org/site/user nulls those columns; allow only that.
    IF TG_OP = 'UPDATE'
       AND (NEW.id, NEW.at, NEW.actor_name, NEW.action, NEW.entity_type, NEW.entity_id,
            NEW.before, NEW.after, NEW.request_id)
           IS NOT DISTINCT FROM
           (OLD.id, OLD.at, OLD.actor_name, OLD.action, OLD.entity_type, OLD.entity_id,
            OLD.before, OLD.after, OLD.request_id)
       AND (NEW.org_id IS NULL OR NEW.org_id = OLD.org_id)
       AND (NEW.site_id IS NULL OR NEW.site_id = OLD.site_id)
       AND (NEW.actor_id IS NULL OR NEW.actor_id = OLD.actor_id) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_log_append_only
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
"""

DOWNGRADE = """
DROP TABLE audit_log;
DROP FUNCTION audit_log_append_only();
DROP TABLE runs;
DROP TABLE models;
DROP TABLE events;
DROP TABLE signals;
DROP TABLE staged_ops;
DROP TABLE commits;
DROP TABLE ontology_edges;
DROP TABLE ontology_nodes;
DROP TABLE users;
DROP TABLE sites;
DROP TABLE orgs;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
