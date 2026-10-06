# Tiles: implementation task list

This list breaks [ROADMAP.md](ROADMAP.md) into tasks. Tick them off as they land.

**How to read a task:** `ID` · **title** · owner · estimate in engineer-days · depends on. Each task ends with *Done when*, the criteria for checking it off.

- **Owners:** TL tech lead · BE backend/data · FE frontend · ML physics/ML · FDE on-site engineer · PM product/design
- **◇** stretch item; cut first if the schedule slips
- **★** on the critical path to the pilot

**Totals:** 95 tasks plus 3 ongoing, about 236 engineer-days of estimated build work. A team of 6 has roughly 600 working days over 6 months; the gap covers code review, meetings, pilot support and estimate overruns, which typically run 1.5–2×.

---

## Month 1: Foundations (Nov 2026)

### Repository and delivery
- [ ] `T1.01` ★ **Merge PR #1** (Tiles demo) into `main` · TL · 0.5d
  *Done when:* `main` runs with `npm start` and `npm test` passes.
- [ ] `T1.02` ★ **Automated checks on GitHub Actions:** lint (ESLint), format (Prettier), unit tests on every PR · TL · 1d · T1.01
  *Done when:* PRs show required green checks and `main` is protected.
- [ ] `T1.03` **Browser smoke test in the automated checks:** Playwright loads every page in light, dark and mobile and fails on console errors or horizontal overflow · FE · 1.5d · T1.02
  *Done when:* a deliberately broken view makes the check fail.
- [ ] `T1.04` **Architecture decision records:** `docs/adr/` with 001 stack, 002 storage, 003 edge agent, 004 auth, 005 AI copilot · TL · 1.5d
  *Done when:* five short decision records are merged and reviewed by the team.
- [ ] `T1.05` **Contributor guide and `CLAUDE.md`:** setup, conventions, how to run tests · TL · 0.5d · T1.04

### Frontend migration
- [ ] `T1.06` ★ **Scaffold Vite + TypeScript** (strict mode) alongside the existing app · FE · 1d · T1.02
- [ ] `T1.07` ★ **Port `js/lib/*` to TypeScript** with typed models (Graph, Op, Commit, Shot, Run) · FE · 4d · T1.06
  *Done when:* all 19 existing tests pass under Vitest.
- [ ] `T1.08` **Port views to TypeScript components** (keep the template-string approach or adopt React, per ADR 001) · FE · 5d · T1.07
  *Done when:* screenshots match the current app; browser smoke test is green.
- [ ] `T1.09` **API client layer:** a typed fetch wrapper with an auth header and error toasts; feature flag to switch between local and API data · FE · 1.5d · T1.08

### Backend foundations
- [ ] `T1.10` ★ **Scaffold the FastAPI service:** health endpoint, settings, structured logging, pytest, ruff, mypy · BE · 2d · T1.04
- [ ] `T1.11` ★ **Docker Compose:** API + Postgres/TimescaleDB + Redis + frontend, started with one command · BE · 1.5d · T1.10
  *Done when:* `docker compose up` gives a working stack on a fresh laptop.
- [ ] `T1.12` ★ **Database schema v1** with migrations: orgs, sites, users, ontology_nodes, ontology_edges, commits, staged_ops, signals, events, models, runs, audit_log · BE · 3d · T1.10
- [ ] `T1.13` ★ **Ontology API:** stage, discard, commit, revert, history, working graph; port the `ontology.js` logic to Python and check both against the same test fixtures · BE · 5d · T1.12
  *Done when:* the TypeScript and Python implementations give identical results on a shared JSON fixture suite.
- [ ] `T1.14` **Server-side health check endpoint** (orphans, dangling, duplicates, missing properties) · BE · 1d · T1.13
- [ ] `T1.15` ★ **Frontend ontology uses the API** instead of `localStorage` · FE · 2d · T1.09, T1.13
  *Done when:* two browsers see each other's commits after refresh.

### Identity and audit
- [ ] `T1.16` ★ **Single sign-on login** (Keycloak in dev; any OIDC provider in production); users and orgs created on first login · BE · 3d · T1.12
- [ ] `T1.17` **Roles v0:** viewer, engineer, admin, enforced on every write endpoint · BE · 1.5d · T1.16
- [ ] `T1.18` **Audit log:** every write recorded with who, what, when and before/after; admin view in the UI · BE+FE · 2d · T1.16
- [ ] `T1.19` **ISA-95 data model document:** mapping Site/Area/Line/Cell/Equipment to Tiles node types; update `NODE_TYPES` · TL+PM · 1.5d

**Month 1 exit check:** two users on different machines share ontology history; all checks are green and required on `main`.

---

## Month 2: Real data in (Dec 2026)

