"""Saved insights (T3.12): a finding worth keeping (what was asked, the evidence it gave and what to
do about it), numbered per site and reviewed by another engineer.

`query` is what produced the evidence (a correlation of a dataset, or signals over a time range);
`evidence` is what it gave when the insight was saved, kept as it was, so the insight still shows
what was seen after the data changes.

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-09 06:20:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
CREATE TABLE insights (
    site_id      uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    number       integer NOT NULL CHECK (number > 0),
    title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    summary      text NOT NULL DEFAULT '',
    actions      jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(actions) = 'array'),
    kind         text NOT NULL CHECK (kind IN ('correlation', 'series')),
    query        jsonb NOT NULL CHECK (jsonb_typeof(query) = 'object'),
    evidence     jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
    status       text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'rejected')),
    author_id    uuid REFERENCES users (id) ON DELETE SET NULL,
    author_name  text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    reviewer_id  uuid REFERENCES users (id) ON DELETE SET NULL,
    reviewer_name text,
    reviewed_at  timestamptz,
    review_note  text NOT NULL DEFAULT '',
    PRIMARY KEY (site_id, number)
);

CREATE INDEX insights_status ON insights (site_id, status, number DESC);
"""

DOWNGRADE = """
DROP TABLE insights;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
