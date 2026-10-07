# ADR 004: OIDC single sign-on and site-level roles

**Status:** Accepted · **Date:** 2026-10-07 · **Tasks:** T1.16–T1.18, T5.04, T5.05

## Context
Enterprise customers expect to sign in with their own identity provider and to restrict people to the sites they work on.

## Decision
- Authentication through OpenID Connect only. Keycloak in development; the customer's provider (for example Entra ID) in production.
- Authorization model: organisation → site → role. Roles start as viewer, engineer and admin, enforced on every write endpoint, and later backed by Postgres row-level security.
- Every write lands in an append-only audit log with who, what, when and before/after values.

## Consequences
- No passwords stored by Tiles.
- Local development needs a Keycloak container (part of Docker Compose).
- Commit authors in the ontology history come from the signed-in identity, not a free-text field.
