# SOC 2 and ISO 27001 readiness plan (T6.08)

The plan to reach a SOC 2 Type I report, then Type II, and ISO/IEC 27001:2022 certification, for Tiles' managed cloud and the company that builds it. It lists one set of controls, mapped to both frameworks: each control has an owner, and is either done (with its evidence), partly done or a gap. A timeline follows to close the gaps and pass the audits.

Customers who host Tiles themselves ([install guide](../install.md)) run it under their own controls. For them, this plan's product controls (access, audit, encryption, secure development) are what Tiles brings. The operations controls are theirs.

## Scope

- **SOC 2:** the Trust Services Criteria for **Security** (the common criteria, CC), **Availability** (A) and **Confidentiality** (C). Processing Integrity and Privacy can wait: the copilot's handling of data is covered under Confidentiality and vendor management.
- **ISO 27001:2022:** an information security management system (ISMS) for the people, code, cloud and operations behind Tiles' managed cloud. Its Statement of Applicability (SoA) is drawn from the control list below. Physical controls (Annex A.7) are inherited from the cloud provider; Tiles has no data centre.
- **Systems:**
  - the Tiles application (browser app, API, jobs, edge agent);
  - this repository and its CI;
  - the Azure subscriptions running the managed cloud ([Terraform](../../deploy/terraform/README.md));
  - the identity provider and staff tools (GitHub, email, laptops).

## Owners

Controls are owned by roles, so they survive changes of people. Until a security lead is hired, the tech lead holds that role.

| Role | Holds |
|---|---|
| **CEO** | Policies' approval, management review, vendors and contracts, customer commitments |
| **Security lead** (the tech lead, for now) | The ISMS: risk register, SoA, internal audit, incident response, the auditors' point of contact |
| **Tech lead** | Secure development, change management, vulnerability management, product security |
| **Operations** (whoever runs production; the tech lead until there is an SRE) | Infrastructure, access to production, monitoring, backups, capacity |
| **People** (a founder until there is HR) | Hiring checks, agreements, training, joiners and leavers |
| **Product manager** | Customer-facing security material, data handling statements, the copilot's data use |

## Controls

Status: **Done** (evidence exists and is kept), **Partial** (part of it exists; the rest is the action), **Gap** (to do).

The references are SOC 2's criteria (CC, A, C) and the ISO 27001:2022 clauses and Annex A controls (A.x).

### Governance and risk

