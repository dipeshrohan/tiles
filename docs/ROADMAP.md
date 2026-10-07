# Tiles: 6-month roadmap

**Window:** 2 Nov 2026 – 30 Apr 2027 · **Task breakdown:** [TASKS.md](TASKS.md)

## Where Tiles is today

Tiles is a working front-end demo with five modules: Copilot, Ontology, Process & Quality, Factory Physics and Design Studio. It has 19 unit tests. It has no backend, no real data connections and no login. All plant data is synthetic and stored in the browser, and the copilot is rule-based.

## Six-month goal

Tiles v1.0 running on one real production line at a design-partner plant. It connects to live machine data, sends downtime warnings that people act on, and shows a measured return on investment (ROI) that justifies a paid contract.

## Assumptions

- **Team of about 6:**
  - Tech lead (TL)
  - 2 backend or data engineers (BE)
  - Frontend engineer (FE)
  - Physics/machine-learning engineer (ML)
  - Engineer working on site at the customer, from month 3 (FDE)
  - Part-time design and product help (PM)
- **With fewer people,** stretch each month to about six weeks, or cut the stretch items marked ◇.
- **Design partner:** a plant willing to pilot is lined up by the end of month 2.

## Target architecture

| Layer | Choice | Why |
|---|---|---|
| Frontend | TypeScript + Vite; port the existing `js/lib` modules as they are | Keeps the tested logic and adds type safety |
| API & analytics | Python (FastAPI) | Physics and data science tooling lives in Python |
| Storage | PostgreSQL + TimescaleDB for time series; ontology stored as tables in Postgres | One database to run; add a graph database only if queries demand it |
| Jobs | Task queue backed by Redis | Sweeps, detection and ingestion stay out of the API |
| Data connectors | Edge agent on site (OPC UA, MQTT, SQL) that only sends data outward | Plant IT approves outbound-only connections; no inbound ports |
| Login | Single sign-on (OIDC); organisation → site → role permissions | Enterprise requirement from day one |
| AI | Claude API with tool use, wrapping the existing copilot skills | Answers stay grounded in tool output |
| Hosting | One managed cloud first; customer-hosted (BYOC) from month 5 | Covers cloud, customer-hosted and hybrid installs with one codebase |

## Monthly plan

### Month 1: Foundations
**Goal:** turn the demo into a real product codebase without losing anything that works.
- Merge PR #1. Set up automated checks on GitHub (lint, type checks, tests, browser smoke test).
- Migrate to TypeScript + Vite, porting `js/lib/*` with its tests.
- Set up FastAPI, Postgres/TimescaleDB, the database schema and Docker Compose.
- Move ontology change tracking (stage, commit, revert, health check) to the server.
- Add single sign-on and an audit log.
- Write up the ISA-95-aligned data model.

**Done when:** two users on different machines see the same ontology history, and checks run on every PR.

### Month 2: Real data in
**Goal:** replace the synthetic generators with live and historical plant data.
- **Edge agent v0:** OPC UA and MQTT, buffering while offline, outbound-only TLS.
- **Historical data:** CSV and historian bulk import for backfill.
- **Data quality:** a signal catalogue (tag → unit → sample rate) and checks for gaps, stuck values and unit mismatches.
- **Agentic ingestion v1:** suggests which ontology node each raw tag belongs to; an engineer approves or rejects each suggestion.
- **Change approvals:** a reviewer approves ontology changes, which are shown as diffs.
- **Design partner:** run the assessment and pick the one problem to prove.

**Done when:** one month of real data from the partner's target machine is stored and mapped in the ontology.

### Month 3: Operations analytics on real data
**Goal:** the Factory Physics and Quality modules work on the partner's data.
- **Virtual sensor framework:** a model registry, with plunger friction as the first registered model.
- **Detection:** streaming detection job, tuned on the partner's history.
- **Warning workflow:** raise, acknowledge, assign, record the outcome, and notify by email or Teams.
- **Events:** import downtime and scrap events from the production-tracking system (MES) and measure warning precision and warning time automatically.
- **Correlation finder v2** on real batch tables, with saved insights.
- **Pilot kickoff:** the on-site engineer starts at the plant.