### Edge agent
- [ ] `T2.01` ★ **Edge agent skeleton** (Python, single binary or container): config file, outbound-only HTTPS/MQTT-TLS to Tiles, heartbeat · BE · 3d · T1.11
- [ ] `T2.02` ★ **OPC UA connector:** browse and subscribe to nodes, map to signal IDs, certificate-based security · BE · 4d · T2.01
- [ ] `T2.03` **MQTT connector:** subscribe to topics, JSON/Sparkplug B payloads · BE · 2.5d · T2.01
- [ ] `T2.04` ★ **Store-and-forward buffer:** disk queue that survives network loss and backfills in order · BE · 2d · T2.01
  *Done when:* a 1-hour network cut loses no samples.
- [ ] `T2.05` **SQL connector** for MES and quality databases (polling, watermark column) · BE · 2d · T2.01

### Ingestion and storage
- [ ] `T2.06` ★ **Time-series ingest endpoint:** batched writes to TimescaleDB hypertables; compression and retention policies · BE · 3d · T1.12
  *Done when:* sustained 5k samples/s on dev hardware.
- [ ] `T2.07` ★ **CSV and historian bulk import** with column-mapping UI for backfill · BE+FE · 3d · T2.06
- [ ] `T2.08` **Signal catalogue:** tag, unit, sample rate, source, linked ontology node; browse and search UI · BE+FE · 2.5d · T2.06
- [ ] `T2.09` ★ **Data-quality checks:** gaps, stuck values, out-of-range values, unit mismatch; quality badge per signal · BE · 3d · T2.08
- [ ] `T2.10` **Data Explorer page:** plot any signals over a time range, with zoom and downsampling · FE · 3d · T2.06

### Ontology at scale
- [ ] `T2.11` ★ **Agentic ingestion v1:** suggests the ontology node for each unmapped tag, using names, units, PLC paths and similar tags; the suggestion queue becomes staged ops · ML+BE · 4d · T2.08, T1.13
  *Done when:* at least 70% of suggestions are accepted on the partner's tag list.
- [ ] `T2.12` **Change approval workflow:** a commit can require a reviewer; review page with the diff; approve or reject with comments · BE+FE · 3d · T1.13
- [ ] `T2.13` **Bulk ontology import/export** (JSON and CSV) · BE · 1.5d · T1.13
- [ ] `T2.14` **Canvas layout at scale:** zoom, pan, search, collapse by hierarchy; handles 2,000+ nodes · FE · 3d · T1.15

### Design partner
- [ ] `T2.15` ★ **Assessment checklist and interview guide:** data sources, target problem, baseline metrics · PM · 1d
- [ ] `T2.16` ★ **Run the partner assessment** (2–4 weeks): data-landscape map, top 2–3 value opportunities, one pilot problem chosen · PM+TL · 5d · T2.15
  *Done when:* an assessment report with a signed-off problem statement and baseline metrics.
- [ ] `T2.17` ★ **Data access agreement** and edge-agent install at the partner (or historian export) · TL+PM · 2d · T2.16, T2.04
  *Done when:* one month of partner data is stored and mapped.

**Month 2 exit check:** live or backfilled partner data is flowing, with quality badges and ontology mapping.

---

## Month 3: Operations analytics on real data (Jan 2027)

### Virtual sensor framework
- [ ] `T3.01` ★ **Model registry:** register a model in code (inputs, outputs, parameters, version); stored in the `models` table · ML+BE · 3d · T1.12
- [ ] `T3.02` ★ **Port the plunger-friction model** to the registry, with unit tests carried over from `physics.test.js` · ML · 2d · T3.01
- [ ] `T3.03` ★ **Model runner:** runs registered models on new data windows and writes derived signals back to TimescaleDB · BE · 3d · T3.01, T2.06
- [ ] `T3.04` ★ **Streaming detection job:** rolling robust baseline, how long a deviation must persist, cooldown; thresholds stored as config per signal · ML+BE · 3d · T3.03
- [ ] `T3.05` ★ **Backtest tool:** replay history to get recall, precision and warning-time distribution per threshold setting · ML · 3d · T3.04
  *Done when:* a report generated for the partner's target machine.
- [ ] `T3.06` **Tune on partner history** and document the chosen settings · ML+FDE · 3d · T3.05, T2.17

### Warning workflow
- [ ] `T3.07` ★ **Warnings data model and API:** raised, acknowledged, assigned, resolved, with outcome (true alarm, false alarm, unknown) · BE · 2d · T3.04
- [ ] `T3.08` ★ **Warnings inbox UI** with filters, detail view (run chart + payload), acknowledge and assign · FE · 3d · T3.07
- [ ] `T3.09` **Notifications** by email and Microsoft Teams webhook, with per-user preferences · BE · 2d · T3.07
- [ ] `T3.10` ★ **Event import:** downtime and scrap codes from MES (via T2.05); join to warnings; live precision and warning-time dashboard · BE+FE · 3d · T2.05, T3.07

