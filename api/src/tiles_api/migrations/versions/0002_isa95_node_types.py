"""ISA-95 node types: add Enterprise (above Site) and Cell (a work centre beside Line).

See docs/data-model.md. Downgrading fails while any Enterprise or Cell node
exists; remove those first.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-07 16:33:43.034570
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
ALTER TABLE ontology_nodes DROP CONSTRAINT ontology_nodes_type_check;
ALTER TABLE ontology_nodes ADD CONSTRAINT ontology_nodes_type_check
    CHECK (type IN ('Enterprise', 'Site', 'Workcenter', 'Line', 'Cell', 'Machine', 'Process', 'Material',
                    'PLC', 'Signal', 'Document', 'Model'));
"""

DOWNGRADE = """
ALTER TABLE ontology_nodes DROP CONSTRAINT ontology_nodes_type_check;
ALTER TABLE ontology_nodes ADD CONSTRAINT ontology_nodes_type_check
    CHECK (type IN ('Site', 'Workcenter', 'Line', 'Machine', 'Process', 'Material',
                    'PLC', 'Signal', 'Document', 'Model'));
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
