# ADR 001: TypeScript frontend, Python backend

**Status:** Accepted · **Date:** 2026-10-07 · **Tasks:** T1.06–T1.10

## Context
Tiles is a zero-dependency browser app today: plain ES modules, tested pure logic in `js/lib`, string-template views, no backend. The roadmap needs a shared backend, real data, physics and ML models, and a team of about six.

## Decision
- **Frontend:** TypeScript (strict) built with Vite. Port `js/lib/*` first, unchanged in behaviour, with its tests moved to Vitest. Keep the string-template views for now; revisit React only if view complexity demands it (separate ADR).
- **Backend:** Python 3.12 with FastAPI, pytest, ruff and mypy.
- **Shared logic:** where the same rule runs on both sides (ontology ops, health check), both implementations run against one JSON fixture suite.

## Consequences
- Physics, data science and ML code use the Python ecosystem (NumPy, SciPy, pandas).
- Two languages to maintain; the shared fixture suite keeps them honest.
- Vite builds a single classic (IIFE) script, `js/tiles.bundle.js`, rather than ES modules, so `index.html` still opens from disk. A test fails if the committed bundle is stale.
- TypeScript is pinned to 6.0.x until `typescript-eslint` supports TypeScript 7.
