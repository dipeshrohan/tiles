# Tiles: implementation task list

This list breaks [ROADMAP.md](ROADMAP.md) into tasks. Each task links to its GitHub issue, and the issues are grouped under one parent issue per month: [Month 1](https://github.com/dipeshrohan/tiles/issues/2) · [Month 2](https://github.com/dipeshrohan/tiles/issues/3) · [Month 3](https://github.com/dipeshrohan/tiles/issues/4) · [Month 4](https://github.com/dipeshrohan/tiles/issues/5) · [Month 5](https://github.com/dipeshrohan/tiles/issues/6) · [Month 6](https://github.com/dipeshrohan/tiles/issues/7) · [Ongoing](https://github.com/dipeshrohan/tiles/issues/8).

GitHub issues are the live tracker; close the issue when a task is done. Filter by the labels `month-N`, `critical-path`, `stretch` and `role:*`.

**How to read a task:** `ID` · **title** · owner · estimate in engineer-days · depends on. Each task ends with *Done when*, the criteria for checking it off.

- **Owners:** TL tech lead · BE backend/data · FE frontend · ML physics/ML · FDE on-site engineer · PM product/design
- **◇** stretch item; cut first if the schedule slips
- **★** on the critical path to the pilot

**Totals:** 95 tasks plus 3 ongoing, about 236 engineer-days of estimated build work. A team of 6 has roughly 600 working days over 6 months; the gap covers code review, meetings, pilot support and estimate overruns, which typically run 1.5–2×.

---

## Month 1: Foundations (Nov 2026)

### Repository and delivery
- [x] `T1.01` [#9](https://github.com/dipeshrohan/tiles/issues/9) ★ **Merge PR #1** (Tiles demo) into `main` · TL · 0.5d
  *Done when:* `main` runs with `npm start` and `npm test` passes.
- [x] `T1.02` [#15](https://github.com/dipeshrohan/tiles/issues/15) ★ **Automated checks on GitHub Actions:** lint (ESLint), format (Prettier), unit tests on every PR · TL · 1d · T1.01
  *Done when:* PRs show required green checks and `main` is protected.
- [x] `T1.03` [#10](https://github.com/dipeshrohan/tiles/issues/10) **Browser smoke test in the automated checks:** Playwright loads every page in light, dark and mobile and fails on console errors or horizontal overflow · FE · 1.5d · T1.02
  *Done when:* a deliberately broken view makes the check fail.
- [x] `T1.04` [#16](https://github.com/dipeshrohan/tiles/issues/16) **Architecture decision records:** `docs/adr/` with 001 stack, 002 storage, 003 edge agent, 004 auth, 005 AI copilot · TL · 1.5d
  *Done when:* five short decision records are merged and reviewed by the team.
- [x] `T1.05` [#17](https://github.com/dipeshrohan/tiles/issues/17) **Contributor guide and `CLAUDE.md`:** setup, conventions, how to run tests · TL · 0.5d · T1.04

### Frontend migration
- [x] `T1.06` [#18](https://github.com/dipeshrohan/tiles/issues/18) ★ **Scaffold Vite + TypeScript** (strict mode) alongside the existing app · FE · 1d · T1.02
- [x] `T1.07` [#19](https://github.com/dipeshrohan/tiles/issues/19) ★ **Port `js/lib/*` to TypeScript** with typed models (Graph, Op, Commit, Shot, Run) · FE · 4d · T1.06
  *Done when:* all 19 existing tests pass under Vitest.
- [x] `T1.08` [#20](https://github.com/dipeshrohan/tiles/issues/20) **Port views to TypeScript components** (keep the template-string approach or adopt React, per ADR 001) · FE · 5d · T1.07
  *Done when:* screenshots match the current app; browser smoke test is green.
- [x] `T1.09` [#21](https://github.com/dipeshrohan/tiles/issues/21) **API client layer:** a typed fetch wrapper with an auth header and error toasts; feature flag to switch between local and API data · FE · 1.5d · T1.08

### Backend foundations
- [x] `T1.10` [#11](https://github.com/dipeshrohan/tiles/issues/11) ★ **Scaffold the FastAPI service:** health endpoint, settings, structured logging, pytest, ruff, mypy · BE · 2d · T1.04
- [x] `T1.11` [#22](https://github.com/dipeshrohan/tiles/issues/22) ★ **Docker Compose:** API + Postgres/TimescaleDB + Redis + frontend, started with one command · BE · 1.5d · T1.10
  *Done when:* `docker compose up` gives a working stack on a fresh laptop.
- [x] `T1.12` [#23](https://github.com/dipeshrohan/tiles/issues/23) ★ **Database schema v1** with migrations: orgs, sites, users, ontology_nodes, ontology_edges, commits, staged_ops, signals, events, models, runs, audit_log · BE · 3d · T1.10
- [x] `T1.13` [#24](https://github.com/dipeshrohan/tiles/issues/24) ★ **Ontology API:** stage, discard, commit, revert, history, working graph; port the `ontology.js` logic to Python and check both against the same test fixtures · BE · 5d · T1.12
  *Done when:* the TypeScript and Python implementations give identical results on a shared JSON fixture suite.
- [x] `T1.14` [#25](https://github.com/dipeshrohan/tiles/issues/25) **Server-side health check endpoint** (orphans, dangling, duplicates, missing properties) · BE · 1d · T1.13
- [x] `T1.15` [#26](https://github.com/dipeshrohan/tiles/issues/26) ★ **Frontend ontology uses the API** instead of `localStorage` · FE · 2d · T1.09, T1.13
  *Done when:* two browsers see each other's commits after refresh.

### Identity and audit
- [x] `T1.16` [#27](https://github.com/dipeshrohan/tiles/issues/27) ★ **Single sign-on login** (Keycloak in dev; any OIDC provider in production); users and orgs created on first login · BE · 3d · T1.12
- [x] `T1.17` [#28](https://github.com/dipeshrohan/tiles/issues/28) **Roles v0:** viewer, engineer, admin, enforced on every write endpoint · BE · 1.5d · T1.16
- [x] `T1.18` [#29](https://github.com/dipeshrohan/tiles/issues/29) **Audit log:** every write recorded with who, what, when and before/after; admin view in the UI · BE+FE · 2d · T1.16
- [x] `T1.19` [#12](https://github.com/dipeshrohan/tiles/issues/12) **ISA-95 data model document:** mapping Site/Area/Line/Cell/Equipment to Tiles node types; update `NODE_TYPES` · TL+PM · 1.5d

**Month 1 exit check:** two users on different machines share ontology history; all checks are green and required on `main`.

---

## Month 2: Real data in (Dec 2026)

### Edge agent
- [x] `T2.01` [#30](https://github.com/dipeshrohan/tiles/issues/30) ★ **Edge agent skeleton** (Python, single binary or container): config file, outbound-only HTTPS/MQTT-TLS to Tiles, heartbeat · BE · 3d · T1.11
- [x] `T2.02` [#31](https://github.com/dipeshrohan/tiles/issues/31) ★ **OPC UA connector:** browse and subscribe to nodes, map to signal IDs, certificate-based security · BE · 4d · T2.01
- [x] `T2.03` [#32](https://github.com/dipeshrohan/tiles/issues/32) **MQTT connector:** subscribe to topics, JSON/Sparkplug B payloads · BE · 2.5d · T2.01
- [x] `T2.04` [#33](https://github.com/dipeshrohan/tiles/issues/33) ★ **Store-and-forward buffer:** disk queue that survives network loss and backfills in order · BE · 2d · T2.01
  *Done when:* a 1-hour network cut loses no samples.
- [x] `T2.05` [#34](https://github.com/dipeshrohan/tiles/issues/34) **SQL connector** for MES and quality databases (polling, watermark column) · BE · 2d · T2.01

### Ingestion and storage
- [x] `T2.06` [#35](https://github.com/dipeshrohan/tiles/issues/35) ★ **Time-series ingest endpoint:** batched writes to TimescaleDB hypertables; compression and retention policies · BE · 3d · T1.12
  *Done when:* sustained 5k samples/s on dev hardware.
- [x] `T2.07` [#36](https://github.com/dipeshrohan/tiles/issues/36) ★ **CSV and historian bulk import** with column-mapping UI for backfill · BE+FE · 3d · T2.06
- [x] `T2.08` [#37](https://github.com/dipeshrohan/tiles/issues/37) **Signal catalogue:** tag, unit, sample rate, source, linked ontology node; browse and search UI · BE+FE · 2.5d · T2.06
- [x] `T2.09` [#38](https://github.com/dipeshrohan/tiles/issues/38) ★ **Data-quality checks:** gaps, stuck values, out-of-range values, unit mismatch; quality badge per signal · BE · 3d · T2.08
- [x] `T2.10` [#39](https://github.com/dipeshrohan/tiles/issues/39) **Data Explorer page:** plot any signals over a time range, with zoom and downsampling · FE · 3d · T2.06

### Ontology at scale
- [x] `T2.11` [#40](https://github.com/dipeshrohan/tiles/issues/40) ★ **Agentic ingestion v1:** suggests the ontology node for each unmapped tag, using names, units, PLC paths and similar tags; the suggestion queue becomes staged ops · ML+BE · 4d · T2.08, T1.13
  *Done when:* at least 70% of suggestions are accepted on the partner's tag list.
- [x] `T2.12` [#41](https://github.com/dipeshrohan/tiles/issues/41) **Change approval workflow:** a commit can require a reviewer; review page with the diff; approve or reject with comments · BE+FE · 3d · T1.13
- [x] `T2.13` [#42](https://github.com/dipeshrohan/tiles/issues/42) **Bulk ontology import/export** (JSON and CSV) · BE · 1.5d · T1.13
- [x] `T2.14` [#43](https://github.com/dipeshrohan/tiles/issues/43) **Canvas layout at scale:** zoom, pan, search, collapse by hierarchy; handles 2,000+ nodes · FE · 3d · T1.15

### Design partner
- [ ] `T2.15` [#44](https://github.com/dipeshrohan/tiles/issues/44) ★ **Assessment checklist and interview guide:** data sources, target problem, baseline metrics · PM · 1d
- [ ] `T2.16` [#45](https://github.com/dipeshrohan/tiles/issues/45) ★ **Run the partner assessment** (2–4 weeks): data-landscape map, top 2–3 value opportunities, one pilot problem chosen · PM+TL · 5d · T2.15
  *Done when:* an assessment report with a signed-off problem statement and baseline metrics.
- [ ] `T2.17` [#46](https://github.com/dipeshrohan/tiles/issues/46) ★ **Data access agreement** and edge-agent install at the partner (or historian export) · TL+PM · 2d · T2.16, T2.04
  *Done when:* one month of partner data is stored and mapped.

**Month 2 exit check:** live or backfilled partner data is flowing, with quality badges and ontology mapping.

---

## Month 3: Operations analytics on real data (Jan 2027)

### Virtual sensor framework
- [x] `T3.01` [#47](https://github.com/dipeshrohan/tiles/issues/47) ★ **Model registry:** register a model in code (inputs, outputs, parameters, version); stored in the `models` table · ML+BE · 3d · T1.12
- [x] `T3.02` [#48](https://github.com/dipeshrohan/tiles/issues/48) ★ **Port the plunger-friction model** to the registry, with unit tests carried over from `physics.test.js` · ML · 2d · T3.01
- [x] `T3.03` [#49](https://github.com/dipeshrohan/tiles/issues/49) ★ **Model runner:** runs registered models on new data windows and writes derived signals back to TimescaleDB · BE · 3d · T3.01, T2.06
- [x] `T3.04` [#50](https://github.com/dipeshrohan/tiles/issues/50) ★ **Streaming detection job:** rolling robust baseline, how long a deviation must persist, cooldown; thresholds stored as config per signal · ML+BE · 3d · T3.03
- [x] `T3.05` [#51](https://github.com/dipeshrohan/tiles/issues/51) ★ **Backtest tool:** replay history to get recall, precision and warning-time distribution per threshold setting · ML · 3d · T3.04
  *Done when:* a report generated for the partner's target machine. The tool is built (`POST /sites/{id}/backtest`, `tiles-backtest`); the report waits on the partner's history (T2.17).
- [ ] `T3.06` [#13](https://github.com/dipeshrohan/tiles/issues/13) **Tune on partner history** and document the chosen settings · ML+FDE · 3d · T3.05, T2.17

### Warning workflow
- [x] `T3.07` [#52](https://github.com/dipeshrohan/tiles/issues/52) ★ **Warnings data model and API:** raised, acknowledged, assigned, resolved, with outcome (true alarm, false alarm, unknown) · BE · 2d · T3.04
- [x] `T3.08` [#53](https://github.com/dipeshrohan/tiles/issues/53) ★ **Warnings inbox UI** with filters, detail view (run chart + payload), acknowledge and assign · FE · 3d · T3.07
- [x] `T3.09` [#54](https://github.com/dipeshrohan/tiles/issues/54) **Notifications** by email and Microsoft Teams webhook, with per-user preferences · BE · 2d · T3.07
- [x] `T3.10` [#55](https://github.com/dipeshrohan/tiles/issues/55) ★ **Event import:** downtime and scrap codes from MES (via T2.05); join to warnings; live precision and warning-time dashboard · BE+FE · 3d · T2.05, T3.07

### Quality analytics
- [x] `T3.11` [#56](https://github.com/dipeshrohan/tiles/issues/56) **Correlation finder v2:** server-side over real batch tables; choose the outcome, variables and split; Cohen's d plus confidence intervals · ML+BE · 3d · T2.06
- [x] `T3.12` [#57](https://github.com/dipeshrohan/tiles/issues/57) **Saved insights:** save a finding with its query, evidence chart and proposed actions; insights are reviewable and linkable · BE+FE · 2.5d · T3.11
- [x] `T3.13` [#14](https://github.com/dipeshrohan/tiles/issues/14) ◇ **Wear-check skill on real signals** (generalise the weld-power check) · ML · 2d · T3.03

### Pilot
- [ ] `T3.14` [#58](https://github.com/dipeshrohan/tiles/issues/58) ★ **Pilot kickoff:** on-site engineer on site, success criteria signed, weekly review cadence set · FDE+PM · 2d · T2.16
- [ ] `T3.15` [#59](https://github.com/dipeshrohan/tiles/issues/59) **Start the security review early:** share the architecture and data-flow diagram with partner IT/OT · TL · 1d · T2.17

**Month 3 exit check:** backtest shows ≥ 50% of targeted downtime events warned, with an accepted false-alarm rate.

---

## Month 4: Copilot and Design Studio (Feb 2027)

### AI copilot
- [x] `T4.01` [#60](https://github.com/dipeshrohan/tiles/issues/60) ★ **Copilot service:** Claude API with tool use; streaming responses; conversation storage per user · BE · 3d · T1.16
- [x] `T4.02` [#61](https://github.com/dipeshrohan/tiles/issues/61) ★ **Turn the existing skills into tools:** graph query, correlation, virtual-sensor status, wear check, health check, time-series query, event lookup · BE · 4d · T4.01, T3.11, T3.03
- [x] `T4.03` [#62](https://github.com/dipeshrohan/tiles/issues/62) ★ **Grounding rules:** answers may only state facts from tool results; cite tool and inputs; decline when nothing supports an answer · BE · 2d · T4.02
- [x] `T4.04` [#63](https://github.com/dipeshrohan/tiles/issues/63) **Copilot UI v2:** streaming, expandable tool traces, links to evidence, feedback on each answer · FE · 3d · T4.01
- [ ] `T4.05` [#64](https://github.com/dipeshrohan/tiles/issues/64) ★ **Evaluation set:** 100+ real partner questions with expected answers and the tools they should use · PM+FDE · 3d · T3.14
- [ ] `T4.06` [#65](https://github.com/dipeshrohan/tiles/issues/65) ★ **Evaluation harness in the automated checks:** scores accuracy, grounding and tool choice; fails under the thresholds · BE · 3d · T4.05, T4.03
  *Done when:* ≥ 85% correct and 0 unsupported claims on the evaluation set.
- [x] `T4.07` [#66](https://github.com/dipeshrohan/tiles/issues/66) **Cost and latency controls:** prompt caching, token budgets, per-org rate limits, usage dashboard · BE · 2d · T4.01
- [ ] `T4.08` [#67](https://github.com/dipeshrohan/tiles/issues/67) ◇ **Document search:** upload SOPs and manuals, chunk and embed them, cite with page numbers · BE · 4d · T4.02
- [x] `T4.09` [#68](https://github.com/dipeshrohan/tiles/issues/68) ◇ **Copilot can stage ontology changes**, which always need human approval through T2.12 · BE · 2d · T4.02, T2.12

### Design Studio backend
- [x] `T4.10` [#69](https://github.com/dipeshrohan/tiles/issues/69) ★ **Shared model registry for Design:** swelling and actuator models ported; versions immutable once published · ML · 3d · T3.01
- [x] `T4.11` [#70](https://github.com/dipeshrohan/tiles/issues/70) **Runs API:** store runs with parent, version, parameters, output and author; restore; compare · BE · 2d · T4.10
- [x] `T4.12` [#71](https://github.com/dipeshrohan/tiles/issues/71) **Sweeps as background jobs:** progress UI and cancel; results cached · BE+FE · 3d · T4.10
- [x] `T4.13` [#72](https://github.com/dipeshrohan/tiles/issues/72) **Audit export:** PDF report plus JSON with the full lineage chain · BE · 2d · T4.11
- [x] `T4.14` [#73](https://github.com/dipeshrohan/tiles/issues/73) **Design Studio UI uses the API**, with shared projects for team collaboration · FE · 3d · T4.11
- [ ] `T4.15` [#74](https://github.com/dipeshrohan/tiles/issues/74) ◇ **Register a model from GitHub or an HTTP endpoint,** run in a sandbox · BE · 4d · T4.10

**Month 4 exit check:** copilot evaluation gate is green; a design result traces to model version, parameters and author.

---

## Month 5: Pilot in production and enterprise hardening (Mar 2027)

### Live pilot
- [ ] `T5.01` [#75](https://github.com/dipeshrohan/tiles/issues/75) ★ **Go live:** real-time warnings on the pilot line; shift-lead sign-off on the warning workflow · FDE · 2d · T3.08, T3.06
- [ ] `T5.02` [#76](https://github.com/dipeshrohan/tiles/issues/76) ★ **Weekly tuning reviews:** review outcomes and adjust thresholds through config, with a change log · FDE+ML · 4 × 0.5d · T5.01
- [ ] `T5.03` [#77](https://github.com/dipeshrohan/tiles/issues/77) **Populate the pilot knowledge base:** SOPs, lessons learned, equipment history · FDE · 2d · T4.08

### Security
- [x] `T5.04` [#78](https://github.com/dipeshrohan/tiles/issues/78) ★ **Site-level permissions** with row-level security in Postgres · BE · 3d · T1.17
- [ ] `T5.05` [#79](https://github.com/dipeshrohan/tiles/issues/79) **Single sign-on with the customer's identity provider** (Azure AD / Entra) and SCIM user provisioning ◇ · BE · 2d · T1.16
- [x] `T5.06` [#80](https://github.com/dipeshrohan/tiles/issues/80) ★ **Encryption at rest, secrets manager, key rotation runbook** · BE · 2d
- [x] `T5.07` [#81](https://github.com/dipeshrohan/tiles/issues/81) ★ **Threat model** (STRIDE) and IEC 62443 gap list for the edge agent and cloud · TL · 2d · T3.15
- [x] `T5.08` [#82](https://github.com/dipeshrohan/tiles/issues/82) **Dependency and container scanning in the automated checks**; SBOM generation · TL · 1d · T1.02

### Deployment
- [x] `T5.09` [#83](https://github.com/dipeshrohan/tiles/issues/83) ★ **Helm charts** for API, workers, frontend and database (or managed database) · BE · 3d · T1.11
- [ ] `T5.10` [#84](https://github.com/dipeshrohan/tiles/issues/84) **Terraform modules** for the managed cloud and a customer-hosted reference install · BE · 3d · T5.09
- [ ] `T5.11` [#85](https://github.com/dipeshrohan/tiles/issues/85) **Hybrid mode:** edge agent on site plus Tiles cloud; documented firewall rules (outbound only) · BE · 2d · T2.04, T5.10
- [ ] `T5.12` [#86](https://github.com/dipeshrohan/tiles/issues/86) **Customer-hosted install guide** and a dry run on a clean cluster · BE+TL · 2d · T5.10

### Operations
- [x] `T5.13` [#87](https://github.com/dipeshrohan/tiles/issues/87) **Monitoring:** OpenTelemetry traces, metrics and dashboards; alerts for ingest lag and job failures · BE · 3d
- [x] `T5.14` [#88](https://github.com/dipeshrohan/tiles/issues/88) ★ **Backups and a restore drill** (point-in-time recovery for Postgres) · BE · 1.5d
  *Done when:* restoring into a fresh environment is documented and timed.
- [x] `T5.15` [#89](https://github.com/dipeshrohan/tiles/issues/89) ★ **Load test:** 10k signals at 1 Hz, 50 concurrent users; fix bottlenecks · BE · 3d · T2.06
  *Done when:* p95 API latency < 500 ms and ingest lag < 10 s under load.

### UX
- [x] `T5.16` [#90](https://github.com/dipeshrohan/tiles/issues/90) **Shopfloor view:** tablet layout, large type, warnings-first, works with gloves (big touch targets) · FE+PM · 3d · T3.08
- [x] `T5.17` [#91](https://github.com/dipeshrohan/tiles/issues/91) **Site → line → machine navigator** built from the ontology hierarchy · FE · 2d · T1.15
- [ ] `T5.18` [#92](https://github.com/dipeshrohan/tiles/issues/92) **Accessibility pass:** keyboard navigation, contrast, screen-reader labels on charts · FE · 2d

**Month 5 exit check:** 4+ weeks of live warnings with outcomes logged; security review passed or has a clear remaining list.

---

## Month 6: Prove value and ship v1.0 (Apr 2027)

### Value
- [ ] `T6.01` [#93](https://github.com/dipeshrohan/tiles/issues/93) ★ **ROI report:** downtime avoided, scrap reduced, warning time and false-alarm rate against the month-2 baseline, with each number reproducible from the data · PM+ML · 3d · T5.02
- [ ] `T6.02` [#94](https://github.com/dipeshrohan/tiles/issues/94) ★ **Partner sign-off meeting** and a production-deployment quote · PM+TL · 1d · T6.01
- [ ] `T6.03` [#95](https://github.com/dipeshrohan/tiles/issues/95) **Case study write-up** (anonymised if needed) · PM · 1.5d · T6.02

### Release
- [x] `T6.04` [#96](https://github.com/dipeshrohan/tiles/issues/96) ★ **Versioning and release process:** semantic versions, changelog, release notes, migration testing between versions · TL · 2d
- [x] `T6.05` [#97](https://github.com/dipeshrohan/tiles/issues/97) ★ **Documentation:** admin guide, user guide, model-author guide, API reference · PM+TL · 4d
- [ ] `T6.06` [#98](https://github.com/dipeshrohan/tiles/issues/98) **New-site onboarding flow:** a wizard from site creation → edge agent → tag mapping → first dashboard · FE+BE · 4d · T2.11
  *Done when:* onboarding a new machine takes under 1 day.
- [ ] `T6.07` [#99](https://github.com/dipeshrohan/tiles/issues/99) ★ **External penetration test** and remediation of all high and critical findings · TL · 3d (+ vendor time) · T5.07
- [ ] `T6.08` [#100](https://github.com/dipeshrohan/tiles/issues/100) **SOC 2 / ISO 27001 readiness plan:** list of controls, owners, timeline · TL · 2d · T5.07
- [ ] `T6.09` [#101](https://github.com/dipeshrohan/tiles/issues/101) ★ **Tag v1.0** and deploy it to the pilot environment · TL · 1d · T6.04–T6.07
- [ ] `T6.10` [#102](https://github.com/dipeshrohan/tiles/issues/102) ◇ **App Studio v0:** templates (e.g. wear check, SPC limit) configurable without core code changes · BE+FE · 6d · T3.13

### Plan ahead
- [ ] `T6.11` [#103](https://github.com/dipeshrohan/tiles/issues/103) **Retrospective** and roadmap for the next 6 months: second line or site, cross-site benchmarking, new physics models · PM+TL · 1d · T6.09

**Month 6 exit check:** v1.0 tagged, ROI report signed off, production deployment quoted.

---

## Ongoing (every month)

- [ ] `T0.01` [#104](https://github.com/dipeshrohan/tiles/issues/104) **Monthly metrics review:** warning recall, precision and warning time; copilot accuracy; data freshness; weekly active users; ontology health; onboarding time · PM
- [ ] `T0.02` [#105](https://github.com/dipeshrohan/tiles/issues/105) **Risk review:** update the risk table in ROADMAP.md; cut ◇ items if the critical path slips · TL
- [ ] `T0.03` [#106](https://github.com/dipeshrohan/tiles/issues/106) **Keep tests green:** no skipped tests; each bug fix ships with a regression test · All

## Critical path

T1.01 → T1.10 → T1.12 → T1.13 → T2.01 → T2.04 → T2.06 → T2.17 → T3.01 → T3.03 → T3.04 → T3.05 → T3.06 → T5.01 → T5.02 → T6.01 → T6.02

A slip on any of these moves the pilot date. Watch T2.17 (partner data access) most closely.
