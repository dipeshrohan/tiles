# ADR 003: Outbound-only edge agent

**Status:** Accepted · **Date:** 2026-10-07 · **Tasks:** T2.01–T2.05, T5.11

## Context
Machine data lives on the plant network (OPC UA, MQTT, SQL historians, MES). Plant IT/OT teams rarely allow inbound connections into that network.

## Decision
A small agent runs on site, reads from OPC UA, MQTT and SQL sources, and pushes data outward to Tiles over TLS. It opens no inbound ports. It buffers to disk when the link is down and backfills in order when it returns. It is configured by a single file and reports a heartbeat.

## Consequences
- Matches what security reviews approve, and supports cloud, customer-hosted and hybrid deployments with the same agent.
- The agent needs its own release, update and certificate process.
- Commands from Tiles to the plant (if ever needed) must be pulled by the agent, never pushed in.