### Quality analytics
- [ ] `T3.11` **Correlation finder v2:** server-side over real batch tables; choose the outcome, variables and split; Cohen's d plus confidence intervals · ML+BE · 3d · T2.06
- [ ] `T3.12` **Saved insights:** save a finding with its query, evidence chart and proposed actions; insights are reviewable and linkable · BE+FE · 2.5d · T3.11
- [ ] `T3.13` ◇ **Wear-check skill on real signals** (generalise the weld-power check) · ML · 2d · T3.03

### Pilot
- [ ] `T3.14` ★ **Pilot kickoff:** on-site engineer on site, success criteria signed, weekly review cadence set · FDE+PM · 2d · T2.16
- [ ] `T3.15` **Start the security review early:** share the architecture and data-flow diagram with partner IT/OT · TL · 1d · T2.17

**Month 3 exit check:** backtest shows ≥ 50% of targeted downtime events warned, with an accepted false-alarm rate.

---

## Month 4: Copilot and Design Studio (Feb 2027)

### AI copilot
- [ ] `T4.01` ★ **Copilot service:** Claude API with tool use; streaming responses; conversation storage per user · BE · 3d · T1.16
- [ ] `T4.02` ★ **Turn the existing skills into tools:** graph query, correlation, virtual-sensor status, wear check, health check, time-series query, event lookup · BE · 4d · T4.01, T3.11, T3.03
- [ ] `T4.03` ★ **Grounding rules:** answers may only state facts from tool results; cite tool and inputs; decline when nothing supports an answer · BE · 2d · T4.02
- [ ] `T4.04` **Copilot UI v2:** streaming, expandable tool traces, links to evidence, feedback on each answer · FE · 3d · T4.01
- [ ] `T4.05` ★ **Evaluation set:** 100+ real partner questions with expected answers and the tools they should use · PM+FDE · 3d · T3.14
- [ ] `T4.06` ★ **Evaluation harness in the automated checks:** scores accuracy, grounding and tool choice; fails under the thresholds · BE · 3d · T4.05, T4.03
  *Done when:* ≥ 85% correct and 0 unsupported claims on the evaluation set.
- [ ] `T4.07` **Cost and latency controls:** prompt caching, token budgets, per-org rate limits, usage dashboard · BE · 2d · T4.01
- [ ] `T4.08` ◇ **Document search:** upload SOPs and manuals, chunk and embed them, cite with page numbers · BE · 4d · T4.02
- [ ] `T4.09` ◇ **Copilot can stage ontology changes**, which always need human approval through T2.12 · BE · 2d · T4.02, T2.12

### Design Studio backend
- [ ] `T4.10` ★ **Shared model registry for Design:** swelling and actuator models ported; versions immutable once published · ML · 3d · T3.01
- [ ] `T4.11` **Runs API:** store runs with parent, version, parameters, output and author; restore; compare · BE · 2d · T4.10
- [ ] `T4.12` **Sweeps as background jobs:** progress UI and cancel; results cached · BE+FE · 3d · T4.10
- [ ] `T4.13` **Audit export:** PDF report plus JSON with the full lineage chain · BE · 2d · T4.11
- [ ] `T4.14` **Design Studio UI uses the API**, with shared projects for team collaboration · FE · 3d · T4.11
- [ ] `T4.15` ◇ **Register a model from GitHub or an HTTP endpoint,** run in a sandbox · BE · 4d · T4.10

**Month 4 exit check:** copilot evaluation gate is green; a design result traces to model version, parameters and author.

---

## Month 5: Pilot in production and enterprise hardening (Mar 2027)

### Live pilot
- [ ] `T5.01` ★ **Go live:** real-time warnings on the pilot line; shift-lead sign-off on the warning workflow · FDE · 2d · T3.08, T3.06
- [ ] `T5.02` ★ **Weekly tuning reviews:** review outcomes and adjust thresholds through config, with a change log · FDE+ML · 4 × 0.5d · T5.01
- [ ] `T5.03` **Populate the pilot knowledge base:** SOPs, lessons learned, equipment history · FDE · 2d · T4.08

