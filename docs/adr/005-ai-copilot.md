# ADR 005: Claude API with tool use; tool-grounded answers only

**Status:** Accepted · **Date:** 2026-10-07 · **Tasks:** T4.01–T4.07

## Context
The demo copilot routes questions to skills with regular expressions and works offline. Real users ask open-ended questions, so the copilot needs a language model. In a factory, a confident wrong answer is worse than no answer.

## Decision
- Use the Claude API with tool use. The existing skills (graph query, correlation, virtual sensor status, wear check, health check) become tools, plus time-series and event lookup.
- Answers may only state facts that come from tool results, and show which tools ran with what inputs. With no supporting tool result, the copilot says it cannot answer.
- A partner-sourced evaluation set (100+ questions) runs in CI and blocks merges when accuracy drops below 85% or any unsupported claim appears.
- Prompt caching, token budgets and per-organisation rate limits control cost.

## Consequences
- The offline rule-based router stays as a fallback for air-gapped installs.
- Model upgrades are gated by the evaluation suite rather than adopted blindly.
- Plant data sent to the API must follow each customer's data agreement; customer-hosted installs may need a regional or private endpoint.
