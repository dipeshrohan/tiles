# Architecture decision records

Short records of decisions that shape Tiles. Each one states the context, the decision and its consequences. To change a decision, add a new record that supersedes the old one rather than editing history.

| # | Decision | Status |
|---|---|---|
| [001](001-stack.md) | TypeScript frontend, Python (FastAPI) backend | Accepted |
| [002](002-storage.md) | PostgreSQL + TimescaleDB; ontology as tables | Accepted |
| [003](003-edge-agent.md) | Outbound-only edge agent for plant data | Accepted |
| [004](004-auth.md) | OIDC single sign-on, org → site → role permissions | Accepted |
| [005](005-ai-copilot.md) | Claude API with tool use; tool-grounded answers only | Accepted |

Template: copy any record, bump the number, keep it under a page.
