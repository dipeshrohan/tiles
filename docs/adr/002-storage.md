# ADR 002: PostgreSQL + TimescaleDB, ontology as tables

**Status:** Accepted · **Date:** 2026-10-07 · **Tasks:** T1.12, T2.06

## Context
Tiles stores three kinds of data: the factory ontology (a typed graph with commit history), high-rate time series from machines, and ordinary records (users, warnings, runs, audit log).

## Decision
- One PostgreSQL database with the TimescaleDB extension.
- Time series go in hypertables with compression and retention policies.
- The ontology is stored as `ontology_nodes`, `ontology_edges`, `commits` and `staged_ops` tables. Graph queries use recursive CTEs.
- Redis backs the job queue only; it holds no source-of-truth data.
- The schema is written in plain SQL and versioned with Alembic migrations (`api/src/tiles_api/migrations/`); there is no ORM model layer. Migrations are numbered `0001`, `0002`, … and each one must downgrade cleanly.

## Consequences
- One database to run, back up and secure, which matters for customer-hosted installs.
- Deep multi-hop graph queries may get slow at very large scale. If profiling shows that, add a graph database as a read model through a new ADR; the tables remain the source of truth.
