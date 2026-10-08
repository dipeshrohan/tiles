"""Signal catalogue (T2.08): a Signal node in the ontology maps to at most one signal tag per site.

`signals.node_id` names a node of the site's committed ontology (no foreign key:
nodes are versioned and may be removed later, which the catalogue shows).

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-08 10:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
CREATE UNIQUE INDEX signals_one_tag_per_node ON signals (site_id, node_id) WHERE node_id IS NOT NULL;
"""

DOWNGRADE = """
DROP INDEX signals_one_tag_per_node;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