### Security
- [ ] `T5.04` ★ **Site-level permissions** with row-level security in Postgres · BE · 3d · T1.17
- [ ] `T5.05` **Single sign-on with the customer's identity provider** (Azure AD / Entra) and SCIM user provisioning ◇ · BE · 2d · T1.16
- [ ] `T5.06` ★ **Encryption at rest, secrets manager, key rotation runbook** · BE · 2d
- [ ] `T5.07` ★ **Threat model** (STRIDE) and IEC 62443 gap list for the edge agent and cloud · TL · 2d · T3.15
- [ ] `T5.08` **Dependency and container scanning in the automated checks**; SBOM generation · TL · 1d · T1.02

### Deployment
- [ ] `T5.09` ★ **Helm charts** for API, workers, frontend and database (or managed database) · BE · 3d · T1.11
- [ ] `T5.10` **Terraform modules** for the managed cloud and a customer-hosted reference install · BE · 3d · T5.09
- [ ] `T5.11` **Hybrid mode:** edge agent on site plus Tiles cloud; documented firewall rules (outbound only) · BE · 2d · T2.04, T5.10
- [ ] `T5.12` **Customer-hosted install guide** and a dry run on a clean cluster · BE+TL · 2d · T5.10

### Operations
- [ ] `T5.13` **Monitoring:** OpenTelemetry traces, metrics and dashboards; alerts for ingest lag and job failures · BE · 3d
- [ ] `T5.14` ★ **Backups and a restore drill** (point-in-time recovery for Postgres) · BE · 1.5d
  *Done when:* restoring into a fresh environment is documented and timed.
- [ ] `T5.15` ★ **Load test:** 10k signals at 1 Hz, 50 concurrent users; fix bottlenecks · BE · 3d · T2.06
  *Done when:* p95 API latency < 500 ms and ingest lag < 10 s under load.

### UX
- [ ] `T5.16` **Shopfloor view:** tablet layout, large type, warnings-first, works with gloves (big touch targets) · FE+PM · 3d · T3.08
- [ ] `T5.17` **Site → line → machine navigator** built from the ontology hierarchy · FE · 2d · T1.15
- [ ] `T5.18` **Accessibility pass:** keyboard navigation, contrast, screen-reader labels on charts · FE · 2d

**Month 5 exit check:** 4+ weeks of live warnings with outcomes logged; security review passed or has a clear remaining list.

---

## Month 6: Prove value and ship v1.0 (Apr 2027)

### Value
- [ ] `T6.01` ★ **ROI report:** downtime avoided, scrap reduced, warning time and false-alarm rate against the month-2 baseline, with each number reproducible from the data · PM+ML · 3d · T5.02
- [ ] `T6.02` ★ **Partner sign-off meeting** and a production-deployment quote · PM+TL · 1d · T6.01
- [ ] `T6.03` **Case study write-up** (anonymised if needed) · PM · 1.5d · T6.02

### Release
- [ ] `T6.04` ★ **Versioning and release process:** semantic versions, changelog, release notes, migration testing between versions · TL · 2d
- [ ] `T6.05` ★ **Documentation:** admin guide, user guide, model-author guide, API reference · PM+TL · 4d
- [ ] `T6.06` **New-site onboarding flow:** a wizard from site creation → edge agent → tag mapping → first dashboard · FE+BE · 4d · T2.11
  *Done when:* onboarding a new machine takes under 1 day.
- [ ] `T6.07` ★ **External penetration test** and remediation of all high and critical findings · TL · 3d (+ vendor time) · T5.07
- [ ] `T6.08` **SOC 2 / ISO 27001 readiness plan:** list of controls, owners, timeline · TL · 2d · T5.07
- [ ] `T6.09` ★ **Tag v1.0** and deploy it to the pilot environment · TL · 1d · T6.04–T6.07
- [ ] `T6.10` ◇ **App Studio v0:** templates (e.g. wear check, SPC limit) configurable without core code changes · BE+FE · 6d · T3.13

### Plan ahead
- [ ] `T6.11` **Retrospective** and roadmap for the next 6 months: second line or site, cross-site benchmarking, new physics models · PM+TL · 1d · T6.09

**Month 6 exit check:** v1.0 tagged, ROI report signed off, production deployment quoted.

---

## Ongoing (every month)

- [ ] `T0.01` **Monthly metrics review:** warning recall, precision and warning time; copilot accuracy; data freshness; weekly active users; ontology health; onboarding time · PM
- [ ] `T0.02` **Risk review:** update the risk table in ROADMAP.md; cut ◇ items if the critical path slips · TL
- [ ] `T0.03` **Keep tests green:** no skipped tests; each bug fix ships with a regression test · All

## Critical path

T1.01 → T1.10 → T1.12 → T1.13 → T2.01 → T2.04 → T2.06 → T2.17 → T3.01 → T3.03 → T3.04 → T3.05 → T3.06 → T5.01 → T5.02 → T6.01 → T6.02

A slip on any of these moves the pilot date. Watch T2.17 (partner data access) most closely.
