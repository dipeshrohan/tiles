"""Change approval (T2.12): a site can require a review before an ontology change is committed.

A change request holds an author's staged ops until another engineer approves it
(which commits them, with the author as author and the reviewer recorded on the
commit) or rejects it. Comments, including the one given with a decision, are kept.

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-08 16:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
ALTER TABLE sites ADD COLUMN review_required boolean NOT NULL DEFAULT false;

-- Who approved a commit; null when it was committed without a review.
ALTER TABLE commits ADD COLUMN reviewer_name text;

CREATE TABLE change_requests (
    site_id          uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    number           integer NOT NULL CHECK (number > 0),
    message          text NOT NULL CHECK (message <> ''),
    author_id        uuid REFERENCES users (id) ON DELETE SET NULL,
    author_name      text NOT NULL,
    -- The engineer asked to review it; null: any engineer of the site.
    reviewer_id      uuid REFERENCES users (id) ON DELETE SET NULL,
    ops              jsonb NOT NULL CHECK (jsonb_typeof(ops) = 'array' AND jsonb_array_length(ops) > 0),
    stats            jsonb NOT NULL CHECK (jsonb_typeof(stats) = 'object'),
    -- Set when the change reverts a commit.
    reverts          text,
    status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected', 'withdrawn')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    decided_by_id    uuid REFERENCES users (id) ON DELETE SET NULL,
    decided_by_name  text,
    decided_at       timestamptz,
    commit_id        text,
    PRIMARY KEY (site_id, number),
    FOREIGN KEY (site_id, reverts) REFERENCES commits (site_id, id),
    FOREIGN KEY (site_id, commit_id) REFERENCES commits (site_id, id),
    CHECK ((status = 'approved') = (commit_id IS NOT NULL)),
    CHECK ((status = 'open') = (decided_at IS NULL))
);
CREATE INDEX change_requests_status ON change_requests (site_id, status, number DESC);

CREATE TABLE change_request_comments (
    id          bigserial PRIMARY KEY,
    site_id     uuid NOT NULL,
    number      integer NOT NULL,
    author_id   uuid REFERENCES users (id) ON DELETE SET NULL,
    author_name text NOT NULL,
    body        text NOT NULL,
    -- The decision this entry records, if any; a decision may come without words.
    verdict     text CHECK (verdict IN ('approved', 'rejected', 'withdrawn')),
    created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (site_id, number) REFERENCES change_requests (site_id, number) ON DELETE CASCADE,
    CHECK (body <> '' OR verdict IS NOT NULL)
);
CREATE INDEX change_request_comments_request ON change_request_comments (site_id, number, id);
"""

DOWNGRADE = """
DROP TABLE change_request_comments;
DROP TABLE change_requests;
ALTER TABLE commits DROP COLUMN reviewer_name;
ALTER TABLE sites DROP COLUMN review_required;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
