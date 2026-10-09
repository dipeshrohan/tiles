"""Organisations' own identity providers and SCIM provisioning (T5.05).

`org_identity_providers`: an organisation's sign-in provider (a customer's Entra ID tenant, say).
Tokens from its issuer sign in to that organisation only, whatever they claim; `group_roles` maps
the provider's group IDs to Tiles roles; `enforced` refuses the deployment's own issuer for the
organisation once its provider works. `scim_tokens`: the bearer tokens a provider provisions users
with (only their hashes). Users gain `active` (a deactivated user can't sign in), `external_id`
(the provider's ID for them) and `deleted_at` (deleted through SCIM: kept for the history that
names them, gone from SCIM). Organisation-wide, so not under the site row policy.

Revision ID: 0027
Revises: 0026
Create Date: 2026-10-09 21:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0027"
down_revision: str | None = "0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
CREATE TABLE org_identity_providers (
    org_id      uuid PRIMARY KEY REFERENCES orgs (id) ON DELETE CASCADE,
    issuer      text NOT NULL UNIQUE CHECK (issuer ~ '^https://[^/?#]+(/[^?#]*)?$' AND issuer !~ '/$'),
    client_id   text NOT NULL CHECK (client_id <> ''),
    audience    text NOT NULL CHECK (audience <> ''),
    scope       text NOT NULL DEFAULT 'openid email profile',
    jwks_url    text CHECK (jwks_url ~ '^https://'),
    group_roles jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(group_roles) = 'object'),
    enforced    boolean NOT NULL DEFAULT false,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scim_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (name <> ''),
    token_hash   bytea NOT NULL UNIQUE,
    created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at   timestamptz
);
CREATE INDEX scim_tokens_org ON scim_tokens (org_id);

ALTER TABLE users
    ADD COLUMN active boolean NOT NULL DEFAULT true,
    ADD COLUMN external_id text,
    ADD COLUMN deleted_at timestamptz;
CREATE UNIQUE INDEX users_external_id ON users (org_id, external_id) WHERE external_id IS NOT NULL;
"""

DOWNGRADE = """
DROP INDEX users_external_id;
ALTER TABLE users DROP COLUMN deleted_at, DROP COLUMN external_id, DROP COLUMN active;
DROP TABLE scim_tokens;
DROP TABLE org_identity_providers;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
