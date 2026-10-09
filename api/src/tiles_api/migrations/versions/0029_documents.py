"""Document search (T4.08): a site's documents (SOPs, manuals, lessons learned), the file as it
was sent, and its text in chunks, each with its page, searched with PostgreSQL's full-text search
in the document's language (`tsv`, a GIN index). Archived documents are kept, out of search.

Revision ID: 0029
Revises: 0028
Create Date: 2026-10-09 23:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0029"
down_revision: str | None = "0028"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Tables of a site's data (row security, T5.04): tests/test_row_security.py reads this.
SITE_TABLES = ("document_chunks", "document_numbers", "documents")

UPGRADE = """
CREATE TABLE document_numbers (
    site_id uuid PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
    last    integer NOT NULL
);

CREATE TABLE documents (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id       uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    number        integer NOT NULL,
    title         text NOT NULL CHECK (title <> '' AND length(title) <= 200),
    filename      text NOT NULL,
    content_type  text NOT NULL,
    language      regconfig NOT NULL DEFAULT 'english',
    pages         integer NOT NULL CHECK (pages > 0),
    size          integer NOT NULL CHECK (size > 0),
    sha256        text NOT NULL,
    content       bytea NOT NULL,
    uploaded_by_id uuid REFERENCES users (id) ON DELETE SET NULL,
    uploaded_by   text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    archived_at   timestamptz,
    UNIQUE (site_id, number),
    UNIQUE (site_id, id)
);

CREATE TABLE document_chunks (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    site_id     uuid NOT NULL,
    document_id uuid NOT NULL,
    page        integer NOT NULL CHECK (page > 0),
    ordinal     integer NOT NULL,
    language    regconfig NOT NULL,
    text        text NOT NULL,
    tsv         tsvector GENERATED ALWAYS AS (to_tsvector(language, text)) STORED,
    FOREIGN KEY (site_id, document_id) REFERENCES documents (site_id, id) ON DELETE CASCADE,
    UNIQUE (document_id, ordinal)
);
CREATE INDEX document_chunks_tsv ON document_chunks USING gin (tsv);
"""

DOWNGRADE = """
DROP TABLE document_chunks;
DROP TABLE documents;
DROP TABLE document_numbers;
"""


def upgrade() -> None:
    op.execute(UPGRADE)
    for table in SITE_TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY site_rows ON {table} USING (tiles_site_visible(site_id))"
            " WITH CHECK (tiles_site_visible(site_id))"
        )


def downgrade() -> None:
    op.execute(DOWNGRADE)