| ID | Control | SOC 2 | ISO 27001 | Owner | Status | Evidence, or the action |
|---|---|---|---|---|---|---|
| GOV-1 | An information security policy, and the policies under it, approved and reviewed yearly | CC1.1, CC2.1, CC5.3 | 5.2, A.5.1 | CEO | Gap | Write the policy set: security, acceptable use, access, change, incident response, business continuity, vendor, data classification and retention, cryptography, secure development. Publish it to staff, and collect acknowledgements |
| GOV-2 | Roles and responsibilities for security, with a named security lead | CC1.3 | 5.3, A.5.2 | CEO | Gap | Name the owners in the table above, in the policy |
| GOV-3 | A risk assessment, with treatment, yearly and on major change | CC3.1–CC3.4 | 6.1.2, 6.1.3, 8.2, 8.3 | Security lead | Partial | Inputs: the [threat model](threat-model.md) (STRIDE, IEC 62443 gap list) and the [roadmap's risks](../ROADMAP.md#risks-and-mitigations). Action: a risk register with likelihood, impact, owner and treatment |
| GOV-4 | A Statement of Applicability | — | 6.1.3 d | Security lead | Gap | From this control list: each Annex A control, applicable or not and why |
| GOV-5 | Internal audit and management review, yearly | CC4.1, CC4.2 | 9.2, 9.3 | Security lead, CEO | Gap | An internal audit before certification (another company's security lead, or a consultant), and a management review with minutes |

### People

| ID | Control | SOC 2 | ISO 27001 | Owner | Status | Evidence, or the action |
|---|---|---|---|---|---|---|
| HR-1 | Background checks where the law allows, and a confidentiality agreement before access | CC1.4 | A.6.1, A.6.2, A.6.6 | People | Gap | A hiring checklist; the signed agreements kept |
| HR-2 | Security training at hiring and yearly, phishing awareness included | CC1.4, CC2.2 | A.6.3 | People | Gap | A short course and a record of who took it |
| HR-3 | Leavers lose access the same day | CC6.2, CC6.3 | A.5.18, A.6.5 | People, Operations | Gap | An offboarding checklist covering the identity provider, GitHub, Azure and devices, signed off per leaver. Most access goes through single sign-on, so one switch does most of it |

### Access

| ID | Control | SOC 2 | ISO 27001 | Owner | Status | Evidence, or the action |
|---|---|---|---|---|---|---|
| AC-1 | Single sign-on with multi-factor authentication for every staff tool | CC6.1 | A.5.17, A.8.5 | Operations | Partial | The managed cloud's clusters take Entra ID sign-in only, with no local accounts (`modules/azure`). Action: enforce MFA in the GitHub organisation and the identity provider, and record the settings |
| AC-2 | Least privilege, and access reviewed every quarter | CC6.2, CC6.3 | A.5.15, A.5.18, A.8.2 | Operations | Gap | A quarterly review of GitHub, Azure role assignments and cluster admins, with sign-off. Production database access is break-glass only, and logged |
| AC-3 | The product's own access control: roles per endpoint, each site's data kept apart | CC6.1, CC6.3 | A.5.15, A.8.3 | Tech lead | Done | Roles per endpoint, listed in the [API reference](../guides/api.md). Row security per site, tested by `api/tests/test_row_security.py`. The [admin guide](../guides/admin.md#roles) describes both |
| AC-4 | Customers' users provisioned and removed from their directory | CC6.2 | A.5.16 | Tech lead | Partial | Users are created at first sign-in, with roles from the token. Action: SCIM deprovisioning (T5.05) |
| AC-5 | Machine credentials: per-agent tokens, stored hashed, revocable | CC6.1, CC6.6 | A.5.17, A.8.5 | Tech lead | Partial | Edge agent tokens (`api_agents.py`, shown once, hashed). Action: expiry and rotation from the UI (G-E1 in the threat model) |

### Building and changing Tiles

| ID | Control | SOC 2 | ISO 27001 | Owner | Status | Evidence, or the action |
|---|---|---|---|---|---|---|
| CM-1 | Every change reviewed and tested before it reaches production | CC8.1 | A.8.32, A.8.25 | Tech lead | Partial | Pull requests with CI gates: lint, types, unit, API and browser tests, accessibility, scans, chart and Terraform checks, restore and install dry runs. Action: **turn on branch protection for `main`** (required reviews and checks, no direct pushes: #15), and keep the settings as evidence |
| CM-2 | Secure development: tests with every change, threat modelling when a trust boundary moves | CC8.1 | A.8.25–A.8.28 | Tech lead | Done | The repository's rules (`CLAUDE.md`, [contributing](../../CONTRIBUTING.md)) and the [threat model](threat-model.md), reviewed before each release |
| CM-3 | Releases versioned, with notes, tested upgrades and a rollback procedure | CC8.1 | A.8.32 | Tech lead | Done | [Releasing](../releasing.md), the upgrade test in CI, the [changelog](../../CHANGELOG.md) |
| CM-4 | Infrastructure as code, with secure defaults checked in CI | CC7.1, CC8.1 | A.8.9 | Operations | Done | The [Helm chart](../../deploy/helm/tiles/README.md) and [Terraform](../../deploy/terraform/README.md). The restricted Pod Security Standard is enforced, and `trivy config` and `terraform test` run in CI |
| CM-5 | Production changes go through the pipeline, not by hand | CC8.1 | A.8.32 | Operations | Partial | Terraform applies from a pipeline whose identity has the rights; people have read access day to day. Action: a pipeline for the managed environments, and break-glass access for the rest |

### Vulnerabilities and the supply chain

| ID | Control | SOC 2 | ISO 27001 | Owner | Status | Evidence, or the action |
|---|---|---|---|---|---|---|
| VM-1 | Dependencies and images scanned; findings fixed within set times | CC7.1 | A.8.8 | Tech lead | Partial | Trivy on every image and Dependabot (T5.08), failing on high and critical findings that have a fix. Action: write the deadlines (critical 7 days, high 30 days), triage the open Dependabot pull requests, and keep a record |
| VM-2 | A penetration test yearly, and before certification; its high and critical findings fixed | CC4.1, CC7.1 | A.8.8 | Security lead | Gap | T6.07 |
| VM-3 | Software bills of materials, and signed images verified at install | CC7.1, CC8.1 | A.5.21, A.8.30 | Tech lead | Partial | CycloneDX SBOMs for the images and the source (T5.08). Action: sign images and releases with cosign, and verify at install (G-E4, G-S2) |

### Data protection

| ID | Control | SOC 2 | ISO 27001 | Owner | Status | Evidence, or the action |
|---|---|---|---|---|---|---|
| CR-1 | Encryption in transit | CC6.7 | A.8.24 | Operations | Partial | TLS for browsers and edge agents; edge agents verify certificates and refuse plain http beyond localhost. Action: enforce `sslmode=verify-full` to a remote database (SR 3.1 in the threat model) |
| CR-2 | Encryption at rest, and keys managed | CC6.1, CC6.7 | A.8.24 | Tech lead | Done | Credentials are sealed with rotatable data keys ([runbook](../runbooks/secrets-and-encryption.md), T5.06). Disks and backup storage are encrypted by the cloud. Backups take no account keys (`modules/azure`) |
| DP-1 | Data classified; retention and deletion defined | C1.1, C1.2 | A.5.12, A.5.33, A.8.10 | Tech lead | Partial | Readings are kept 5 years (migration 0004) and backups 35 days ([backups](../runbooks/backups.md)). Action: a classification (customer plant data is confidential), and a procedure to delete a customer's sites and backups when they leave, with a record |
| DP-2 | What the copilot sends to its model provider is stated, and each site opts in | C1.1, CC9.2 | A.5.34, A.8.11 | Product manager | Gap | Today the copilot is off until it is configured for the whole installation. Action: per-site opt-in and a statement of what is sent (G-A4); the provider's terms on retention and training kept with the vendor records |

### Operations

| ID | Control | SOC 2 | ISO 27001 | Owner | Status | Evidence, or the action |
|---|---|---|---|---|---|---|
| LM-1 | An audit trail of changes, and request logs | CC7.2 | A.8.15 | Tech lead | Done | The append-only audit log, read on the Settings page (ADR 004), and JSON request logs with request ids |
| LM-2 | Monitoring and alerting, with someone on call | CC7.2, A1.2 | A.8.16 | Operations | Partial | OpenTelemetry metrics and traces, with tested alert rules (T5.13, [monitoring](../../deploy/monitoring/README.md)). Action: an on-call rota and paging for critical alerts |
| IR-1 | An incident response plan, tested yearly, and post-mortems | CC7.3–CC7.5 | A.5.24–A.5.28 | Security lead | Gap | A plan: severity levels, roles, communication, evidence preservation and post-mortems. A tabletop exercise before the Type I audit |
| IR-2 | Customers told of a breach of their data within the time their contract sets | CC2.3, CC7.4 | A.5.24, A.5.26 | CEO | Gap | Contract wording (72 hours is common) and the plan's customer-notification step |
| BC-1 | Backups, and restores proven | A1.2, A1.3 | A.8.13 | Operations | Partial | Point-in-time recovery, with a restore drill in CI (T5.14, [backups](../runbooks/backups.md)). Action: production backups running, with a monthly restore drill recorded |
| BC-2 | A continuity and recovery plan with stated recovery time and recovery point | A1.2, A1.3, CC9.1 | A.5.29, A.5.30 | Security lead | Partial | Recovery point: minutes, from point-in-time recovery; backups are geo-redundant. Action: recovery-time targets, and a regional recovery procedure tested once |
| BC-3 | Capacity planned | A1.1 | A.8.6 | Operations | Done | [The load test](../load-test.md) (T5.15) and the autoscaling workload pool |
| NET-1 | Networks segmented, the plant reached outbound only | CC6.6 | A.8.20–A.8.22 | Operations | Partial | NetworkPolicies, API servers limited to named ranges, an outbound-only edge agent as a sandboxed service, and the firewall rules on both sides ([hybrid mode](../hybrid.md)). Action: turn on the egress allowlist in the managed cloud (Cilium's DNS proxy: AKS's Advanced Container Networking Services) |
| AS-1 | An inventory of assets: systems, accounts, repositories, devices | CC6.1 | A.5.9 | Operations | Gap | Generated where possible (the Azure resource graph, GitHub), with the rest listed by hand. Reviewed quarterly with AC-2 |
| EP-1 | Staff devices managed: disk encryption, screen lock, updates, malware protection | CC6.8 | A.8.1, A.8.7 | Operations | Gap | Device management for laptops, and a report of compliance |
| PH-1 | Physical security of the systems | CC6.4 | A.7 | — | Inherited | The cloud provider's SOC 2 and ISO 27001 reports, kept with the vendor records. There are no offices with systems in scope |

### Vendors and customers

| ID | Control | SOC 2 | ISO 27001 | Owner | Status | Evidence, or the action |
|---|---|---|---|---|---|---|
| VD-1 | Vendors that touch customer data reviewed, with agreements | CC9.2 | A.5.19–A.5.23 | CEO | Gap | A list of subprocessors: the cloud provider, GitHub, the copilot's model provider and the mail service. For each: its SOC 2 or ISO report, a data processing agreement, and a yearly review |
| COM-1 | Customers can see how Tiles is secured, and report a problem | CC2.3 | A.5.14, A.5.24 | Product manager | Partial | The [threat model](threat-model.md), the [install guide](../install.md) and the admin guide describe it. Action: a security overview for customers, a `security.txt` and a contact for vulnerability reports, and a status page |

## Timeline

Weeks count from the start of this plan (month 6 of the roadmap).

| When | What | Done when |
|---|---|---|
| **Weeks 1–2** | Name the owners (GOV-2). Choose how evidence is collected: a compliance platform, or a tracked spreadsheet and this repository. Write and approve the policy set (GOV-1). Draft the risk register (GOV-3). Fix the scope with the auditor's input | Policies approved; risk register drafted |
| **Weeks 3–6** | Close the technical gaps:<br>• branch protection on `main` (CM-1)<br>• MFA enforced (AC-1)<br>• the first access review (AC-2)<br>• the offboarding checklist (HR-3)<br>• deadlines for vulnerabilities, and triage of the open Dependabot pull requests (VM-1)<br>• the asset inventory (AS-1)<br>• device management (EP-1)<br>• vendor records (VD-1)<br>• per-site copilot opt-in (DP-2) | Each control has its evidence |
| **Weeks 5–8** | The incident response plan, and a tabletop exercise (IR-1, IR-2). The continuity plan with its targets (BC-2), and a recorded production restore (BC-1). Training for everyone (HR-2). The penetration test (VM-2, T6.07), with its high and critical findings fixed | The exercise and the restore recorded; the pen test report and its fixes |
| **Weeks 9–10** | A readiness assessment by the audit firm. The internal audit (GOV-5) and the Statement of Applicability (GOV-4). The first management review | No open findings that would qualify the report |
| **Week 12** | **SOC 2 Type I** audit (the controls' design, at a point in time) | Type I report |
| **Months 4–9** | **SOC 2 Type II** observation window: at least 3 months, usually 6, with the controls running and their evidence kept. **ISO 27001** Stage 1 (documentation, around month 4) and Stage 2 (certification audit, around month 6) | Type II report; ISO 27001 certificate |
| **Every year** | Policies, risks, access (every quarter), vendors and training reviewed; a penetration test; a continuity test; a SOC 2 Type II renewal and ISO surveillance audits | — |

## Evidence

Much of the evidence is produced already, on every change, and kept with each CI run:

- **Change management (CM-1 to CM-4):** pull requests with reviews and checks.
- **Releases (CM-3):** the release workflow, the changelog and tagged releases.
- **Vulnerability management (VM-1, VM-3):** the scan results and SBOMs from the CI job "Dependency and container scanning".
- **Backups (BC-1):** the restore drill's report.
- **Product access control (AC-3):** the row-security and role tests.
- **Infrastructure (CM-4):** the Terraform tests and `trivy config`, and the install dry run.
- **The audit trail (LM-1):** the audit log, exported by an admin.

What remains is kept by its owner, in the evidence store chosen in weeks 1–2: access reviews, training records, vendor reports, the incident exercise, management review minutes and production restore records. Review this plan with the risk register, and when the [threat model](threat-model.md) changes.
