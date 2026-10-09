# Changelog

Every release of Tiles, newest first, in the format of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Tiles uses [semantic versioning](https://semver.org/spec/v2.0.0.html); [releasing](docs/releasing.md) says what counts as a breaking change and how a release is made.

The top section is the next version, marked **Unreleased** until it is released. Each pull request adds its user-visible change there; the release replaces **Unreleased** with the date.

## [0.1.0] - Unreleased

The first version: everything up to the pilot. Not yet tagged.

### Added

- **Factory model:**
  - an ontology mapped to ISA-95, with Git-style staged changes, commits, history and diffs;
  - change reviews;
  - bulk import and export;
  - a canvas that scales to thousands of nodes.
- **Plant data:**
  - **edge agent:** OPC UA, MQTT with Sparkplug B, and SQL sources; a disk buffer; read-only toward the plant;
  - CSV imports;
  - a signal catalogue with data-quality checks;
  - a data explorer;
  - suggested tag mappings.
- **Models and warnings:**
  - a model registry and a model runner that writes derived signals;
  - streaming detectors, with backtests;
  - a warnings inbox with acknowledgement, assignment and outcomes;
  - a shopfloor view for tablets on the line: warnings first on their machines, large type, buttons big enough for gloves, a board of every machine, and a full view without the menu (T5.16);
  - a plant navigator from the site to its lines and machines, built from the ontology's hierarchy, with open warnings on every place and a page per machine: its signals with their latest readings, controllers, processes, models, documents and neighbours (T5.17);
  - e-mail and Teams notifications;
  - warning performance against downtime and scrap events.
- **Analysis:**
  - a correlation finder over batch tables;
  - saved insights with evidence and proposed actions;
  - a wear check with time to a limit.
- **Design studio:** physics-based design models, runs with lineage and audit export (PDF), and parameter sweeps.
- **Copilot:**
  - Claude with read-only tools over the site's data;
  - grounded answers;
  - proposals for ontology changes, which go through review;
  - cost controls per question, organisation and day.
- **Platform:**
  - **accessibility (WCAG 2.1 AA):** every page tested with axe in light and dark; text contrast raised to 4.5:1; charts described to screen readers, with their numbers; a skip link, the current page marked in the menu, underlined links in text, and less motion when asked (T5.18);
  - single sign-on (OIDC) with site roles;
  - **an organisation's own sign-in** (Microsoft Entra ID or any OpenID Connect provider), which can be enforced, with its groups and app roles mapped to roles, and **SCIM 2.0 user provisioning** that creates, deactivates and deletes people (`docs/guides/entra-id.md`, T5.05);
  - row security per site in the database;
  - credentials sealed with rotatable data keys;
  - an audit log;
  - dependency and image scanning with SBOMs;
  - a threat model, and a SOC 2 and ISO 27001 readiness plan: controls mapped to both, with owners, status, evidence and a timeline (T6.08);
  - a Helm chart;
  - **customer-hosted install guide** (`docs/install.md`): prerequisites, sign-in, mirrored images, settings, install, checks, backups, upgrades and troubleshooting, followed on a new cluster by CI's install dry run (T5.12);
  - **Terraform modules:** Tiles on any cluster, and the managed cloud on Azure (AKS with Entra ID sign-in, enforced network policies, backup storage), with a customer-hosted reference install; tested with mock providers and `trivy config` in CI (T5.10);
  - backups with a point-in-time restore drill;
  - a load test (10,000 readings a second, 50 users);
  - **monitoring:** OpenTelemetry traces and metrics (ingest lag from the agents' buffers, job runs, notifications, requests), alert rules tested with promtool, a Grafana dashboard and a collector configuration (T5.13);
  - **guides:** a user guide, an administrator guide, a model-author guide and an API reference generated from the code, with a test that keeps it current (T6.05);
  - **setting up a site:** organisation admins create sites (`POST /sites`), and a wizard takes each from new to its first dashboard (outline the plant, connect an edge agent, map tags), with its progress worked out from the site's data (`GET /sites/{id}/onboarding`) (T6.06);
  - **release process:** one version across the browser app, the API, the edge agent and the Helm chart; this changelog; release notes and assets made from a version tag; an upgrade test that migrates the previous version's database, with its data, to the new one and back (T6.04).

[0.1.0]: https://github.com/dipeshrohan/tiles/releases/tag/v0.1.0