**Done when:** on backtested partner data, warnings catch at least 50% of the targeted downtime events, with a false-alarm rate the shift lead accepts.

### Month 4: Copilot and Design Studio
**Goal:** make the AI layer real and give R&D users a backend.
- **AI copilot:** Claude API with tool use; every answer cites the tools behind it, and the copilot declines when no tool supports an answer.
- **Copilot evaluation:** 100+ partner questions; the automated checks fail if accuracy or grounding drops.
- ◇ **Document search** over SOPs and manuals, with page citations.
- **Design Studio backend:** model registry, sweeps as background jobs, runs stored server-side with lineage, PDF and JSON audit export.
- ◇ Register models from GitHub or an HTTP endpoint.

**Done when:** copilot evaluation is ≥ 85% correct with 0 unsupported claims, and a design run can be traced end to end.

### Month 5: Pilot in production and enterprise hardening
**Goal:** the pilot runs live, and the product passes an enterprise IT review.
- **Live pilot:** live warnings with weekly tuning reviews.
- **Security:** role-based permissions per site, single sign-on with the customer's identity provider, encryption at rest, secrets management, threat model, IEC 62443 gap list.
- **Deployment:** customer-hosted install (Helm + Terraform) and hybrid edge mode.
- **Operations:** monitoring, backups and restore drills, load test (10k signals at 1 Hz).
- **UX:** shopfloor tablet views and a site → line → machine navigator.

**Done when:** the pilot has 4+ weeks of live warnings with outcomes logged, and the security review is passed or has a clear list of remaining items.

### Month 6: Prove value, ship v1.0
**Goal:** turn the pilot into evidence and a releasable product.
- **ROI report:** downtime hours avoided, scrap reduced, warning time and false-alarm rate, compared with the month-2 baseline.
- **v1.0 release:** versioned releases and upgrade path, documentation, onboarding for a new site.
- **Security:** penetration test and fixes; SOC 2 / ISO 27001 readiness plan.
- ◇ **App Studio** templates for configuring new use cases without core code changes.
- **Next six months:** plan the second line or site.

**Done when:** v1.0 is tagged, the partner signs off on the ROI report, and a production deployment is quoted.

## Milestones

| End of | Milestone |
|---|---|
| Month 1 | Shared backend, single sign-on, server-side ontology history, automated checks |
| Month 2 | Live partner data ingested and mapped |
| Month 3 | Warnings validated on real history; pilot started |
| Month 4 | Grounded AI copilot with an evaluation suite; Design Studio backend |
| Month 5 | Live pilot; enterprise security and customer-hosted install |
| Month 6 | ROI proven; v1.0 shipped |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| No design partner, or slow data access (biggest risk) | Secure the partner before month 2. Plan for CSV/historian backfill if live access is late. Keep developing against public datasets (NASA turbofan, SECOM) in the meantime |
| Warnings don't transfer to real machines | Backtest before going live; treat thresholds as configuration, not code; track precision and warning time on a dashboard from day one |
| Copilot inventing answers | Tool-only answers, an evaluation gate in the automated checks, visible step traces |
| Too much scope | Cut ◇ items first. Never cut data quality checks, the evaluation suite or the audit log |
| Plant IT/OT security approval | Outbound-only edge agent, security review started in month 3, customer-hosted option |

## Metrics to track monthly

- **Warnings:** recall, precision and median warning time.
- **Copilot:** evaluation accuracy and unsupported-claim rate.
- **Data freshness:** time from sensor to dashboard.
- **Adoption:** weekly active users on the pilot line.
- **Ontology:** health score.
- **Onboarding:** time to bring a new machine online (target: under 1 day by month 6).
